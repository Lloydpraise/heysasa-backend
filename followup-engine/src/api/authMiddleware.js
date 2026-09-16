import { supabase } from '../supabaseClient.js'

// Verifies the Supabase Auth JWT sent by the dashboard, then resolves
// which business this user owns and attaches it as req.businessId.
//
// businesses.user_id holds the Supabase Auth user id of the owner
// (confirmed against real data — lashesbyshazz, kisasacraft-581e69,
// vvstudios-e2b2c2 all have it set correctly). Some older/test rows
// have a null user_id and won't resolve here; that's expected.
export async function requireBusinessAuth(req, res, next) {
  const authHeader = req.headers.authorization ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'missing_auth_token' })

  const { data: userData, error: userErr } = await supabase.auth.getUser(token)
  if (userErr || !userData?.user) return res.status(401).json({ error: 'invalid_auth_token' })

  const { data: business, error: bizErr } = await supabase
    .from('businesses')
    .select('business_id')
    .eq('user_id', userData.user.id)
    .single()

  if (bizErr || !business) return res.status(403).json({ error: 'no_business_for_user' })

  req.businessId = business.business_id
  req.userId = userData.user.id
  next()
}