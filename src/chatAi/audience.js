// Who the chat AI may talk to. The owner picks one or more groups; the code checks it before the AI is called.
//   ads = leads that came from an ad,  hot = leads ready to buy (intent score 70+, same as the Hot tab),  all = every business lead.
// No choice saved (older businesses) means "all", so nothing that worked yesterday goes quiet today.

export const AUDIENCES = ['ads', 'hot', 'all'];
export const HOT_SCORE = 70;
export const DEFAULT_AUDIENCE = ['ads', 'hot'];   // what the owner is offered when switching on

// Returns a clean list of known groups, or null when nothing valid was given.
export function cleanAudience(value) {
  if (!Array.isArray(value)) return null;
  const picked = [...new Set(value.map((v) => String(v).toLowerCase()).filter((v) => AUDIENCES.includes(v)))];
  return picked.length ? picked : null;
}

// What is saved on the business -> the groups that apply right now.
export function audienceOf(settings) {
  return cleanAudience(settings?.audience) || ['all'];
}

export function isHotLead(contact) {
  const score = Number(contact?.intent_score);
  const state = String(contact?.lead_state || '').toLowerCase();
  return Number.isFinite(score) && score >= HOT_SCORE && state !== 'won' && state !== 'lost';
}

// A chat the AI has already been answering keeps being answered, even if the lead stops matching half way
// (an intent score can drop in the middle of a conversation; going quiet then would look like a bug).
export function audienceAllows(audience, contact, { aiHasReplied = false } = {}) {
  const groups = cleanAudience(audience) || ['all'];
  if (groups.includes('all')) return true;
  if (aiHasReplied) return true;
  if (groups.includes('ads') && (contact?.is_ad_lead === true || Boolean(contact?.ad_id))) return true;
  if (groups.includes('hot') && isHotLead(contact)) return true;
  return false;
}

export function describeAudience(audience) {
  const groups = cleanAudience(audience) || ['all'];
  if (groups.includes('all')) return 'every customer who writes to you';
  const parts = [];
  if (groups.includes('ads')) parts.push('people who came from your ads');
  if (groups.includes('hot')) parts.push('people who are ready to buy');
  return parts.join(' and ');
}
