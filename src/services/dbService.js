import { supabase } from '../config/supabase.js';
import { extractPhone } from './dataCleaner.js';
import { debugLog } from './debugConsole.js';

function logDbFailure(step, context, error) {
    debugLog('error', `DB ${step}`, `${step} failed`, { ...context, error });
    console.error(`[DB] ${step} failed`, {
        ...context,
        message: error?.message,
        details: error?.details || null,
        hint: error?.hint || null,
        code: error?.code || null,
        stack: error?.stack || null,
    });
}

export async function getOrCreateContact(businessId, jid, pushName) {
    const phone = extractPhone(jid);
    try {
        const payload = {
            business_id: businessId,
            social_platform: 'whatsapp',
            social_id: jid,
            phone,
            last_seen: new Date().toISOString()
        };

        if (pushName && pushName !== 'Unknown') {
            payload.name = pushName;
        }

        const { data: created, error } = await supabase
            .from('contacts')
            .upsert(payload, { 
                onConflict: 'business_id, social_platform, social_id',
                ignoreDuplicates: false 
            })
            .select('id, lead_state, name, is_ad_lead, lead_type, original_ad_id, ad_attribution_id')
            .single();

        if (error) throw error;
        return created;
    } catch (error) {
        logDbFailure('getOrCreateContact', { businessId, jid, pushName, phone }, error);
        throw new Error(`Contact lookup/create failed: ${error.message}`);
    }
}

export async function getOrCreateConversation(businessId, contactId, jid) {
    try {
        const { data: existing, error: fetchError } = await supabase
            .from('conversations')
            .select('id')
            .eq('business_id', businessId)
            .eq('contact_id', contactId)
            .maybeSingle();

        if (fetchError) throw fetchError;
        if (existing) return existing.id;

        const payload = {
            business_id: businessId,
            contact_id: contactId,
            external_id: jid,
            channel: 'whatsapp',
            type: 'dm',
            status: 'open',
            ai_enabled: true,
            active_agent: 'manager'
        };

        const { data: created, error: createError } = await supabase
            .from('conversations')
            .insert(payload)
            .select('id')
            .single();

        if (createError) throw createError;
        return created.id;
    } catch (error) {
        logDbFailure('getOrCreateConversation', { businessId, contactId, jid }, error);
        throw new Error(`Conversation lookup/create failed: ${error.message}`);
    }
}

export async function recordAdAttribution(businessId, contactId, adData) {
    if (!adData?.ad_id) return null;
    try {
        const { data: adRecord, error: adError } = await supabase
            .from('ad_attributions')
            .upsert({
                business_id:      businessId,
                ad_id:            adData.ad_id,
                ad_headline:      adData.ad_headline,
                ad_body:          adData.ad_body,
                ad_thumbnail_url: adData.ad_thumbnail_url,
                ad_source_url:    adData.ad_source_url,
                ad_platform:      adData.ad_platform,
            }, { onConflict: 'business_id, ad_id', ignoreDuplicates: false })
            .select('id')
            .single();

        if (adError) throw adError;

        const { error: contactError } = await supabase.from('contacts').update({
            is_ad_lead:        true,
            lead_type:         'business',
            ad_attribution_id: adRecord.id,
            original_ad_id:    adData.ad_id,
            ad_headline:       adData.ad_headline,
            ad_platform:       adData.ad_platform,
            ad_attributed_at:  adData.captured_at || new Date().toISOString()
        }).eq('id', contactId);

        if (contactError) throw contactError;

        return adRecord.id;
    } catch (error) {
        logDbFailure('recordAdAttribution', { businessId, contactId, adId: adData?.ad_id }, error);
        return null;
    }
}

export async function updateLeadStateOnReply(contactId, currentState) {
    const transitionStates = ['new', 'stalled', 'ghosted', 'warm'];
    if (!transitionStates.includes(currentState)) return;

    try {
        const { error } = await supabase.from('contacts').update({ lead_state: 'engaged' }).eq('id', contactId);
        if (error) throw error;
    } catch (error) {
        logDbFailure('updateLeadStateOnReply', { contactId, currentState }, error);
    }
}

export async function cancelPendingFollowUps(contactId) {
    try {
        const { error } = await supabase.from('follow_up_queue')
            .update({ status: 'cancelled', skip_reason: 'lead_replied' })
            .eq('contact_id', contactId)
            .in('status', ['pending', 'ready_to_send']);

        if (error) throw error;
    } catch (error) {
        logDbFailure('cancelPendingFollowUps', { contactId }, error);
    }
}

export function aggregateSentimentTrend(snapshots = [], anchorDate = new Date(), weeks = 8) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) return [];

    const since = new Date(anchorDate);
    since.setDate(since.getDate() - weeks * 7);

    const buckets = {};

    for (const snapshot of snapshots) {
        const createdAt = snapshot.created_at || snapshot.createdAt;
        if (!createdAt) continue;

        const d = new Date(createdAt);
        const weekIdx = Math.floor((d - since) / (7 * 24 * 3600 * 1000));
        
        if (!Number.isFinite(weekIdx) || weekIdx < 0 || weekIdx >= weeks) continue;

        if (!buckets[weekIdx]) buckets[weekIdx] = [];
        buckets[weekIdx].push(Number(snapshot.sentiment_score));
    }

    return Object.keys(buckets)
        .sort((a, b) => Number(a) - Number(b))
        .map((idx, index) => {
            const scores = buckets[idx].filter((score) => Number.isFinite(score));
            if (!scores.length) return null;

            const avg = scores.reduce((sum, value) => sum + value, 0) / scores.length;
            return { week: `W${index + 1}`, score: (avg + 1) / 2 };
        })
        .filter(Boolean);
}

export async function getSentimentTrend(businessId, weeks = 8) {
    try {
        const since = new Date();
        since.setDate(since.getDate() - weeks * 7);

        const { data: snapshots, error } = await supabase
            .from('sentiment_snapshots')
            .select('sentiment_score, created_at')
            .eq('business_id', businessId)
            .gte('created_at', since.toISOString())
            .order('created_at', { ascending: true });

        if (error) throw error;

        return aggregateSentimentTrend(snapshots || [], new Date(), weeks);
    } catch (error) {
        logDbFailure('getSentimentTrend', { businessId, weeks }, error);
        return [];
    }
}

export async function getMarketIntelligence(businessId) {
    return { market_intelligence: { business_id: businessId } };
}

export async function getDashboardMetrics(businessId) {
    const [marketData, sentimentTrend] = await Promise.all([
        getMarketIntelligence(businessId),
        getSentimentTrend(businessId),
    ]);

    return {
        ...marketData,
        sentiment_trend: sentimentTrend,
    };
}