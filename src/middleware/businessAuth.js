import { requireScope } from './accessScope.js';

// Verifies the Supabase Auth JWT from the dashboard and that the caller may open the business named in
// X-Business-Id (owner, or an active team member), then resolves the WhatsApp account (X-Account-Id).
// Sets req.scope, req.businessId, req.accountId and req.userId. See accessScope.js and ACCOUNTS.md.
export const requireBusinessAuth = requireScope;
