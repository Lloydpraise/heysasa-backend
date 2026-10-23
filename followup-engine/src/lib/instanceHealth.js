import { EVOLUTION_URL, EVOLUTION_KEY } from '../config.js'
import { log } from './log.js'

// whatsapp_sessions is the source of truth for "is this number connected", kept live by Evolution's
// connection.update webhook. The one weakness is a LOST webhook (a restart or a slow moment while a
// close arrives): the row then says 'connected' for a number that is gone, and every queued message
// knocks on a dead connection. The connection reconciler that used to catch this is switched off.
//
// This is the narrow replacement. It is NOT a ping before every send. It runs only after a real send
// failed with a connection-type error, asks Evolution once (at most once every 2 minutes per number)
// and only when Evolution itself says the number is not open does it mark the row 'pending', so the
// sender and scheduler stop using it. When Evolution later reports 'open', the row is put back.
const CHECK_EVERY_MS = 2 * 60_000
const lastCheck = new Map()       // instance -> { at, state }
const demoted = new Map()         // instance -> business_id (rows this process marked 'pending')

export async function readInstanceState(instanceName) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)
    const res = await fetch(`${EVOLUTION_URL}/instance/connectionState/${encodeURIComponent(instanceName)}`, {
      headers: { apikey: EVOLUTION_KEY },
      signal: controller.signal
    })
    clearTimeout(timeout)
    if (res.status === 404) return 'missing'
    if (!res.ok) return 'unknown'
    const body = await res.json().catch(() => null)
    const state = String(body?.instance?.state ?? body?.state ?? '').toLowerCase()
    if (state === 'open' || state === 'connecting' || state === 'close') return state
    if (state === 'closed') return 'close'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// After a connection-type send failure: if Evolution says the number is not open, stop using the session row.
// Returns the state it found ('open' | 'connecting' | 'close' | 'missing' | 'unknown' | 'skipped').
export async function confirmInstanceAfterFailure(supabase, { instanceName, businessId }) {
  const prev = lastCheck.get(instanceName)
  if (prev && Date.now() - prev.at < CHECK_EVERY_MS) return 'skipped'
  const state = await readInstanceState(instanceName)
  lastCheck.set(instanceName, { at: Date.now(), state })
  if (state === 'close' || state === 'missing' || state === 'connecting') {
    const { data, error } = await supabase.from('whatsapp_sessions')
      .update({ status: 'pending', updated_at: new Date().toISOString() })
      .eq('business_id', businessId).eq('instance_name', instanceName).eq('status', 'connected')
      .select('id')
    if (!error && data?.length) {
      demoted.set(instanceName, businessId)
      log('warn', 'sender', 'sender.session_demoted',
        `Evolution says ${instanceName} is ${state}; marked the session pending so nothing is sent until it reconnects`,
        { business_id: businessId, details: { instance: instanceName, evolutionState: state } })
    }
  }
  return state
}

// Puts back any session this process demoted once Evolution reports it open again (covers a lost "open" webhook).
export async function healDemotedSessions(supabase) {
  for (const [instanceName, businessId] of [...demoted]) {
    const prev = lastCheck.get(instanceName)
    if (prev && Date.now() - prev.at < 60_000) continue
    const state = await readInstanceState(instanceName)
    lastCheck.set(instanceName, { at: Date.now(), state })
    if (state !== 'open') continue
    const { error } = await supabase.from('whatsapp_sessions')
      .update({ status: 'connected', updated_at: new Date().toISOString() })
      .eq('business_id', businessId).eq('instance_name', instanceName).eq('status', 'pending')
    demoted.delete(instanceName)
    if (!error) log('info', 'sender', 'sender.session_restored', `${instanceName} is open again; session restored`, { business_id: businessId, details: { instance: instanceName } })
  }
}

export function _resetInstanceHealthForTests() {
  lastCheck.clear(); demoted.clear()
}
