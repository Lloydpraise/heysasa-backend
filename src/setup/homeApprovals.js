// Groups everything that waits for the owner's OK into a few cards, so Home can show "Approve" once per plan
// instead of once per message. Pure: no database.

const clip = (text, n = 200) => String(text || '').trim().slice(0, n);

// messages:  follow_up_queue rows awaiting approval ({ id, campaign_id, draft_message, qc_passed, scheduled_at })
// campaigns: [{ id, name }]       playbooks: ad playbooks waiting for review ([{ id, ad_id, auto_headline, override_headline }])
export function groupApprovals({ messages = [], campaigns = [], playbooks = [] }) {
    const names = new Map(campaigns.map((c) => [String(c.id), c.name]));
    const byKey = new Map();
    for (const m of messages) {
        const key = m.campaign_id ? String(m.campaign_id) : 'other';
        if (!byKey.has(key)) {
            byKey.set(key, { kind: 'messages', key, campaign_id: m.campaign_id ?? null, title: names.get(key) || 'Follow-up messages', count: 0, blocked: 0, samples: [], first_at: m.scheduled_at || null });
        }
        const g = byKey.get(key);
        g.count += 1;
        if (m.qc_passed === false) g.blocked += 1;                       // failed the quality check: the owner must open it
        else if (g.samples.length < 3 && clip(m.draft_message)) g.samples.push(clip(m.draft_message));
        if (m.scheduled_at && (!g.first_at || m.scheduled_at < g.first_at)) g.first_at = m.scheduled_at;
    }
    const messageGroups = [...byKey.values()].sort((a, b) => String(a.first_at).localeCompare(String(b.first_at)));
    const playbookGroups = playbooks.map((p) => ({
        kind: 'playbook', key: String(p.id), playbook_id: p.id, ad_id: p.ad_id ?? null,
        title: clip(p.override_headline || p.auto_headline, 80) || 'Your ad', count: 1,
    }));
    return {
        total_messages: messages.length,
        total_playbooks: playbooks.length,
        groups: [...playbookGroups, ...messageGroups],   // the plan comes first: its messages only exist after it is approved
    };
}
