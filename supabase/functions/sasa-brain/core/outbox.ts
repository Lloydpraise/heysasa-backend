// Hands messages to the sender through the chat_ai_outbox table and waits until each one is really sent.
// The AI only learns "sent" when WhatsApp accepted the message, so it never talks about something the customer has not seen.
//
// The two halves can be used apart: `enqueue` returns as soon as the rows are saved, and `waitForDelivery` blocks until the
// sender has finished with them. That lets the turn keep thinking while photos are on their way, and still check that they
// landed before the written message goes out.

import type { SendItem, SendResult } from './builtin.ts';

export type OutboxTarget = { businessId: string; conversationId: string; contactId: number };
export type OutboxOptions = { timeoutMs?: number };
export type Queued = { ids: string[]; idBySeq: Map<number, string>; count: number };

export async function enqueue(
  // deno-lint-ignore no-explicit-any
  db: any, target: OutboxTarget, items: SendItem[],
): Promise<{ ok: true; queued: Queued } | { ok: false; error: string }> {
  const rows = items.map((item, seq) => ({
    business_id: target.businessId, conversation_id: target.conversationId, contact_id: target.contactId, seq,
    kind: item.media ? 'image' : 'text', text: item.media ? null : (item.text ?? ''), media: item.media ?? null,
  }));
  const { data: inserted, error } = await db.from('chat_ai_outbox').insert(rows).select('id, seq');
  if (error || !inserted?.length) return { ok: false, error: `could not queue the message: ${error?.message ?? 'no rows'}` };
  const idBySeq = new Map<number, string>(inserted.map((r: { id: string; seq: number }) => [r.seq, r.id]));
  return { ok: true, queued: { ids: [...idBySeq.values()], idBySeq, count: items.length } };
}

export async function waitForDelivery(
  // deno-lint-ignore no-explicit-any
  db: any, queued: Queued,   opts: OutboxOptions = {},
): Promise<SendResult> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const { ids, idBySeq, count } = queued;

  return new Promise((resolve, reject) => {
    // deno-lint-ignore no-explicit-any
    let latest: any[] = [];
    let settled = false;
    let refreshing = false;
    let refreshAgain = false;
    let timeout: ReturnType<typeof setTimeout>;
    // deno-lint-ignore no-explicit-any
    let channel: any;

    const cleanup = () => {
      clearTimeout(timeout);
      void db.removeChannel(channel);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const byId = new Map(latest.map((r) => [r.id, r]));
      const results = Array.from({ length: count }, (_, seq) => {
        const row = byId.get(idBySeq.get(seq) ?? '');
        if (row?.status === 'sent') return { ok: true, messageId: row.whatsapp_message_id ?? null };
        return { ok: false, error: row?.error || (row?.status === 'sending' ? 'still sending when the wait ended' : 'not sent') };
      });
      resolve({ ok: results.every((r) => r.ok), results, error: results.find((r) => !r.ok)?.error });
    };
    const refresh = () => {
      if (settled) return;
      if (refreshing) { refreshAgain = true; return; }
      refreshing = true;
      void (async () => {
        do {
          refreshAgain = false;
          const { data, error } = await db.from('chat_ai_outbox')
            .select('id, status, error, whatsapp_message_id').in('id', ids);
          if (error) throw error;
          latest = data ?? [];
          const open = latest.length < ids.length || latest.some((r) => r.status === 'queued' || r.status === 'sending');
          if (!open) { finish(); return; }
        } while (refreshAgain && !settled);
      })().catch(fail).finally(() => {
        refreshing = false;
        if (refreshAgain && !settled) refresh();
      });
    };

    channel = db.channel(`chat-ai-delivery-${crypto.randomUUID()}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'chat_ai_outbox', filter: `id=in.(${ids.join(',')})`,
      }, refresh);
    timeout = setTimeout(() => {
      void (async () => {
        // Do not let a queued message be sent after the AI has already moved on.
        const { error } = await db.from('chat_ai_outbox').update({ status: 'failed', error: 'timed_out_waiting_for_sender' })
          .in('id', ids).eq('status', 'queued');
        if (error) throw error;
        refresh();
      })().catch(fail);
    }, timeoutMs);

    channel.subscribe((status: string) => {
      if (status === 'SUBSCRIBED') refresh();
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        fail(new Error(`Chat AI delivery notifications unavailable: ${status}`));
      }
    });
  });
}

export async function enqueueAndWait(
  // deno-lint-ignore no-explicit-any
  db: any, target: OutboxTarget, items: SendItem[], opts: OutboxOptions = {},
): Promise<SendResult> {
  if (!items.length) return { ok: true, results: [] };
  const queued = await enqueue(db, target, items);
  if (!queued.ok) return { ok: false, error: queued.error };
  return waitForDelivery(db, queued.queued, opts);
}
