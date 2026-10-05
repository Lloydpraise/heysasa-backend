// Hands messages to the sender through the chat_ai_outbox table and waits until each one is really sent.
// The AI only learns "sent" when WhatsApp accepted the message, so it never talks about something the customer has not seen.

import type { SendItem, SendResult } from './builtin.ts';

export type OutboxTarget = { businessId: string; conversationId: string; contactId: number };
export type OutboxOptions = { sleep: (ms: number) => Promise<void>; timeoutMs?: number; pollMs?: number; now?: () => number };

export async function enqueueAndWait(
  // deno-lint-ignore no-explicit-any
  db: any, target: OutboxTarget, items: SendItem[], opts: OutboxOptions,
): Promise<SendResult> {
  if (!items.length) return { ok: true, results: [] };
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const pollMs = opts.pollMs ?? 700;
  const now = opts.now ?? Date.now;

  const rows = items.map((item, seq) => ({
    business_id: target.businessId, conversation_id: target.conversationId, contact_id: target.contactId, seq,
    kind: item.media ? 'image' : 'text', text: item.media ? null : (item.text ?? ''), media: item.media ?? null,
  }));
  const { data: inserted, error } = await db.from('chat_ai_outbox').insert(rows).select('id, seq');
  if (error || !inserted?.length) return { ok: false, error: `could not queue the message: ${error?.message ?? 'no rows'}` };
  const idBySeq = new Map<number, string>(inserted.map((r: { id: string; seq: number }) => [r.seq, r.id]));
  const ids = [...idBySeq.values()];

  const deadline = now() + timeoutMs;
  // deno-lint-ignore no-explicit-any
  let latest: any[] = [];
  for (;;) {
    const { data, error: readError } = await db.from('chat_ai_outbox').select('id, status, error, whatsapp_message_id').in('id', ids);
    if (!readError && data) latest = data;
    const open = latest.length < ids.length || latest.some((r) => r.status === 'queued' || r.status === 'sending');
    if (!open) break;
    if (now() >= deadline) {
      // Cancel anything the sender has not started, so it cannot go out late, after the AI has moved on.
      await db.from('chat_ai_outbox').update({ status: 'failed', error: 'timed_out_waiting_for_sender' }).in('id', ids).eq('status', 'queued');
      const { data } = await db.from('chat_ai_outbox').select('id, status, error, whatsapp_message_id').in('id', ids);
      if (data) latest = data;
      break;
    }
    await opts.sleep(pollMs);
  }

  const byId = new Map(latest.map((r) => [r.id, r]));
  const results = items.map((_, seq) => {
    const row = byId.get(idBySeq.get(seq) ?? '');
    if (row?.status === 'sent') return { ok: true, messageId: row.whatsapp_message_id ?? null };
    return { ok: false, error: row?.error || (row?.status === 'sending' ? 'still sending when the wait ended' : 'not sent') };
  });
  return { ok: results.every((r) => r.ok), results, error: results.find((r) => !r.ok)?.error };
}
