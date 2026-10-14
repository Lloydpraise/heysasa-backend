// An optional one-time starter balance for a new owner, so the first setup can write plans and the "Aha!" message can
// happen. OFF by default: set SETUP_STARTER_CREDIT_USD (for example 1) to switch it on. Pure decision, no database.

export function starterAmountFromEnv(env = process.env) {
    const amount = Number(env.SETUP_STARTER_CREDIT_USD);
    return Number.isFinite(amount) && amount > 0 ? Math.min(amount, 50) : 0;   // never more than 50 USD by mistake
}

// balanceUsd: null means the business has no wallet row yet.
export function decideStarterCredit({ amountUsd, alreadyGiven, balanceUsd, businessType }) {
    if (!(amountUsd > 0)) return { grant: false, reason: 'off' };
    if (alreadyGiven) return { grant: false, reason: 'already_given' };
    if (businessType === 'heysasa') return { grant: false, reason: 'free_business' };
    if (balanceUsd === null || balanceUsd === undefined) return { grant: false, reason: 'no_wallet' };
    if (Number(balanceUsd) > 0) return { grant: false, reason: 'has_balance' };
    return { grant: true, reason: 'new_owner', amountUsd };
}
