// The model writes a short chat reply for the owner, then (only when it wrote something to use) ONE draft block:
//
//   Here is a softer version.
//   <draft>the message text</draft>
//
// For a flow the block holds tags: <draft><name>..</name><goal>..</goal><instructions>..</instructions><skills>a,b</skills></draft>
//
// This file splits that text, both live (while it streams, so the chat reply can appear word by word) and at the end.

const OPEN = '<draft';

// How many characters at the end of `text` could be the start of "<draft" (so we hold them back until we know).
function partialOpenLength(text) {
  const max = Math.min(OPEN.length - 1, text.length);
  for (let n = max; n > 0; n--) {
    if (OPEN.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

export function createStreamParser({ onReply = () => {}, onDraftStart = () => {} } = {}) {
  let buffer = '';
  let emitted = 0;
  let inDraft = false;
  let streamedAnything = false;

  return {
    feed(chunk) {
      if (!chunk) return;
      buffer += chunk;
      if (inDraft) return;
      const at = buffer.indexOf(OPEN);
      if (at >= 0) {
        const text = buffer.slice(emitted, at);
        if (text) { streamedAnything = true; onReply(text); }
        emitted = at;
        inDraft = true;
        onDraftStart();
        return;
      }
      const safeEnd = buffer.length - partialOpenLength(buffer);
      if (safeEnd > emitted) {
        streamedAnything = true;
        onReply(buffer.slice(emitted, safeEnd));
        emitted = safeEnd;
      }
    },
    finish() {
      if (!inDraft && emitted < buffer.length) {
        streamedAnything = true;
        onReply(buffer.slice(emitted));
        emitted = buffer.length;
      }
      return { text: buffer, streamedAnything };
    },
  };
}

const tag = (raw, name) => {
  const m = raw.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : '';
};

// Full model text -> { reply, draft } where draft is null or {type:'text', text} / {type:'flow', name, goal, instructions, skill_keys}.
export function parseModelOutput(fullText, { draftType = 'text', validSkillKeys = null } = {}) {
  const text = String(fullText ?? '');
  const at = text.indexOf(OPEN);
  if (at < 0) return { reply: text.trim(), draft: null };

  const reply = text.slice(0, at).trim();
  const after = text.slice(at);
  const close = after.search(/<\/draft>/i);
  // A missing closing tag means the model was cut off; use what we have rather than lose it.
  const innerStart = after.indexOf('>') + 1;
  const inner = (close >= 0 ? after.slice(innerStart, close) : after.slice(innerStart)).trim();
  if (!inner) return { reply, draft: null };

  if (draftType === 'flow') {
    const name = tag(inner, 'name');
    const goal = tag(inner, 'goal');
    const instructions = tag(inner, 'instructions');
    if (!instructions) return { reply: reply || 'I could not finish the flow. Try again?', draft: null };
    const skillKeys = tag(inner, 'skills').split(',').map((k) => k.trim()).filter((k) => /^[a-z0-9_]{2,40}$/.test(k));
    const keys = validSkillKeys ? skillKeys.filter((k) => validSkillKeys.includes(k)) : skillKeys;
    return { reply, draft: { type: 'flow', name, goal, instructions, skill_keys: [...new Set(keys)] } };
  }
  // Models sometimes wrap the message in quotes or fences even when told not to.
  const cleaned = inner.replace(/^```[a-z]*\n?|\n?```$/gi, '').replace(/^"([\s\S]*)"$/, '$1').trim();
  return { reply, draft: cleaned ? { type: 'text', text: cleaned } : null };
}

// Text form of a draft, for rebuilding the history the model sees.
export function draftAsText(draft) {
  if (!draft) return '';
  if (draft.type === 'flow') {
    return `Name: ${draft.name}\nGoal: ${draft.goal}\nInstructions: ${draft.instructions}${draft.skill_keys?.length ? `\nSkills: ${draft.skill_keys.join(', ')}` : ''}`;
  }
  return draft.text ?? '';
}
