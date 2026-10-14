import { supabase } from '../config/supabase.js';

// Signed-in owner -> their business. Accepts the business in the body, X-Business-Id or ?businessId, and only
// guesses when the owner has exactly one. Same rules as the analysis and product routes.
export async function resolveBusinessId(req, res) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token) { res.status(401).json({ ok: false, error: 'missing_auth_token' }); return null; }
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user?.email) { res.status(401).json({ ok: false, error: 'invalid_auth_token' }); return null; }
    const email = userData.user.email;

    const requested = [req.body?.businessId, req.headers['x-business-id'], req.query?.businessId]
        .find((v) => typeof v === 'string' && v.trim());
    if (requested) {
        const { data, error } = await supabase.from('businesses').select('business_id')
            .eq('business_id', requested.trim()).eq('owner_email', email).maybeSingle();
        if (error || !data) { res.status(403).json({ ok: false, error: 'business_not_owned' }); return null; }
        return data.business_id;
    }
    const { data, error } = await supabase.from('businesses').select('business_id').eq('owner_email', email).limit(2);
    if (error || !data?.length) { res.status(403).json({ ok: false, error: 'no_business_for_user' }); return null; }
    if (data.length > 1) { res.status(400).json({ ok: false, error: 'business_id_required' }); return null; }
    return data[0].business_id;
}

