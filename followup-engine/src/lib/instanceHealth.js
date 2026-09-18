import { checkEvolutionInstanceState } from '../sender-baileys/evolutionSender.js'

const INSTANCE_PAUSE_AFTER_MS = 5 * 60_000
const INSTANCE_FAIL_AFTER_MS = 10 * 60_000
const instanceCheckState = new Map() // campaignId -> { disconnectedSince: number, pauseLoggedAt: number | null }

async function getSessionState(supabase, campaign) {
  if (!campaign.whatsapp_instance_name) return { status: 'disconnected' }

  const { data: session, error: sessionError } = await supabase
    .from('whatsapp_sessions')
    .select('instance_name, status, updated_at')
    .eq('business_id', campaign.business_id)
    .eq('instance_name', campaign.whatsapp_instance_name)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (sessionError) {
    console.warn(`[InstanceHealth] whatsapp_sessions check errored for campaign ${campaign.id}: ${sessionError.message} — treating as unknown, not disconnected`)
    return { status: 'unknown', error: sessionError }
  }

  if (!session) return { status: 'disconnected' }
  return session.status === 'connected' ? { status: 'connected' } : { status: 'disconnected' }
}

// The DB session row is the source of truth. If it still says connected,
// we do not pause or fail the campaign just because one health check had a
// timeout/DNS hiccup. Keep the campaign active and log the retry.
export async function checkInstanceStatus(supabase, campaign) {
  const sessionState = await getSessionState(supabase, campaign)

  if (sessionState.status === 'connected') {
    const { open, error: evolutionError } = await checkEvolutionInstanceState(campaign.whatsapp_instance_name)
    if (evolutionError || open === false) {
      console.warn(`[InstanceHealth] Campaign ${campaign.id} instance is still connected in whatsapp_sessions, but health check failed; keeping campaign active and retrying next cycle`)
    }

    if (campaign.status === 'paused') {
      const { error } = await supabase
        .from('campaigns')
        .update({ status: 'active', failure_reason: null, failed_at: null })
        .eq('id', campaign.id)
        .eq('status', 'paused')

      if (error) {
        console.warn(`[InstanceHealth] Failed to resume campaign ${campaign.id}: ${error.message}`)
      } else {
        console.log(`[InstanceHealth] Resumed campaign ${campaign.id}: whatsapp_sessions reports the instance connected again`)
      }
    }

    instanceCheckState.delete(campaign.id)
    return 'ok'
  }

  if (sessionState.status === 'unknown') {
    console.warn(`[InstanceHealth] Campaign ${campaign.id} session state is inconclusive — retrying next cycle without pausing`)
    return 'retry'
  }

  const { open, error: evolutionError } = await checkEvolutionInstanceState(campaign.whatsapp_instance_name)
  if (evolutionError) {
    console.warn(`[InstanceHealth] Campaign ${campaign.id} health check failed while whatsapp_sessions reports disconnected; logging retry and continuing the grace window`)
  }

  if (open === true) {
    instanceCheckState.delete(campaign.id)
    if (campaign.status === 'paused') {
      const { error } = await supabase
        .from('campaigns')
        .update({ status: 'active', failure_reason: null, failed_at: null })
        .eq('id', campaign.id)
        .eq('status', 'paused')

      if (error) {
        console.warn(`[InstanceHealth] Failed to resume campaign ${campaign.id}: ${error.message}`)
      } else {
        console.log(`[InstanceHealth] Resumed campaign ${campaign.id}: Evolution reports the instance is back open`)
      }
    }
    return 'ok'
  }

  const now = Date.now()
  const current = instanceCheckState.get(campaign.id) ?? { disconnectedSince: now, pauseLoggedAt: null }
  if (!current.disconnectedSince) current.disconnectedSince = now

  if (!current.pauseLoggedAt && now - current.disconnectedSince >= INSTANCE_PAUSE_AFTER_MS) {
    current.pauseLoggedAt = now
    instanceCheckState.set(campaign.id, current)
    console.warn(`[InstanceHealth] Campaign ${campaign.id} paused because whatsapp is disconnected and health checks have stayed failed through the grace window`)
    await supabase
      .from('campaigns')
      .update({ status: 'paused', failure_reason: 'campaign_instance_unavailable', failed_at: null })
      .eq('id', campaign.id)
      .in('status', ['active', 'paused'])
    return 'paused'
  }

  instanceCheckState.set(campaign.id, current)

  if (!current.pauseLoggedAt) {
    const minutesRemaining = Math.max(0, Math.ceil((INSTANCE_PAUSE_AFTER_MS - (now - current.disconnectedSince)) / 60_000))
    console.warn(`[InstanceHealth] Campaign ${campaign.id} first health check failed while whatsapp is disconnected; continuing grace retries (${minutesRemaining} min remaining before pause)`)
    return 'retry'
  }

  const timeSincePause = now - current.pauseLoggedAt
  if (timeSincePause < INSTANCE_FAIL_AFTER_MS) {
    const minutesRemaining = Math.max(0, Math.ceil((INSTANCE_FAIL_AFTER_MS - timeSincePause) / 60_000))
    console.warn(`[InstanceHealth] Campaign ${campaign.id} remains paused because whatsapp is disconnected; final fail in ~${minutesRemaining} min unless it reconnects`)
    return 'paused'
  }

  instanceCheckState.delete(campaign.id)
  return 'failed'
}
