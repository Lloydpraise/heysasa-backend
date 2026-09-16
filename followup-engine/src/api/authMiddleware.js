import { supabase } from '../supabaseClient.js'

// Verifies the Supabase Auth JWT sent by the dashboard, then confirms
// the caller actually owns the business it's asking to act on.
//
// One login can own several businesses (confirmed: lloydpraise33's
// account owns lashesbyshazz, kisasacraft-581e69, and vvstudios-e2b2c2
// simultaneously) — so the business can't be derived from the token
// alone. The frontend sends which one it means via X-Business-Id;
// this just checks that business.user_id actually matches the caller.
export async function requireBusinessAuth(req, res, next) {
  const authHeader = req.headers.authorization ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'missing_auth_token' })

  const requestedBusinessId = req.headers['x-business-id']
  if (!requestedBusinessId) return res.status(400).json({ error: 'missing_business_id_header' })

  const { data: userData, error: userErr } = await supabase.auth.getUser(token)
  if (userErr || !userData?.user) return res.status(401).json({ error: 'invalid_auth_token' })

  const { data: business, error: bizErr } = await supabase
    .from('businesses')
    .select('business_id')
    .eq('business_id', requestedBusinessId)
    .eq('user_id', userData.user.id)
    .maybeSingle()

  if (bizErr) return res.status(500).json({ error: bizErr.message })
  if (!business) return res.status(403).json({ error: 'no_business_for_user' })

  req.businessId = business.business_id
  req.userId = userData.user.id
  next()
}