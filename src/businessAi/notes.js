// The owner's memory.
//
// Two tiers, so notes never have to ride in every prompt:
//   1. PINNED: a small set of stable core facts, capped by PIN_BUDGET characters, injected into every prompt.
//   2. EVERYTHING ELSE: embedded as a vector and found again with the recall_notes tool (and once, automatically,
//      on the first turn of a conversation). Pinned notes are embedded too, so recall also finds them.
//
// Saving a near-duplicate updates the existing note instead of adding a second copy. If the pinned set outgrows
// its budget, the least recently used pinned notes are un-pinned (not deleted): they stay recallable.

export const PIN_BUDGET = 1500;
export const DUPLICATE_SIMILARITY = 0.9;
export const MAX_NOTE = 400;

const normalise = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);

// Pinned notes that fit in the budget, newest first; the rest are returned as `overflow`.
export function fitPinned(pinned, budget = PIN_BUDGET) {
  const sorted = [...pinned].sort((a, b) => String(b.last_used_at || b.updated_at).localeCompare(String(a.last_used_at || a.updated_at)));
  const keep = [];
  const overflow = [];
  let used = 0;
  for (const note of sorted) {
    if (used + note.text.length <= budget) { keep.push(note); used += note.text.length; } else overflow.push(note);
  }
  return { keep, overflow };
}

export function createNotes({ store, embed, log = () => {} }) {
  async function trimPins(businessId) {
    const { overflow } = fitPinned(await store.pinnedNotes(businessId));
    for (const note of overflow) await store.updateNote(note.id, businessId, { pinned: false });
    return overflow.length;
  }

  return {
    async save({ businessId, text, pinned = false, conversationId = null, source = 'ai' }) {
      const clean = normalise(text);
      if (clean.length < 3) return { status: 'ignored', reason: 'too short' };

      let vector = null;
      try { vector = await embed(clean, businessId); } catch (error) { log('warn', `note saved without an embedding: ${error.message}`); }

      if (vector) {
        const near = (await store.matchNotes(businessId, vector, 1, DUPLICATE_SIMILARITY))[0];
        if (near) {
          await store.updateNote(near.id, businessId, { text: clean, embedding: vector, pinned: pinned || near.pinned });
          if (pinned) await trimPins(businessId);
          return { status: 'updated', id: near.id };
        }
      }
      const row = await store.insertNote({
        business_id: businessId, text: clean, pinned, embedding: vector, source, source_conversation_id: conversationId,
      });
      if (pinned) await trimPins(businessId);
      return { status: 'saved', id: row.id };
    },

    // The pinned notes that go into every prompt.
    async pinnedForPrompt(businessId) {
      return fitPinned(await store.pinnedNotes(businessId)).keep;
    },

    async recall({ businessId, query, count = 6, threshold = 0.3 }) {
      const q = normalise(query);
      if (!q) return [];
      let found;
      try {
        found = await store.matchNotes(businessId, await embed(q, businessId), count, threshold);
      } catch (error) {
        // No embedding available: fall back to the newest notes rather than failing the whole turn.
        log('warn', `recall fell back to recent notes: ${error.message}`);
        found = await store.recentNotes(businessId, count);
      }
      await store.touchNotes(found.map((n) => n.id));
      return found.map((n) => ({ id: n.id, text: n.text, pinned: !!n.pinned }));
    },

    // Owner edits from Preferences.
    async edit({ businessId, id, text, pinned }) {
      const patch = {};
      if (text !== undefined) {
        patch.text = normalise(text);
        if (patch.text.length < 3) return { status: 'invalid' };
        try { patch.embedding = await embed(patch.text, businessId); } catch (error) { log('warn', `edited note has no embedding: ${error.message}`); patch.embedding = null; }
      }
      if (pinned !== undefined) patch.pinned = !!pinned;
      const row = await store.updateNote(id, businessId, patch);
      if (!row) return { status: 'not_found' };
      if (patch.pinned) await trimPins(businessId);
      return { status: 'updated' };
    },
  };
}
