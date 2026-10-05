// The chat AI's gates. Pure functions: no database, no network, easy to test.
// The AI is only ever called when every gate passes. The AI cannot talk its way past them,
// because they run before it exists.

export const STALE_MESSAGE_MINUTES = 10;
const BLOCKED_LEAD_TYPES = new Set(['personal', 'vendor', 'staff', 'junk']);
const BLOCKED_CONTACT_ROLES = new Set(['vendor', 'staff', 'owner']);

export const SKIP_MESSAGES = {
  from_me: 'Message was sent by the business.',
  group_or_broadcast: 'Groups and broadcasts are never answered.',
  unsupported_type: 'Only text messages are answered for now.',
  empty_message: 'The message had no text.',
  stale_message: 'The message is too old to answer naturally.',
  switch_off: 'Chat AI is switched off for this business.',
  subscription_inactive: 'The subscription is not active.',
  cap_zero: 'The daily chat limit is 0.',
  chat_paused: 'The AI is paused for this chat.',
  handed_off: 'This chat was handed off to the owner.',
  personal_chat: 'This looks like a personal chat, not a customer.',
  not_a_customer: 'This contact is a vendor, staff member or junk, not a customer.',
  owner_active: 'The owner replied recently, so the AI stays quiet.',
  chat_busy: 'The AI is already working on this chat.',
  cap_reached: 'The daily chat limit is used up.',
  no_balance: 'The wallet balance is empty, so the AI is paused.',
  no_brain: 'The AI brain is not installed yet.',
};

const asDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Checks that need no database read beyond the business row. Cheap, run first.
export function evaluateMessageGates({ message, business, now = new Date() }) {
  if (message.isFromMe) return { allow: false, reason: 'from_me' };
  if (message.isGroupOrBroadcast) return { allow: false, reason: 'group_or_broadcast' };
  if (message.type !== 'text') return { allow: false, reason: 'unsupported_type' };
  if (!String(message.text || '').trim()) return { allow: false, reason: 'empty_message' };

  const sentAt = asDate(message.sentAt);
  if (sentAt && now.getTime() - sentAt.getTime() > STALE_MESSAGE_MINUTES * 60_000) return { allow: false, reason: 'stale_message' };

  if (!business || business.chat_ai_enabled !== true) return { allow: false, reason: 'switch_off' };
  if (business.subscription_active === false) return { allow: false, reason: 'subscription_inactive' };
  if (!(Number(business.chat_ai_daily_cap) > 0)) return { allow: false, reason: 'cap_zero' };
  return { allow: true };
}

// Checks that need the conversation, contact and the owner's recent activity.
export function evaluateChatGates({ conversation, contact, lastOwnerMessageAt, business, now = new Date() }) {
  if (!conversation) return { allow: false, reason: 'chat_paused' };
  if (conversation.ai_enabled === false) return { allow: false, reason: 'chat_paused' };
  if (conversation.handover_flag === true && !conversation.handover_resolved_at) return { allow: false, reason: 'handed_off' };
  if (conversation.is_business_chat === false) return { allow: false, reason: 'personal_chat' };

  const leadType = String(contact?.lead_type || '').toLowerCase();
  const role = String(contact?.contact_role || '').toLowerCase();
  if (BLOCKED_LEAD_TYPES.has(leadType) && leadType !== 'personal') return { allow: false, reason: 'not_a_customer' };
  if (leadType === 'personal') return { allow: false, reason: 'personal_chat' };
  if (BLOCKED_CONTACT_ROLES.has(role)) return { allow: false, reason: 'not_a_customer' };

  const pauseMinutes = Number(business?.chat_ai_human_pause_minutes ?? 60);
  const ownerAt = asDate(lastOwnerMessageAt);
  if (ownerAt && pauseMinutes > 0 && now.getTime() - ownerAt.getTime() < pauseMinutes * 60_000) return { allow: false, reason: 'owner_active' };

  return { allow: true };
}
