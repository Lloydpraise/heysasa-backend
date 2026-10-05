// Picks the flow for a chat. Pure: the AI never chooses a flow, the rules do.

export type Flow = {
  id: string; name: string; enabled: boolean; priority: number;
  trigger: { ad_ids?: string[]; list_ids?: string[] } | null;
  goal: string | null; instructions: string; skill_keys: string[]; created_at?: string;
};

export type FlowSubject = {
  stickyFlowId?: string | null;
  adIds: Array<string | null | undefined>;
  listIds: string[];
};

export function flowMatches(flow: Flow, subject: FlowSubject): boolean {
  const trigger = flow.trigger ?? {};
  const ads = (trigger.ad_ids ?? []).map(String);
  const lists = (trigger.list_ids ?? []).map(String);
  if (ads.length === 0 && lists.length === 0) return false; // a flow with no criteria never matches by accident
  const hasAd = subject.adIds.filter(Boolean).some((id) => ads.includes(String(id)));
  const hasList = subject.listIds.some((id) => lists.includes(String(id)));
  return hasAd || hasList;
}

// A chat keeps its flow once it has one (so a lead who later joins another list is not switched mid-chat),
// as long as that flow is still enabled. Otherwise the highest-priority matching flow wins; ties go to the oldest.
export function pickFlow(flows: Flow[], subject: FlowSubject): Flow | null {
  const enabled = flows.filter((f) => f.enabled);
  if (subject.stickyFlowId) {
    const sticky = enabled.find((f) => f.id === subject.stickyFlowId);
    if (sticky) return sticky;
  }
  const matching = enabled.filter((f) => flowMatches(f, subject));
  if (!matching.length) return null;
  matching.sort((a, b) => (b.priority - a.priority) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || a.id.localeCompare(b.id));
  return matching[0];
}
