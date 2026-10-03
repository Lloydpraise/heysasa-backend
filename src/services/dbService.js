import { supabase } from '../config/supabase.js';
import { extractPhone, isLidJid, isPhoneJid, isUsableContactName } from './dataCleaner.js';
import { logEvent } from './debugConsole.js';

// `area` groups related failures in the console (default 'db' for
// generic contact/conversation bookkeeping; callers pass 'ads' or
// 'campaign' for anything on those specific paths).
function logDbFailure(step, context, error, area = 'db') {
    logEvent({
        level: 'error', area, event: `db.${step}_failed`, message: `${step} failed: ${error?.message || error}`,
        business_id: context?.businessId ?? null, contact_id: context?.contactId ?? null,
        details: { ...context, error: { message: error?.message, details: error?.details, hint: error?.hint, code: error?.code } },
    });
    console.error(`[DB] ${step} failed`, {
        ...context,
        message: error?.message,
        details: error?.details || null,
        hint: error?.hint || null,
        code: error?.code || null,
        stack: error?.stack || null,
    });
}

const CONTACT_COLS = 'id, lead_state, name, is_ad_lead, lead_type, original_ad_id, ad_attribution_id';

// The business's own name(s), so we never save them as a customer's name.
const OWNER_NAMES_TTL_MS = 10 * 60 * 1000;
const ownerNamesCache = new Map();
async function getOwnerNames(businessId) {
    const hit = ownerNamesCache.get(businessId);
    if (hit && Date.now() - hit.at < OWNER_NAMES_TTL_MS) return hit.names;
    let names = [];
    try {
        const { data } = await supabase.from('businesses').select('name').eq('business_id', businessId).maybeSingle();
        if (data?.name) names = [data.name];
    } catch { /* best effort - the name guard just gets weaker, ingestion carries on */ }
    ownerNamesCache.set(businessId, { at: Date.now(), names });
    return names;
}

const lidDigits = (jid) => (isLidJid(jid) ? jid.split('@')[0] : '');

// Finds the contact a chat belongs to under EITHER of its identities (phone JID or
// LID), so one person never becomes two contacts when WhatsApp alternates between
// them. Falls back to matching a known phone number on a LID contact.
async function findExistingContact(businessId, ids, phone) {
    const { data: bySocial, error } = await supabase
        .from('contacts')
        .select(`${CONTACT_COLS}, social_id, phone`)
        .eq('business_id', businessId)
        .eq('social_platform', 'whatsapp')
        .in('social_id', ids)
        .limit(5);
    if (error) throw error;
    if (bySocial?.length) return bySocial.find(r => r.social_id === ids[0]) || bySocial[0];

    if (phone) {
        const { data: byPhone, error: phoneError } = await supabase
            .from('contacts')
            .select(`${CONTACT_COLS}, social_id, phone`)
            .eq('business_id', businessId)
            .eq('social_platform', 'whatsapp')
            .like('social_id', '%@lid')
            .eq('phone', phone)
            .limit(2);
        if (phoneError) throw phoneError;
        if (byPhone?.length === 1) return byPhone[0]; // ambiguous matches are never guessed
    }
    return null;
}

// jid    - the chat's primary identity (what extractMessageJid returned)
// altJid - the chat's other identity when WhatsApp supplied both (LID <-> phone JID)
export async function getOrCreateContact(businessId, jid, pushName, altJid = null) {
    const ids = [...new Set([jid, altJid].filter(Boolean))];
    const lidJid = ids.find(isLidJid) || null;
    const pnJid = ids.find(isPhoneJid) || null;
    // phone is ONLY ever a real number: from a phone JID, never from a LID.
    const phone = pnJid ? extractPhone(pnJid) : (lidJid ? null : extractPhone(jid));
    try {
        const ownerNames = await getOwnerNames(businessId);
        const name = isUsableContactName(pushName, ownerNames) ? String(pushName).trim() : null;
        const now = new Date().toISOString();

        const existing = await findExistingContact(businessId, ids, phone);
        if (existing) {
            const patch = { last_seen: now };
            if (name) patch.name = name;
            // Fill the phone in when we learn it - and replace the old bug where a
            // LID's digits were stored as the phone. Never overwrite a real number.
            const phoneIsLidDigits = existing.phone
                && lidDigits(existing.social_id)
                && String(existing.phone).replace(/\D/g, '') === lidDigits(existing.social_id);
            if (phone && (!existing.phone || phoneIsLidDigits)) patch.phone = phone;

            const { data: updated, error } = await supabase
                .from('contacts')
                .update(patch)
                .eq('id', existing.id)
                .select(CONTACT_COLS)
                .single();
            if (error) throw error;
            return updated;
        }

        // New contact. Prefer the LID as the stable identity when we know it, with the
        // real phone alongside - a later LID-only message then still finds this row.
        const payload = {
            business_id: businessId,
            social_platform: 'whatsapp',
            social_id: lidJid || jid,
            last_seen: now
        };
        if (phone) payload.phone = phone;
        if (name) payload.name = name;

        const { data: created, error } = await supabase
            .from('contacts')
            .upsert(payload, {
                onConflict: 'business_id, social_platform, social_id',
                ignoreDuplicates: false
            })
            .select(CONTACT_COLS)
            .single();

        if (error) throw error;
        return created;
    } catch (error) {
        logDbFailure('getOrCreateContact', { businessId, jid, altJid, pushName, phone }, error);
        throw new Error(`Contact lookup/create failed: ${error.message}`);
    }
}

