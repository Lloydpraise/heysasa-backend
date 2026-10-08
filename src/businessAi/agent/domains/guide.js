// Guiding the owner: where things are in the dashboard, including the things the assistant is NOT allowed to do itself.
import { ToolError } from '../helpers.js';

// `nav` is what the dashboard's "Take me there" button opens. Keep the tab ids in sync with AppShell.jsx and the
// preferences sections with preferencesConfig.js.
export const PLACES = {
  analytics: { label: 'Analytics', nav: { tab: 'analytics' }, steps: ['Open Analytics from the menu.', 'Use the tabs at the top to switch between the different views.'] },
  leads: { label: 'Leads', nav: { tab: 'leads' }, steps: ['Open Leads from the menu.', 'Tap a person to see their chat, what we know about them and their follow-up.'] },
  lists: { label: 'Lists', nav: { tab: 'lists-campaigns' }, steps: ['Open Campaigns from the menu.', 'Pick the Lists tab at the top.'] },
  auto_lists: { label: 'Auto lists and auto campaigns', nav: { tab: 'lists-campaigns' }, steps: ['Open Campaigns from the menu.', 'Pick the Automations tab at the top.', 'Each auto list has a switch and a ready-made campaign.'] },
  campaigns: { label: 'Campaigns', nav: { tab: 'lists-campaigns' }, steps: ['Open Campaigns from the menu.', 'Pick the Campaigns tab at the top to see each campaign and how it is doing.'] },
  products: { label: 'Products', nav: { tab: 'products' }, steps: ['Open Products from the menu.', 'Products found in your chats wait there for you to approve.'] },
  playground: { label: 'Playground (test and teach your AI)', nav: { tab: 'playground' }, steps: ['Open Playground from the menu.', 'You can test your AI there, and see its flows and skills.'] },
  followup_settings: { label: 'Follow-up settings', nav: { tab: 'preferences', section: 'followup' }, steps: ['Open Preferences from the menu.', 'Pick Follow-up.'] },
  materials: { label: 'Materials', nav: { tab: 'preferences', section: 'materials' }, steps: ['Open Preferences from the menu.', 'Pick Materials.'] },
  business_info: { label: 'Business details', nav: { tab: 'preferences', section: 'business' }, steps: ['Open Preferences from the menu.', 'Pick Business.'] },
  whatsapp: { label: 'WhatsApp connection', nav: { tab: 'preferences', section: 'whatsapp' }, steps: ['Open Preferences from the menu.', 'Pick WhatsApp.', 'Scan the QR code with the phone that has your business WhatsApp (WhatsApp, then Linked devices).'] },
  billing: { label: 'Balance and top-up', nav: { tab: 'preferences', section: 'billing' }, steps: ['Open Preferences from the menu.', 'Pick Billing to see your balance, your usage, and to top up.'] },
  assistant_settings: { label: 'Ask HeySasa settings', nav: { tab: 'preferences', section: 'assistant' }, steps: ['Open Preferences from the menu.', 'Pick Ask HeySasa to see what I remember and my skills.'] },
  // Things the assistant will not do itself. The owner does these; the guide says where.
  disconnect_whatsapp: { label: 'Disconnect WhatsApp', nav: { tab: 'preferences', section: 'whatsapp' }, steps: ['Open Preferences, then WhatsApp.', 'Use the disconnect option there. Only you can do this, because it stops all your messages.'] },
  top_up: { label: 'Top up your balance', nav: { tab: 'preferences', section: 'billing' }, steps: ['Open Preferences, then Billing.', 'Choose an amount and pay. I cannot handle payments for you.'] },
  delete_lead: { label: 'Delete a lead', nav: { tab: 'leads' }, steps: ['Open Leads and tap the person.', 'Look for the delete option on their page. Only you can delete people, because it cannot be undone.'] },
  message_a_lead: { label: 'Message one person yourself', nav: { tab: 'leads' }, steps: ['Open Leads and tap the person.', 'Type in their chat box. I do not send one-to-one messages for you, so each one is really from you.'] },
};

const guide_user = {
  name: 'guide_user', area: 'guide', kind: 'ui', status: 'Finding that for you…',
  description: 'Show the owner where something is in the dashboard, with a "Take me there" button. Use it for things only the owner can do (scanning the WhatsApp QR code, topping up, deleting a lead, disconnecting WhatsApp, sending a one-to-one message) and whenever you point them to a page. Then explain in a sentence what they will find.',
  parameters: { type: 'object', properties: { place: { type: 'string', enum: Object.keys(PLACES) } }, required: ['place'], additionalProperties: false },
  async run(ctx, { place }) {
    const p = PLACES[place];
    if (!p) throw new ToolError('I do not know that place.');
    ctx.emit?.({ type: 'guide', place, label: p.label, steps: p.steps, nav: p.nav });
    return { shown: true, place: p.label, steps: p.steps, note: 'The owner now sees a Take me there button. Do not repeat the steps word for word.' };
  },
};

export default [guide_user];
