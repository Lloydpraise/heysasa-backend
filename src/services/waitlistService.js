import { supabase } from '../config/supabase.js';
import { normalizeKenyanPhone } from '../utils/phone.js';
import { logEvent } from './debugConsole.js';

// The HeySasa business itself (business_type 'heysasa'). Waitlist people become
// contacts of this business so the normal auto-list + auto-campaign machinery
// can message them, and their replies land like any other business's.
const HEYSASA_BUSINESS_ID = process.env.HEYSASA_BUSINESS_ID || 'heysasa';
const WAITLIST_RULE_ID = 'waitinglist';

const INDUSTRIES = new Set([
    'beauty_wellness', 'retail_ecommerce', 'restaurant_food', 'fashion_apparel',
    'real_estate', 'education', 'health_medical', 'professional_services',
    'automotive', 'electronics', 'agriculture', 'other',
]);

// Simple in-memory rate limit — 5 signups per IP per hour. Resets on
// deploy, which is fine: this exists to blunt a script hammering the
// endpoint, not to be a durable security control.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60_000;
const attemptsByIp = new Map();

function isRateLimited(ip) {
    const now = Date.now();
    const attempts = (attemptsByIp.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    attempts.push(now);
    attemptsByIp.set(ip, attempts);
    return attempts.length > RATE_LIMIT_MAX;
}

function generateRefCode() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function isPlausibleWebsite(value) {
    if (!value) return true; // optional field
    const trimmed = value.trim();
    if (trimmed.length > 200) return false;
    // Lenient on purpose — "instagram.com/mybrand" and "mybrand.co.ke"
    // are both real answers people give here, not just https:// URLs.
    return /^[a-z0-9.-]+\.[a-z]{2,}([/?#].*)?$/i.test(trimmed) || /^https?:\/\//i.test(trimmed);
}

export async function createWaitlistSignup(body, ip) {
    if (isRateLimited(ip)) {
        return { ok: false, status: 429, error: 'too_many_requests' };
    }

    // Honeypot: a field named to look legitimate to a bot filling every
    // input it finds, invisible to a real visitor (styled off-screen in
    // the form). Any value in it means it wasn't a person.
    if (body.company_website_hp) {
        logEvent({ level: 'debug', area: 'waitlist', event: 'waitlist.blocked', message: 'Honeypot triggered' });
        // Return success anyway — telling a bot it was caught just
        // teaches it to try again differently.
        return { ok: true, status: 200, data: { position: 1, refCode: 'XXXXXX' } };
    }

    const name = String(body.name || '').trim().slice(0, 80);
    const businessName = String(body.business || body.business_name || '').trim().slice(0, 120);
    const industry = String(body.industry || '').trim();
    const website = body.website ? String(body.website).trim().slice(0, 200) : null;
    const phone = normalizeKenyanPhone(body.phone);

    if (name.length < 2) return { ok: false, status: 400, error: 'name_required' };
    if (businessName.length < 2) return { ok: false, status: 400, error: 'business_required' };
    if (!INDUSTRIES.has(industry)) return { ok: false, status: 400, error: 'industry_invalid' };
    if (!phone) return { ok: false, status: 400, error: 'phone_invalid' };
    if (!isPlausibleWebsite(website)) return { ok: false, status: 400, error: 'website_invalid' };
    // Nobody gets messaged on WhatsApp unless they ticked the box, and we keep the record.
    if (body.consent_whatsapp !== true) return { ok: false, status: 400, error: 'consent_required' };

    // Dedupe on phone — someone re-submitting (double-tap, or joining
    // twice out of eagerness) gets their existing spot back, not a
    // second row.
    const { data: existing, error: lookupError } = await supabase
        .from('waitlist_leads')
        .select('id, created_at')
        .eq('phone', phone)
        .maybeSingle();
    if (lookupError) {
        logEvent({ level: 'error', area: 'waitlist', event: 'waitlist.lookup_failed', message: lookupError.message });
        return { ok: false, status: 500, error: 'lookup_failed' };
    }

    if (existing) {
        const position = await getPositionForCreatedAt(existing.created_at);
        const { data: row } = await supabase.from('waitlist_leads').select('ref_code').eq('id', existing.id).maybeSingle();
        logEvent({ level: 'info', area: 'waitlist', event: 'waitlist.duplicate', message: `${phone} already on the list`, details: { position } });
        return { ok: true, status: 200, data: { position, refCode: row?.ref_code || null } };
    }

    const refCode = generateRefCode();
    const referredBy = body.ref ? String(body.ref).trim().slice(0, 12) : null;

    const { data: inserted, error: insertError } = await supabase
        .from('waitlist_leads')
        .insert({
            name, business_name: businessName, industry, phone, website,
            ref_code: refCode, referred_by: referredBy,
            consent_whatsapp: true, consent_at: new Date().toISOString(),
            utm_source: body.utm_source || null, utm_medium: body.utm_medium || null,
            utm_campaign: body.utm_campaign || null, fbclid: body.fbclid || null,
        })
        .select('id, created_at')
        .single();

    if (insertError) {
        // A unique-constraint race (two rapid submits for the same phone)
        // lands here too — treat it the same as "already on the list".
        if (insertError.code === '23505') {
            const { data: row } = await supabase.from('waitlist_leads').select('id, ref_code, created_at').eq('phone', phone).maybeSingle();
            const position = row ? await getPositionForCreatedAt(row.created_at) : null;
            return { ok: true, status: 200, data: { position, refCode: row?.ref_code || null } };
        }
        logEvent({ level: 'error', area: 'waitlist', event: 'waitlist.insert_failed', message: insertError.message, details: { businessName, industry } });
        return { ok: false, status: 500, error: 'insert_failed' };
    }

    // Best effort: never fail a signup because the welcome plumbing had a problem.
    try {
        await attachContactAndEnroll(inserted.id, { name, phone });
    } catch (error) {
        logEvent({ level: 'error', area: 'waitlist', event: 'waitlist.enroll_failed', message: error.message, details: { leadId: inserted.id } });
    }

    const position = await getPositionForCreatedAt(inserted.created_at);
    logEvent({ level: 'ok', area: 'waitlist', event: 'waitlist.signup', message: `New signup: ${businessName} (${industry})`, details: { position, hasWebsite: !!website, referredBy: !!referredBy } });

    return { ok: true, status: 201, data: { position, refCode } };
}

async function getPositionForCreatedAt(createdAt) {
    const { count } = await supabase
        .from('waitlist_leads')
        .select('id', { count: 'exact', head: true })
        .lte('created_at', createdAt);
    return count || 1;
}

export async function getWaitlistCount() {
    const { count } = await supabase.from('waitlist_leads').select('id', { count: 'exact', head: true });
    return count || 0;
}

// Creates (or finds) the person as a contact of the HeySasa business, links it to
// the waitlist row, then does the same enrolment the 10-minute list sweep and the
// 5-minute campaign seeder would do, so the welcome goes out within about a minute
// instead of up to 15. If the list or campaign is not switched on yet, it simply
// stops here and the sweep picks the person up later. Each person starts at message 1.
async function attachContactAndEnroll(leadId, { name, phone }) {
    const plusPhone = `+${phone}`;
    let { data: contact, error: findError } = await supabase
        .from('contacts').select('id')
        .eq('business_id', HEYSASA_BUSINESS_ID).in('phone', [phone, plusPhone]).limit(1).maybeSingle();
    if (findError) throw new Error(`contact lookup failed: ${findError.message}`);

    if (!contact) {
        const { data: created, error: createError } = await supabase
            .from('contacts')
            .insert({ business_id: HEYSASA_BUSINESS_ID, name, phone: plusPhone, country_code: '254', lead_state: 'new' })
            .select('id').single();
        if (createError) throw new Error(`contact create failed: ${createError.message}`);
        contact = created;
    }

    const { error: linkError } = await supabase.from('waitlist_leads').update({ contact_id: contact.id }).eq('id', leadId);
    if (linkError) throw new Error(`waitlist link failed: ${linkError.message}`);

    const { data: list } = await supabase.from('lists').select('id')
        .eq('business_id', HEYSASA_BUSINESS_ID).eq('rule_id', WAITLIST_RULE_ID).eq('type', 'auto').eq('archived', false).maybeSingle();
    if (!list) return;

    const member = await supabase.from('list_members').insert({ list_id: list.id, lead_id: contact.id });
    if (member.error && member.error.code !== '23505') throw new Error(`list member failed: ${member.error.message}`);

    const { data: campaign } = await supabase.from('campaigns').select('id')
        .eq('business_id', HEYSASA_BUSINESS_ID).eq('list_id', list.id).eq('kind', 'auto').eq('status', 'active').maybeSingle();
    if (!campaign) return;

    const enrol = await supabase.from('campaign_enrollments')
        .insert({ campaign_id: campaign.id, lead_id: contact.id, status: 'pending', current_step: 0, next_send_at: null });
    if (enrol.error && enrol.error.code !== '23505' && enrol.error.code !== 'P0001') throw new Error(`enrol failed: ${enrol.error.message}`);
}
