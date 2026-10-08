// Where Ask HeySasa was opened from. The surface decides, in code (not by asking the model, which would cost a round trip):
//   audience  customer -> a customer will read the result, so the persona pack is loaded and the AI writes in the owner's voice
//             owner    -> only the owner or the AI reads it, so the persona pack is NOT loaded and the AI stays plain,
//                         which keeps it a neutral thinking partner for the owner
//   skills    skills loaded up front for this surface
//   draft     shape of the draft block

export const SURFACES = {
  campaign_message: {
    label: 'a message in a campaign sequence',
    audience: 'customer',
    skills: ['copywriting', 'campaign_message_writing', 'message_safety'],
    draft: 'text',
  },
  auto_campaign_playbook: {
    label: 'the "how to follow up" playbook of an auto-campaign',
    audience: 'owner',
    skills: ['auto_campaign_playbook'],
    draft: 'text',
  },
  flow: {
    label: 'a chat AI flow',
    audience: 'owner',
    skills: ['flow_instructions_writing'],
    draft: 'flow',
  },
  product_description: {
    label: 'a product in the catalog',
    audience: 'customer',
    skills: ['product_description_writing', 'copywriting'],
    draft: 'text',
  },
  general: {
    label: 'a general chat with the owner',
    audience: 'owner',
    skills: ['plain_language', 'owner_discovery'],
    draft: 'text',
    agent: true,
  },
};

export const isSurface = (value) => Object.prototype.hasOwnProperty.call(SURFACES, value);

// Context comes from the browser, so it is untrusted: keep only plain values, cap sizes, and cap the total.
const MAX_STRING = 700;
const MAX_ITEMS = 12;
const MAX_TOTAL = 5000;

function clean(value, depth) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 3) return undefined;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => clean(v, depth + 1)).filter((v) => v !== undefined);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 20)) {
      if (!/^[a-zA-Z0-9_]{1,40}$/.test(k)) continue;
      const c = clean(v, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

export function sanitizeContext(raw) {
  const out = clean(raw, 0) ?? {};
  return JSON.stringify(out).length > MAX_TOTAL ? {} : out;
}

export function renderContext(context) {
  const lines = [];
  for (const [key, value] of Object.entries(context ?? {})) {
    const label = key.replace(/_/g, ' ');
    if (Array.isArray(value)) {
      if (!value.length) continue;
      lines.push(`${label}:`);
      for (const item of value) lines.push(`  - ${typeof item === 'object' ? JSON.stringify(item) : item}`);
    } else if (typeof value === 'object') {
      lines.push(`${label}: ${JSON.stringify(value)}`);
    } else if (String(value).trim()) {
      lines.push(`${label}: ${value}`);
    }
  }
  return lines.join('\n');
}
