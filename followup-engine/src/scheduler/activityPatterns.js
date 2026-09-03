import { DEFAULT_TIMEZONE } from '../config.js'
import { getZonedParts } from '../lib/timing.js'

export async function runActivityPatterns(supabase) {
  const cutoff = new Date(Date.now() - 3_600_000).toISOString()

  const { data: recent } = await supabase
    .from('messages')
    .select('contact_id, business_id')
    .eq('direction', 'in')
    .gte('created_at', cutoff)

  if (!recent?.length) return { updated: 0 }

  // Deduplicate by contact
  const seen = new Set()
  const unique = recent.filter(m => {
    const key = `${m.contact_id}:${m.business_id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  let updated = 0
  for (const item of unique) {
    try {
      const { data: business } = await supabase
        .from('businesses')
        .select('timezone')
        .eq('business_id', item.business_id)
        .maybeSingle()
      const timeZone = business?.timezone || DEFAULT_TIMEZONE

      const { data: allMsgs } = await supabase
        .from('messages')
        .select('created_at')
        .eq('contact_id', item.contact_id)
        .eq('direction', 'in')

      if (!allMsgs?.length) continue

      const hourCounts = {}
      for (const msg of allMsgs) {
        const h = getZonedParts(new Date(msg.created_at), timeZone).hour
        hourCounts[h] = (hourCounts[h] ?? 0) + 1
      }

      const avg = Object.values(hourCounts).reduce((a, b) => a + b, 0) / Object.keys(hourCounts).length
      const activeHours = Object.keys(hourCounts).map(Number).filter(h => hourCounts[h] >= avg)
      const optimalHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0]?.[0]

      await supabase.from('contact_activity_patterns').upsert({
        contact_id: item.contact_id,
        business_id: item.business_id,
        active_hours: activeHours,
        total_messages_analysed: allMsgs.length,
        last_calculated_at: new Date().toISOString()
      }, { onConflict: 'contact_id,business_id' })

      await supabase.from('contacts').update({
        optimal_contact_hour: parseInt(optimalHour ?? '10')
      }).eq('id', item.contact_id)

      updated++
    } catch (e) {
      console.error(`[Patterns] Error: ${e.message}`)
    }
  }

  return { updated }
}