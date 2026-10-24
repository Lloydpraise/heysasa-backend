import { Router } from 'express'
import { supabase } from '../supabaseClient.js'
import { normalizeWhatsappConnectionRequest } from './whatsappConnectionRequest.js'
import { forAccount } from './authMiddleware.js'
import { EVOLUTION_WEBHOOK_URL } from '../config.js'
import {
  connectEvolutionInstance,
  createEvolutionInstance,
  deleteEvolutionInstance,
  evolutionRequest,
  getConnection,
  getEvolutionConnectionState,
  saveConnectionState,
} from '../../../src/services/evolutionConnections.js'

export const whatsappRouter = Router()

// Each WhatsApp connection belongs to one HeySasa account (one number, see ACCOUNTS.md). These endpoints act on the
// selected account's connection only. A business with no account yet (it never connected) keeps the old flow; its
// first connection opens its first account (database trigger whatsapp_sessions_ensure_account).

whatsappRouter.get('/whatsapp/instances', async (req, res) => {
  const { data: sessions, error } = await forAccount(supabase
    .from('whatsapp_sessions')
    .select('id, account_id, instance_name, status, phone_number, updated_at')
    .eq('business_id', req.businessId), req.scope)
    .eq('status', 'connected')
    .order('updated_at', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })

  // whatsapp_sessions is the source of truth — every row here already
  // matched status='connected' above, no extra live ping needed.
  const instances = (sessions ?? []).map(session => ({ ...session, connected: true }))
  res.json({ instances })
})

const hasAccounts = (req) => (req.scope?.accountIds?.length ?? 0) > 0

// Which account this request acts on. Returns { accountId } (null = business without accounts), or sends
// 400 account_required and returns null.
function targetAccount(req, res) {
  const accountId = req.scope?.accountId ?? null
  if (!accountId && hasAccounts(req)) {
    res.status(400).json({ error: 'account_required' })
    return null
  }
  return { accountId }
}

function shape(row) {
  if (!row) return null
  return {
    ...row,
    evolution_instance_id: row.instance_name,
    qr_code: row.session_data?.qr_code || null,
    pairing_code: row.session_data?.pairing_code || null,
    raw_payload: row.session_data?.raw_payload || row.session_data || null,
  }
}

async function getAccountConnection(accountId) {
  const { data, error } = await supabase
    .from('whatsapp_sessions')
    .select('*')
    .eq('account_id', accountId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return shape(data)
}

async function saveAccountConnection(businessId, accountId, existing, updates = {}) {
  const sessionData = {
    ...(existing?.session_data || {}),
    ...(updates.qr_code !== undefined ? { qr_code: updates.qr_code } : {}),
    ...(updates.pairing_code !== undefined ? { pairing_code: updates.pairing_code } : {}),
    ...(updates.raw_payload !== undefined ? { raw_payload: updates.raw_payload } : {}),
  }
  const payload = {
    business_id: businessId,
    account_id: accountId,
    instance_name: updates.evolution_instance_id || existing?.instance_name,
    status: updates.status || existing?.status || 'pending',
    phone_number: updates.phone_number ?? existing?.phone_number ?? null,
    session_data: sessionData,
    updated_at: new Date().toISOString(),
  }
  const query = existing?.id
    ? supabase.from('whatsapp_sessions').update(payload).eq('id', existing.id).eq('account_id', accountId)
    : supabase.from('whatsapp_sessions').insert(payload)
  const { data, error } = await query.select().single()
  if (error) throw error
  return shape(data)
}

// The instance that serves this account: its current one, or a new one named after the account.
async function ensureAccountInstance(businessId, accountId, existing) {
  const { data: account, error } = await supabase
    .from('accounts').select('id, business_id, instance_name, phone_number, status').eq('id', accountId).maybeSingle()
  if (error || !account || account.business_id !== businessId) throw Object.assign(new Error('account_not_found'), { status: 404 })
  const instanceName = existing?.instance_name || account.instance_name || `heysasa-${businessId}-${accountId.slice(0, 8)}`
  try {
    await getEvolutionConnectionState(instanceName)
  } catch (err) {
    if (err.status !== 404) throw err
    await evolutionRequest('/instance/create', {
      method: 'POST',
      body: JSON.stringify({
        instanceName,
        instance: instanceName,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        syncFullHistory: true,
        webhook: EVOLUTION_WEBHOOK_URL ? {
          url: EVOLUTION_WEBHOOK_URL,
          byEvents: false,
          base64: true,
          events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGING_HISTORY_SET', 'CONNECTION_UPDATE', 'PRESENCE_UPDATE',
            'CHATS_SET', 'CHATS_UPSERT', 'CONTACTS_SET', 'CONTACTS_UPSERT'],
        } : undefined,
      }),
    })
  }
  return { instanceName, account }
}

