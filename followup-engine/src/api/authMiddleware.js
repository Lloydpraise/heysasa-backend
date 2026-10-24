// Verifies the Supabase Auth JWT sent by the dashboard, then confirms the caller may open the business in
// X-Business-Id (owner, or an active team member) and resolves the WhatsApp account in X-Account-Id.
// Shared with the main backend (see src/middleware/accessScope.js and ACCOUNTS.md). Sets req.scope,
// req.businessId, req.accountId and req.userId.
export { requireScope as requireBusinessAuth, requireAccountScope, requireBusinessAdmin, forAccount, forAccountOrShared } from '../../../src/middleware/accessScope.js'
