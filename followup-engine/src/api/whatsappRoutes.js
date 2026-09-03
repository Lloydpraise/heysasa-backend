import { Router } from 'express'
import { supabase } from '../supabaseClient.js'
import {
  connectEvolutionInstance,
  createEvolutionInstance,
  deleteEvolutionInstance,
  getConnection,
  getEvolutionConnectionState,
  saveConnectionState,
} from '../../../src/services/evolutionConnections.js'

export const whatsappRouter = Router()

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
  try {
    const connection = await getConnection(req.businessId)
    res.json(connection ?? { business_id: req.businessId, status: 'not_configured' })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

whatsappRouter.post('/whatsapp/connection', async (req, res) => {
  const mode = req.body?.mode ?? 'qr'
  const phoneNumber = req.body?.phoneNumber?.replace(/\D/g, '') || null
  if (!['qr', 'phone'].includes(mode)) return res.status(400).json({ error: 'mode_must_be_qr_or_phone' })
  if (mode === 'phone' && !phoneNumber) return res.status(400).json({ error: 'phone_number_required' })

  try {
    const instanceName = await ensureInstance(req.businessId)
    const connection = await connectEvolutionInstance(instanceName, mode === 'phone' ? phoneNumber : null)
    const saved = await saveConnectionState(req.businessId, {
      evolution_instance_id: instanceName,
      status: 'connecting',
      qr_code: connection?.base64 || connection?.qrcode?.base64 || connection?.qrCode || null,
      pairing_code: connection?.pairingCode || connection?.pairing_code || connection?.code || null,
      phone_number: phoneNumber,
      last_error: null,
      raw_payload: connection,
    })
    res.status(202).json(saved)
  } catch (error) {
    res.status(error.status && error.status < 500 ? error.status : 502).json({ error: error.message, details: error.body ?? null })
  }
})

whatsappRouter.post('/whatsapp/connection/refresh', async (req, res) => {
  try {
    const connection = await getConnection(req.businessId)
    if (!connection?.evolution_instance_id) return res.status(404).json({ error: 'instance_not_configured' })
    const state = await getEvolutionConnectionState(connection.evolution_instance_id)
    const saved = await saveConnectionState(req.businessId, { raw_payload: state })
    res.json(saved)
  } catch (error) {
    res.status(502).json({ error: error.message })
  }
})

whatsappRouter.delete('/whatsapp/connection', async (req, res) => {
  try {
    const connection = await getConnection(req.businessId)
    if (connection?.evolution_instance_id) await deleteEvolutionInstance(connection.evolution_instance_id)
    const { error } = await supabase.from('whatsapp_sessions').delete().eq('business_id', req.businessId)
    if (error) throw error
    const { error: businessError } = await supabase.from('businesses').update({ evolution_instance_id: null }).eq('business_id', req.businessId)
    if (businessError) throw businessError
    res.status(204).send()
  } catch (error) {
    res.status(error.status && error.status < 500 ? error.status : 502).json({ error: error.message })
  }
})