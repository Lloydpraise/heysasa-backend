import { supabase } from '../config/supabase.js';

// Verifies the Supabase Auth JWT from the dashboard, then confirms the caller owns the business named in
// X-Business-Id (businesses.user_id must match the signed-in user). Same rule as the follow-up engine's middleware.
export async function requireBusinessAuth(req, res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return res.status(401).json({ ok: false, error: 'missing_auth_token' });

    const businessId = typeof req.headers['x-business-id'] === 'string' ? req.headers['x-business-id'].trim() : '';
    if (!businessId) return res.status(400).json({ ok: false, error: 'missing_business_id' });

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) return res.status(401).json({ ok: false, error: 'invalid_auth_token' });

    const { data: business, error } = await supabase.from('businesses').select('business_id').eq('business_id', businessId).eq('user_id', userData.user.id).maybeSingle();
    if (error) return res.status(500).json({ ok: false, error: 'lookup_failed' });
    if (!business) return res.status(403).json({ ok: false, error: 'no_business_for_user' });

    req.businessId = business.business_id;
    req.userId = userData.user.id;
    return next();
  } catch (error) {
    return next(error);
  }
}
