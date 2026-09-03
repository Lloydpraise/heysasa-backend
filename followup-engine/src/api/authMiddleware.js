import { supabase } from '../supabaseClient.js'

// Verifies the Supabase Auth JWT sent by the dashboard, then resolves
// which business this user owns and attaches it as req.businessId.
//
// ASSUMPTION: businesses has an owner_user_id column matching
// auth.users.id. If your ownership lookup works differently (a
// separate profiles/user_businesses table, a custom JWT claim, etc.),
// swap the query below — everything downstream just reads
// req.businessId.
export async function requireBusinessAuth(req, res, next) {
  const authHeader = req.headers.authorization ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return res.status(401).json({ error: 'missing_auth_token' })

  const { data: userData, error: userErr } = await supabase.auth.getUser(token)
  if (userErr || !userData?.user) return res.status(401).json({ error: 'invalid_auth_token' })

  const { data: business, error: bizErr } = await supabase
    .from('businesses')
    .select('business_id')
    .eq('owner_user_id', userData.user.id)
    .single()

  if (bizErr || !business) return res.status(403).json({ error: 'no_business_for_user' })

  req.businessId = business.business_id
  req.userId = userData.user.id
  next()
}