async function ensureInstance(businessId) {
  const { data: business, error } = await supabase
    .from('businesses')
    .select('business_id, evolution_instance_id')
    .eq('business_id', businessId)
    .single()
  if (error || !business) throw new Error('business_not_found')

  const instanceName = business.evolution_instance_id || `heysasa-${businessId}`
  if (!business.evolution_instance_id) {
    await createEvolutionInstance(instanceName)
    const { error: updateError } = await supabase
      .from('businesses')
      .update({ evolution_instance_id: instanceName })
      .eq('business_id', businessId)
    if (updateError) throw updateError
  }
  return instanceName
}

whatsappRouter.get('/whatsapp/connection', async (req, res) => {
  const target = targetAccount(req, res)
  if (!target) return
  try {
    const connection = target.accountId ? await getAccountConnection(target.accountId) : await getConnection(req.businessId)
    res.json(connection ?? { business_id: req.businessId, account_id: target.accountId, status: 'not_configured' })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

whatsappRouter.post('/whatsapp/connection', async (req, res) => {
  const request = normalizeWhatsappConnectionRequest(req.body ?? {})
  const mode = request.mode ?? 'qr'
  const phoneNumber = request.phoneNumber

  if (request.error) return res.status(400).json({ error: request.error })
  const target = targetAccount(req, res)
  if (!target) return

  try {
    const connectionFields = (instanceName, connection) => ({
      evolution_instance_id: instanceName,
      status: 'connecting',
      qr_code: mode === 'phone' ? null : (connection?.base64 || connection?.qrcode?.base64 || connection?.qrCode || null),
      // `code` is the raw QR payload in Evolution responses, not a pairing code,
      // so it must never be stored here. Only keep a pairing code in phone mode.
      pairing_code: mode === 'phone'
        ? (connection?.pairingCode || connection?.pairing_code || connection?.qrcode?.pairingCode || null)
        : null,
      phone_number: phoneNumber ? phoneNumber.replace(/^0+/, '') : null,
      last_error: null,
      raw_payload: connection,
    })

    if (!target.accountId) {
      const instanceName = await ensureInstance(req.businessId)
      const connection = await connectEvolutionInstance(instanceName, mode === 'phone' ? phoneNumber : null)
      const saved = await saveConnectionState(req.businessId, connectionFields(instanceName, connection))
      return res.status(202).json(saved)
    }

    const existing = await getAccountConnection(target.accountId)
    if (existing?.status === 'connected') return res.status(409).json({ error: 'account_already_connected', instance: existing.instance_name })
    const { instanceName, account } = await ensureAccountInstance(req.businessId, target.accountId, existing)
    // The account is locked to the first number that connected it (ACCOUNTS.md rule 1).
    const wanted = phoneNumber ? phoneNumber.replace(/^0+/, '') : null
    if (wanted && account.phone_number && account.phone_number !== wanted) {
      return res.status(409).json({ error: 'phone_mismatch', expected: account.phone_number })
    }
    const connection = await connectEvolutionInstance(instanceName, mode === 'phone' ? phoneNumber : null)
    const saved = await saveAccountConnection(req.businessId, target.accountId, existing, connectionFields(instanceName, connection))
    res.status(202).json(saved)
  } catch (error) {
    res.status(error.status && error.status < 500 ? error.status : 502).json({ error: error.message, details: error.body ?? null })
  }
})

whatsappRouter.post('/whatsapp/connection/refresh', async (req, res) => {
  const target = targetAccount(req, res)
  if (!target) return
  try {
    const connection = target.accountId ? await getAccountConnection(target.accountId) : await getConnection(req.businessId)
    if (!connection?.evolution_instance_id) return res.status(404).json({ error: 'instance_not_configured' })
    const state = await getEvolutionConnectionState(connection.evolution_instance_id)
    const saved = target.accountId
      ? await saveAccountConnection(req.businessId, target.accountId, connection, { raw_payload: state })
      : await saveConnectionState(req.businessId, { raw_payload: state })
    res.json(saved)
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

// Removes the selected account's connection only: its Evolution instance and its session row. Other numbers of the
// business are untouched, and the account itself (with all its data) stays, marked disconnected by the database.
whatsappRouter.delete('/whatsapp/connection', async (req, res) => {
  const target = targetAccount(req, res)
  if (!target) return
  try {
    const connection = target.accountId ? await getAccountConnection(target.accountId) : await getConnection(req.businessId)
    const instanceName = connection?.evolution_instance_id ?? null
    if (instanceName) {
      await deleteEvolutionInstance(instanceName)
      let cleanup = supabase.from('whatsapp_sessions').delete().eq('business_id', req.businessId).eq('instance_name', instanceName)
      if (target.accountId) cleanup = cleanup.eq('account_id', target.accountId)
      const { error } = await cleanup
      if (error) throw error
      // The legacy pointer only goes when it named this very instance.
      const { error: businessError } = await supabase.from('businesses').update({ evolution_instance_id: null })
        .eq('business_id', req.businessId).eq('evolution_instance_id', instanceName)
      if (businessError) throw businessError
    }
    res.status(204).send()
  } catch (error) {
    res.status(error.status && error.status < 500 ? error.status : 502).json({ error: error.message })
  }
})