// Bulk contact writer for contacts.set / contacts.upsert / history sync.
// Differences from the three inline upserts it replaces:
//   - a LID never becomes `phone`
//   - 'Unknown' / numeric / owner names are never written (the old code wrote
//     'Unknown' over a real name whenever a sync carried no name)
//   - columns we have no value for are OMITTED, so an existing name/phone is never
//     blanked; rows are grouped by shape so PostgREST doesn't null the gaps
//   - duplicate ids in one batch are collapsed (they made Postgres reject the batch)
// `extraFields` are applied to every row (history sync passes the new-lead defaults).
export async function upsertContactBatch(businessId, rawContacts, { extraFields = {}, returning = false } = {}) {
    const ownerNames = await getOwnerNames(businessId);
    const now = new Date().toISOString();
    const bySocialId = new Map();

    for (const c of rawContacts) {
        if (!c?.id) continue;
        const row = { business_id: businessId, social_platform: 'whatsapp', social_id: c.id, last_seen: now, ...extraFields };
        const phone = isLidJid(c.id) ? null : extractPhone(c.id);
        if (phone) row.phone = phone;
        const candidate = c.name || c.notify || c.verifiedName;
        if (isUsableContactName(candidate, ownerNames)) row.name = String(candidate).trim();
        bySocialId.set(c.id, row);
    }

    const groups = new Map();
    for (const row of bySocialId.values()) {
        const shape = Object.keys(row).sort().join(',');
        if (!groups.has(shape)) groups.set(shape, []);
        groups.get(shape).push(row);
    }

    const data = [];
    let firstError = null;
    for (const rows of groups.values()) {
        const query = supabase.from('contacts').upsert(rows, { onConflict: 'business_id, social_platform, social_id' });
        const { data: out, error } = returning ? await query.select('id, social_id') : await query;
        if (error) { firstError = firstError || error; continue; }
        if (out) data.push(...out);
    }
    return { data, error: firstError, count: bySocialId.size };
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

        if (createError) {
            if (createError.code !== '23505') throw createError;

            const { data: concurrentConversation, error: retryError } = await supabase
                .from('conversations')
                .select('id')
                .eq('business_id', businessId)
                .eq('contact_id', contactId)
                .maybeSingle();

            if (retryError) throw retryError;
            if (concurrentConversation) return concurrentConversation.id;
            throw createError;
        }
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

        logEvent({
            level: 'ok', area: 'ads', event: 'ads.attributed', message: `Contact attributed to ad ${adData.ad_id}`,
            business_id: businessId, contact_id: contactId,
            details: { adId: adData.ad_id, adPlatform: adData.ad_platform, adHeadline: adData.ad_headline },
        });
        return adRecord.id;
    } catch (error) {
        logDbFailure('recordAdAttribution', { businessId, contactId, adId: adData?.ad_id }, error, 'ads');
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

// Cheap, local sentiment for reactions — no AI round-trip needed since an
// emoji reaction is already a compact, explicit signal. Text replies go
// through campaignReplyIntentClassifier.js instead (see that file for why
// this can't happen inline here — it needs the AI infra that only lives
// in the followup-engine service, not this one).
const POSITIVE_REACTIONS = new Set(['👍', '❤️', '❤', '😍', '🔥', '🙌', '✅', '🎉', '😂', '💯']);
const NEGATIVE_REACTIONS = new Set(['👎', '😡', '💔', '😢', '😞']);

function classifyReactionEmoji(emoji) {
    if (!emoji) return null;
    if (POSITIVE_REACTIONS.has(emoji)) return 'positive';
    if (NEGATIVE_REACTIONS.has(emoji)) return 'negative';
    return 'neutral';
}

// Attributes an inbound reply to whichever campaign step is still waiting
// on one. "Reply" here means any inbound message after a campaign send —
// not a WhatsApp quote-reply to that specific message — since that's the
// signal that covers every message type today. Deliberately picks the
// most recently sent, not-yet-replied step event for the lead's active
// enrollment; if none is pending (no active enrollment, or every step
// already has a replied_at), this is a no-op.
export async function recordCampaignStepReply(contactId) {
    try {
        const { data: enrollment, error: enrollmentError } = await supabase
            .from('campaign_enrollments')
            .select('id')
            .eq('lead_id', contactId)
            .in('status', ['pending', 'active', 'awaiting_opt_in'])
            .maybeSingle();
        if (enrollmentError) throw enrollmentError;
        if (!enrollment?.id) return null;

        const { data: stepEvent, error: stepEventError } = await supabase
            .from('campaign_step_events')
            .select('id')
            .eq('enrollment_id', enrollment.id)
            .not('sent_at', 'is', null)
            .is('replied_at', null)
            .order('sent_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (stepEventError) throw stepEventError;
        if (!stepEvent?.id) {
            logEvent({
                level: 'debug', area: 'campaign', event: 'campaign.reply_unmatched',
                message: 'Inbound reply received but no pending campaign step event to attribute it to',
                contact_id: contactId, details: { enrollmentId: enrollment.id },
            });
            return null;
        }

        const { error } = await supabase
            .from('campaign_step_events')
            .update({ replied_at: new Date().toISOString() })
            .eq('id', stepEvent.id);
        if (error) throw error;

        logEvent({
            level: 'ok', area: 'campaign', event: 'campaign.reply_attributed',
            message: 'Inbound reply attributed to a campaign step',
            contact_id: contactId, entity_id: stepEvent.id, details: { enrollmentId: enrollment.id },
        });
        return stepEvent.id;
    } catch (error) {
        logDbFailure('recordCampaignStepReply', { contactId }, error, 'campaign');
        return null;
    }
}

// Attributes an inbound reaction to the specific campaign step whose
// outbound message was reacted to. reactedMessageId is the whatsapp_message_id
// of the message being reacted to (see extractMessageContent), which we
// resolve to our own messages.id, then to the campaign_step_events row
// that message was linked to at send time.
export async function recordCampaignStepReaction(businessId, reactedMessageId, emoji) {
    if (!reactedMessageId) return;
    try {
        const { data: message, error: messageError } = await supabase
            .from('messages')
            .select('id')
            .eq('business_id', businessId)
            .eq('whatsapp_message_id', reactedMessageId)
            .maybeSingle();
        if (messageError) throw messageError;
        if (!message?.id) {
            logEvent({
                level: 'debug', area: 'campaign', event: 'campaign.reaction_no_message_match',
                message: 'Reaction received but no local message row matches this whatsapp_message_id',
                business_id: businessId, details: { reactedMessageId },
            });
            return;
        }

        const { error } = await supabase
            .from('campaign_step_events')
            .update({
                reacted_at: new Date().toISOString(),
                reaction_emoji: emoji || null,
                reply_intent: classifyReactionEmoji(emoji)
            })
            .eq('message_id', message.id);
        if (error) throw error;

        logEvent({
            level: 'ok', area: 'campaign', event: 'campaign.reaction_attributed',
            message: `Reaction "${emoji || ''}" attributed to a campaign step`,
            business_id: businessId, details: { reactedMessageId, emoji },
        });
    } catch (error) {
        logDbFailure('recordCampaignStepReaction', { businessId, reactedMessageId }, error, 'campaign');
    }
}

// Marks a conversation as needing its lead stage re-classified. Called when a
// lead responds. The follow-up engine's stage classifier only calls OpenAI for
// conversations carrying this stamp (after a short quiet period), so this is
// what turns "poll every minute" into "react to lead activity".
// Overwriting the timestamp on every response is intentional: the classifier
// uses it as a watermark, so a message that arrives mid-classification is not lost.
// Never throws: a failure here must not break message ingestion.
export async function requestStageReview(conversationId, reason = 'responded') {
    if (!conversationId) return;
    try {
        const { error } = await supabase
            .from('conversations')
            .update({ stage_review_requested_at: new Date().toISOString(), stage_review_reason: reason })
            .eq('id', conversationId);
        if (error) throw error;
    } catch (error) {
        logDbFailure('requestStageReview', { conversationId, reason }, error);
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