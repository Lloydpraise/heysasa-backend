// Every tool the agent can use, in one place. The list is the same for every business (so the prompt cache stays
// warm) and it is the single source of truth: the model's tool list, the owner's "always allow" screen and the tests
// all read it, so none of them can drift from what the tools really do.
import snapshot from './domains/snapshot.js';
import analytics from './domains/analytics.js';
import leads from './domains/leads.js';
import lists from './domains/lists.js';
import campaigns from './domains/campaigns.js';
import followups from './domains/followups.js';
import settings from './domains/settings.js';
import persona from './domains/persona.js';
import chatai from './domains/chatai.js';
import products from './domains/products.js';
import guide from './domains/guide.js';

// Plain-language names for the "always allow" screen and the Activity log filters.
export const ACTION_LABELS = {
  create_list: 'Make a list of people', change_list_members: 'Add or remove people in a list', edit_list: 'Rename or hide a list', set_auto_list: 'Switch auto lists on or off, or tune them',
  launch_campaign: 'Start a campaign', pause_campaign: 'Pause a campaign', resume_campaign: 'Resume a campaign', edit_campaign: 'Change a campaign',
  activate_auto_campaign: 'Start an auto campaign', set_auto_campaign: 'Change an auto campaign',
  approve_followups: 'Approve follow-up messages', reject_followups: 'Skip follow-up messages',
  update_leads: 'Change the state of leads', mark_as_bought: 'Record a sale', run_analysis: 'Study your chats',
  set_followup_settings: 'Change follow-up settings', set_business_info: 'Change business details', set_chat_ai: 'Change the chat AI switch or limits',
  update_persona: 'Change how your AI talks', save_flow: 'Add or change a chat flow', edit_chat_skill: 'Change a chat AI skill',
  change_products: 'Approve, dismiss or hide products', edit_product: 'Change a product\'s price or details', run_product_discovery: 'Look for products in your chats',
};

export const AREA_LABELS = {
  lists: 'Lists', campaigns: 'Campaigns', followups: 'Follow-ups', leads: 'Leads', settings: 'Settings', chat_ai: 'Chat AI', products: 'Products', analysis: 'Studying chats', memory: 'Memory', analytics: 'Analytics', snapshot: 'Overview', guide: 'Guidance',
};

const DOMAINS = [snapshot, analytics, leads, lists, campaigns, followups, settings, persona, chatai, products, guide];
const KINDS = new Set(['read', 'propose', 'ui']);

export function buildRegistry() {
  const tools = DOMAINS.flat();
  const byName = new Map();
  for (const t of tools) {
    if (byName.has(t.name)) throw new Error(`Duplicate agent tool: ${t.name}`);
    if (!KINDS.has(t.kind)) throw new Error(`Tool ${t.name} has a bad kind`);
    if (t.kind === 'propose') {
      if (!['normal', 'critical'].includes(t.risk)) throw new Error(`Tool ${t.name} needs a risk`);
      if (typeof t.plan !== 'function' || typeof t.execute !== 'function') throw new Error(`Tool ${t.name} needs plan and execute`);
      if (!ACTION_LABELS[t.name]) throw new Error(`Tool ${t.name} needs an ACTION_LABELS entry`);
    } else if (typeof t.run !== 'function') throw new Error(`Tool ${t.name} needs run`);
    byName.set(t.name, t);
  }
  return {
    tools, byName,
    // What the model sees. Same order every time.
    modelTools: () => tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
    statusFor: (name) => byName.get(name)?.status ?? null,
    // For the owner's "always allow" screen: only things that can ever be auto-allowed.
    allowable: () => tools.filter((t) => t.kind === 'propose').map((t) => ({ type: t.name, label: ACTION_LABELS[t.name], area: t.area, area_label: AREA_LABELS[t.area] ?? t.area, critical: t.risk === 'critical' })),
  };
}
