import { supabase } from '../config/supabase.js';

// Signed-in owner -> their business. Accepts the business in the body, X-Business-Id or ?businessId, and only
// guesses when the owner has exactly one.
//
// "Owns" means either of these is true on the businesses row:
//   - user_id equals the signed-in user's id   (what the app uses to list a user's businesses)
//   - owner_email equals their email, ignoring case (older rows; many rows have this empty)
const sameEmail = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

async function ownedBusinesses(user, businessId = null) {
    let byUser = supabase.from('businesses').select('business_id, user_id, owner_email').eq('user_id', user.id);
    let byEmail = user.email
        ? supabase.from('businesses').select('business_id, user_id, owner_email').ilike('owner_email', user.email.trim())
        : null;
    if (businessId) {
        byUser = byUser.eq('business_id', businessId);
        if (byEmail) byEmail = byEmail.eq('business_id', businessId);
    }
    const [u, e] = await Promise.all([byUser, byEmail || Promise.resolve({ data: [], error: null })]);
    if (u.error && e.error) return { error: u.error, rows: [] };
    const seen = new Map();
    for (const row of [...(u.data || []), ...(e.data || [])]) {
        const owns = row.user_id === user.id || sameEmail(row.owner_email, user.email);
        if (owns) seen.set(row.business_id, row);
    }
    return { error: null, rows: [...seen.values()] };
}

export async function resolveBusinessId(req, res) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token) { res.status(401).json({ ok: false, error: 'missing_auth_token' }); return null; }
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.id) { res.status(401).json({ ok: false, error: 'invalid_auth_token' }); return null; }
    const user = userData.user;

    const requested = [req.body?.businessId, req.headers['x-business-id'], req.query?.businessId]
        .find((v) => typeof v === 'string' && v.trim());
    if (requested) {
        const { error, rows } = await ownedBusinesses(user, requested.trim());
        if (error || !rows.length) { res.status(403).json({ ok: false, error: 'business_not_owned' }); return null; }
        return rows[0].business_id;
    }
    const { error, rows } = await ownedBusinesses(user);
    if (error || !rows.length) { res.status(403).json({ ok: false, error: 'no_business_for_user' }); return null; }
    if (rows.length > 1) { res.status(400).json({ ok: false, error: 'business_id_required' }); return null; }
    return rows[0].business_id;
}