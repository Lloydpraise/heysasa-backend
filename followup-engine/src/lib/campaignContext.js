// Context the campaign rewrite step needs beyond the persona pack:
//  - the lead's customer_profiles row (keyed by contact.id)
//  - for auto-campaigns, the effective objective + playbook
//    (business override if set, otherwise the platform default for its industry)

export async function getCustomerProfile(supabase, contactId) {
  try {
    const { data } = await supabase.from('customer_profiles')
      .select('archetype, tone, sentiment, buying_stage, interest_level, objections, product_interests, price_objection, personality_notes, last_call_summary, next_action_plan, lead_quality')
      .eq('contact_id', contactId).maybeSingle()
    if (!data) return null
    return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length)))
  } catch { return null }
}

export async function getAutoCampaignContext(supabase, businessId, ruleId) {
  try {
    const [{ data: cfg }, { data: def }] = await Promise.all([
      supabase.from('auto_campaign_configs').select('objective, playbook').eq('business_id', businessId).eq('rule_id', ruleId).maybeSingle(),
      supabase.rpc('resolve_auto_campaign_default', { p_business_id: businessId, p_rule_id: ruleId }).maybeSingle()
    ])
    return {
      objective: cfg?.objective ?? def?.objective ?? null,
      playbook: cfg?.playbook ?? def?.playbook ?? null
    }
  } catch { return {} }
}
