// "Let HeySasa do it" on a lead: writes the next WhatsApp message for this one lead, in the business's voice, from the
// chat so far, the lead brief and the approved products. The owner sees it in the chat box and decides whether to send.
// Nothing is sent from here.
import { Router } from 'express';
import { forAccount } from '../middleware/accessScope.js';
import { loadActivePack } from '../personaPack.js';

const HISTORY = 20;
const MAX_PRODUCTS = 15;

const asText = (value) => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return value.text || value.caption || value.summary || value.plan || JSON.stringify(value);
    return String(value);
};

export function buildDraftPrompt({ businessName, persona, contact, goal, messages, products }) {
    const voice = persona ? JSON.stringify({
        voice: persona.voice_and_tone ?? persona.voice ?? persona.tone ?? null,
        business: persona.business_context ?? null,
        closing: persona.handoff_and_closing ?? null,
    }).slice(0, 3000) : '';
    const system = [
        `You write one WhatsApp message that ${businessName || 'the business'} will send to a customer.`,
        'Write as the business owner would: warm, short (under 60 words), plain, one clear ask, no more than one emoji.',
        'Use the same language mix the customer uses (English, Swahili or Sheng).',
        'Only mention prices, stock, delivery details or offers that appear in the products list or the chat. Never invent them.',
        'No placeholders, no brackets, no "as an AI". Reply with the message text only.',
        voice && `How this business talks: ${voice}`,
    ].filter(Boolean).join('\n');
    const chat = messages.map((m) => `${m.direction === 'in' ? 'Customer' : 'Business'}: ${asText(m.content).slice(0, 400)}`).join('\n');
    const catalog = products.map((p) => `- ${p.title}${p.price != null ? `: ${p.price}` : ''}`).join('\n');
    const user = [
        `Customer name: ${contact.name || 'unknown'}`,
        contact.lead_state && `Where things stand: ${contact.lead_state}`,
        contact.lead_summary && `Lead brief: ${asText(contact.lead_summary).slice(0, 800)}`,
        contact.product_interests && `Interested in: ${asText(contact.product_interests).slice(0, 300)}`,
        `Goal of this message: ${asText(goal).slice(0, 400) || 'move the conversation one step closer to a sale'}`,
        catalog && `Products (approved by the owner):\n${catalog}`,
        chat ? `Chat so far (oldest first):\n${chat}` : 'There is no chat history yet.',
    ].filter(Boolean).join('\n\n');
    return { system, user };
}

// deps: { auth, supabase, callModel({ systemPrompt, userContent, businessId, accountId }) -> text | null,
//         canAfford(businessId, accountId), check(text, ctx) }
// The lead belongs to one WhatsApp account (ACCOUNTS.md): it must be in the request's scope, and the voice (persona
// pack, falling back to the business-wide pack), products and billing are that account's.
export function createLeadDraftRouter({ auth, supabase, callModel, canAfford, check = () => ({ passed: true }), log = () => {} }) {
    const router = Router();
    router.post('/leads/:id/draft', auth, async (req, res, next) => {
        try {
            const leadId = Number(req.params.id);
            if (!Number.isSafeInteger(leadId) || leadId <= 0) return res.status(400).json({ error: 'invalid_lead' });
            const businessId = req.businessId;

            const { data: contact } = await forAccount(supabase.from('contacts')
                .select('id, business_id, account_id, name, lead_state, lead_summary, next_action_plan, product_interests, do_not_contact')
                .eq('id', leadId).eq('business_id', businessId), req.scope).maybeSingle();
            if (!contact) return res.status(404).json({ error: 'not_found', message: 'That lead no longer exists.' });
            if (contact.do_not_contact) return res.status(409).json({ error: 'do_not_contact', message: 'This person asked not to be contacted.' });
            const accountId = contact.account_id ?? null;
            if (!(await canAfford(businessId, accountId))) return res.status(402).json({ error: 'no_balance', message: 'Your balance is empty. Top up to let HeySasa write for you.' });

            let productsQuery = supabase.from('products').select('title, price').eq('business_id', businessId).eq('status', 'approved');
            if (accountId) productsQuery = productsQuery.or(`account_id.eq.${accountId},account_id.is.null`);   // the account's own + the shared catalog
            const [{ data: business }, persona, { data: history }, { data: products }] = await Promise.all([
                supabase.from('businesses').select('name').eq('business_id', businessId).maybeSingle(),
                loadActivePack(supabase, businessId, accountId, 'pack').catch(() => ({ pack: null })),
                supabase.from('messages').select('direction, content, created_at').eq('contact_id', leadId)
                    .order('created_at', { ascending: false }).limit(HISTORY),
                productsQuery.order('mention_count', { ascending: false }).limit(MAX_PRODUCTS),
            ]);
            const personaRow = { pack: persona.pack };
            const messages = [...(history || [])].reverse();
            const goal = req.body?.goal || contact.next_action_plan;
            const { system, user } = buildDraftPrompt({ businessName: business?.name, persona: personaRow?.pack, contact, goal, messages, products: products || [] });

            let text = String(await callModel({ systemPrompt: system, userContent: user, businessId, accountId }) || '').trim().replace(/^"(.*)"$/s, '$1');
            if (!text) return res.status(503).json({ error: 'ai_unavailable', message: 'HeySasa could not write this message right now. Try again in a minute.' });

            // The same service standard every follow-up passes (no invented prices, no placeholders...). The owner still
            // reviews it, so a warning is returned rather than the message being thrown away.
            const contextText = [products?.map((p) => `${p.title} ${p.price ?? ''}`).join('\n'), messages.map((m) => asText(m.content)).join('\n')].join('\n');
            const quality = check(text, { contextText });
            const usedProducts = (products || []).filter((p) => p.title && text.toLowerCase().includes(String(p.title).toLowerCase())).map((p) => p.title);
            log('info', 'lead.draft_written', { businessId, accountId, leadId, passed: quality.passed });
            return res.json({ ok: true, text, usedProducts, quality: { passed: quality.passed, issues: quality.issues || [] } });
        } catch (error) {
            return next(error);
        }
    });
    return router;
}
