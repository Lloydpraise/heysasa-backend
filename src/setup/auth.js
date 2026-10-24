import { scopeOrRespond } from '../middleware/accessScope.js';

// Signed-in user -> the business they asked for (body businessId, X-Business-Id or ?businessId), guessing only
// when they can open exactly one. Owners (user_id or owner_email) and active team members pass. Also resolves
// the WhatsApp account and leaves the full scope on req.scope (see accessScope.js). Sends the error response and
// returns null when access is refused.
export async function resolveBusinessId(req, res, options = {}) {
    const scope = await scopeOrRespond(req, res, options);
    return scope ? scope.businessId : null;
}
