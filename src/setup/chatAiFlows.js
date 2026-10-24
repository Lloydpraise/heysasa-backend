// Gives a business the chat AI's starting flow, so ad leads get a plan made for them the moment chat is switched on.
// A flow says who it is for (the code checks that, the AI never picks) and what to aim for. Skills are the how-to pages it uses.
// Safe to run twice: a flow that setup already made is left exactly as it is, so the owner's edits are never overwritten.

const AD_FLOW = {
    name: 'Ad leads',
    priority: 50,                       // below any flow the owner makes for one specific ad or list
    trigger: { any_ad: true },          // any lead that came from an ad (see sasa-brain/core/flows.ts)
    goal: 'Turn the ad enquiry into an order, or a call with the owner.',
    instructions: [
        'This person found you through an ad, so they are asking about what the ad showed. Reply warmly and keep it short.',
        'Use the ad details you have to know which product they mean. If it is not clear, ask which one.',
        'Answer their question. Give a price only if it is in your product information, then move them one step closer: ask for the quantity, the delivery place, or a good time to talk.',
        'Never invent prices, stock or discounts. If they are ready to pay or ask for a real person, hand over to the owner.',
    ].join(' '),
    skill_keys: ['first_reply', 'product_enquiry', 'price_question', 'objections', 'order_details', 'delivery'],
};

// Pure. Returns the rows still to add. `existing` = the business's own flows, `skillKeys` = the skills it really has.
export function planFlowSeed(existing = [], skillKeys = []) {
    const have = new Set((existing || []).filter((f) => f.created_via === 'setup').map((f) => f.name));
    const keys = new Set(skillKeys || []);
    return [AD_FLOW]
        .filter((flow) => !have.has(flow.name))
        .map((flow) => ({ ...flow, skill_keys: flow.skill_keys.filter((k) => keys.has(k)), enabled: true, created_via: 'setup' }));
}

// Flows and skills belong to one WhatsApp account (ACCOUNTS.md); accountId narrows both and is stamped on new rows.
export async function seedChatAiFlows(supabase, businessId, accountId = null) {
    const onAccount = (query) => (accountId ? query.eq('account_id', accountId) : query);
    const [flows, skills] = await Promise.all([
        onAccount(supabase.from('chat_flows').select('name, created_via').eq('business_id', businessId)),
        onAccount(supabase.from('chat_ai_skills').select('key').eq('business_id', businessId).eq('enabled', true)),
    ]);
    if (flows.error) throw new Error(`chat flows unreadable: ${flows.error.message}`);
    if (skills.error) throw new Error(`chat skills unreadable: ${skills.error.message}`);
    const rows = planFlowSeed(flows.data, (skills.data || []).map((s) => s.key)).map((row) => ({ ...row, business_id: businessId, ...(accountId ? { account_id: accountId } : {}) }));
    if (rows.length) {
        const { error } = await supabase.from('chat_flows').insert(rows);
        if (error) throw new Error(`chat flows not saved: ${error.message}`);
    }
    return { added: rows.length };
}
