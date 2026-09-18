import { checkEvolutionInstanceState } from '../sender-baileys/evolutionSender.js'

export function getSessionHealthDecision(sessionStatus) {
  if (sessionStatus === 'connected') return 'ok'
  if (sessionStatus === 'unknown') return 'retry'
  if (sessionStatus === 'disconnected') return 'locked'
  return 'retry'
}

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

// Health checks are advisory only. They are never allowed to pause, fail, or
// resume campaigns. The only campaign pause signal is when whatsapp_sessions
// explicitly says the instance is closed.
export async function checkInstanceStatus(supabase, campaign) {
  const sessionState = await getSessionState(supabase, campaign)
  const decision = getSessionHealthDecision(sessionState.status)

  if (decision === 'ok') {
    if (campaign.whatsapp_instance_name) {
      const { open, error: evolutionError } = await checkEvolutionInstanceState(campaign.whatsapp_instance_name)
      if (evolutionError || open === false) {
        console.warn(`[InstanceHealth] Campaign ${campaign.id} instance is still connected in whatsapp_sessions, but health check failed; keeping campaign active and retrying next cycle`)
      }
    }
    return 'ok'
  }

  if (decision === 'retry') {
    console.warn(`[InstanceHealth] Campaign ${campaign.id} session state is inconclusive — retrying next cycle without pausing`)
    return 'retry'
  }

  console.warn(`[InstanceHealth] Campaign ${campaign.id} is locked because whatsapp_sessions says the instance is closed; the health checker will not pause or fail the campaign`)
  return 'locked'
}
