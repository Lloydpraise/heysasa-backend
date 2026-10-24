// Who may call the brain for which WhatsApp number (account). See ACCOUNTS.md "People" and "Requests".
// Pure database reads, no Deno APIs, so the rules can be tested with a fake database.

export type Access = { ok: true; accountId: string | null; role: 'owner' | 'admin' | 'member' } | { ok: false; status: number; error: string };
export type LiveAccount = { ok: true; accountId: string | null } | { ok: false; status: number; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const denied = (status: number, error: string) => ({ ok: false as const, status, error });

// A signed-in dashboard user (the Playground). Allowed: the owner (businesses.user_id) and active team members
// (business_users). Admins may use every account of the business; members only the accounts assigned to them
// (business_user_accounts). The account comes from the x-account-id header or the body. With none given, the user's only
// account is used (or the business's only account); several to choose from is 400 account_required.
export async function resolveUserAccess(
  // deno-lint-ignore no-explicit-any
  db: any, opts: { userId: string; businessId: string; accountId?: string | null },
): Promise<Access> {
  const { userId, businessId } = opts;
  const requested = opts.accountId ? String(opts.accountId).trim() : null;
  if (requested && !UUID.test(requested)) return denied(400, 'invalid account id');

  const [owned, member, accounts] = await Promise.all([
    db.from('businesses').select('business_id').eq('business_id', businessId).eq('user_id', userId).maybeSingle(),
    db.from('business_users').select('id, role').eq('business_id', businessId).eq('user_id', userId).eq('status', 'active').maybeSingle(),
    db.from('accounts').select('id, status').eq('business_id', businessId).neq('status', 'closed'),
  ]);
  for (const r of [owned, member, accounts]) if (r.error) return denied(500, 'Could not check access to this business.');

  const role = owned.data ? 'owner' : member.data ? (member.data.role === 'admin' ? 'admin' : 'member') : null;
  if (!role) return denied(403, 'forbidden');

  const businessAccounts: string[] = (accounts.data ?? []).map((a: { id: string }) => a.id);
  let allowed = businessAccounts;
  if (role === 'member') {
    const { data: assigned, error } = await db.from('business_user_accounts').select('account_id').eq('business_user_id', member.data.id);
    if (error) return denied(500, 'Could not check access to this business.');
    const mine = new Set((assigned ?? []).map((a: { account_id: string }) => a.account_id));
    allowed = businessAccounts.filter((id) => mine.has(id));
  }

  if (requested) {
    if (!businessAccounts.includes(requested)) return denied(403, 'This account does not belong to this business.');
    if (!allowed.includes(requested)) return denied(403, 'forbidden');
    return { ok: true, accountId: requested, role };
  }
  // A business from before accounts has none: the business itself is the scope (owners and admins only).
  if (!businessAccounts.length) return role === 'member' ? denied(403, 'forbidden') : { ok: true, accountId: null, role };
  if (allowed.length === 1) return { ok: true, accountId: allowed[0], role };
  if (!allowed.length) return denied(403, 'forbidden');
  return denied(400, 'account_required');
}

// A live turn from the backend (service role). The conversation decides the account: a caller that sent none gets the
// conversation's, and one that disagrees with the conversation is refused so a reply can never go out on the wrong number.
export async function resolveLiveAccount(
  // deno-lint-ignore no-explicit-any
  db: any, input: { business_id: string; account_id?: string | null; conversation_id?: string | null },
): Promise<LiveAccount> {
  if (!input.conversation_id) return { ok: true, accountId: input.account_id ?? null };
  const { data, error } = await db.from('conversations').select('account_id, business_id').eq('id', input.conversation_id).maybeSingle();
  if (error) return denied(500, `could not load the conversation: ${error.message}`);
  if (!data || data.business_id !== input.business_id) return denied(404, 'conversation not found for this business');
  const fromConversation = data.account_id ?? null;
  if (input.account_id && fromConversation && input.account_id !== fromConversation) return denied(400, 'account_id does not match the conversation');
  return { ok: true, accountId: fromConversation ?? input.account_id ?? null };
}
