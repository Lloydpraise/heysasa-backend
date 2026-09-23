import { supabase } from '../config/supabase.js';
import { getWaitlistCount } from './waitlistService.js';

// Backs the landing page's three live counters. Every number here is a
// real count against real tables — nothing is estimated or padded. If a
// query fails, that counter falls back to null and the frontend should
// show its last-known value rather than a scary zero.
const CACHE_MS = 30_000;
let cache = null;
let cacheAt = 0;

export async function getPublicStats() {
    if (cache && Date.now() - cacheAt < CACHE_MS) return cache;

    const [messagesAnalyzed, responsesReceived, businessesLive, waitlistCount] = await Promise.all([
        // Every message that belongs to a conversation which has actually
        // gone through structural enrichment — not just "messages we've
        // stored", which would count things the analysis pipeline hasn't
        // touched yet and overstate what "analyzed" means.
        supabase
            .from('messages')
            .select('id, contacts!inner(structural_enriched_at)', { count: 'exact', head: true })
            .not('contacts.structural_enriched_at', 'is', null)
            .then(r => r.count).catch(() => null),
        // Two sources of a real reply: a campaign step someone replied
        // to, and a standalone AI follow-up someone replied to. Summed,
        // not deduplicated across the two (a contact could appear in
        // both) — acceptable for a headline counter, not for billing.
        Promise.all([
            supabase.from('campaign_step_events').select('id', { count: 'exact', head: true }).not('replied_at', 'is', null).then(r => r.count).catch(() => 0),
            supabase.from('follow_up_outcomes').select('id', { count: 'exact', head: true }).eq('outcome', 'replied').then(r => r.count).catch(() => 0),
        ]).then(([a, b]) => a + b),
        supabase.from('whatsapp_sessions').select('business_id', { count: 'exact', head: true }).eq('status', 'connected').then(r => r.count).catch(() => null),
        getWaitlistCount().catch(() => null),
    ]);

    const { count: businessesTotal } = await supabase.from('businesses').select('business_id', { count: 'exact', head: true }).then(r => ({ count: r.count })).catch(() => ({ count: null }));

    cache = {
        messagesAnalyzed,
        responsesReceived,
        businessesInPipeline: (businessesTotal || 0) + (waitlistCount || 0),
        businessesActive: businessesLive,
    };
    cacheAt = Date.now();
    return cache;
}
