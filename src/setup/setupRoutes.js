// Onboarding routes for the frontend:
//   POST /setup/start    the one button: runs the whole setup (returns at once, work continues in the background)
//   GET  /setup/status   what Home shows while setup runs (progress, plain message, counters, "home ready")
//   POST /setup/answers  the few easy questions (opening hours, hand-off rule, "is this what you sell?")
import express from 'express';
import { supabase } from '../config/supabase.js';
import { NON_CUSTOMER_TYPES } from '../../followup-engine/src/lib/leadTypes.js';
import { createOrchestrator } from './setupOrchestrator.js';
import { buildSetupDeps } from './setupDeps.js';
import { shapeSetupStatus } from './setupStatus.js';
import { validateAnswers } from './answers.js';
import { resolveBusinessId } from './auth.js';

const router = express.Router();
const deps = buildSetupDeps();
const orchestrator = createOrchestrator(deps);


const countOf = async (query) => {
    const { count, error } = await query;
    return error ? 0 : (count || 0);
};

async function countsFor(businessId) {
    const contacts = () => supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('business_id', businessId);
    const [chats, customers, filteredOut, analysed, readyToBuy, products] = await Promise.all([
        countOf(contacts()),
        countOf(contacts().eq('lead_type', 'business')),
        countOf(contacts().in('lead_type', [...NON_CUSTOMER_TYPES])),
        countOf(contacts().eq('lead_type', 'business').not('nlp_enriched_at', 'is', null)),
        // "Ready to buy" = the Hot tab on the Leads page: intent score 70 or more, not already won or lost.
        countOf(contacts().eq('lead_type', 'business').gte('intent_score', 70).not('lead_state', 'in', '(won,lost)')),
        countOf(supabase.from('products').select('id', { count: 'exact', head: true }).eq('business_id', businessId).in('status', ['discovered', 'approved'])),
    ]);
    return { chats, customers, filtered_out: filteredOut, analysed, ready_to_buy: readyToBuy, products };
}

router.post('/setup/start', async (req, res, next) => {
    try {
        const businessId = await resolveBusinessId(req, res);
        if (!businessId) return;
        const result = await orchestrator.start(businessId, { restart: req.body?.restart === true });
        return res.status(202).json({ ok: true, started: result.started, reason: result.reason || null });
    } catch (error) { return next(error); }
});

router.get('/setup/status', async (req, res, next) => {
    try {
        const businessId = await resolveBusinessId(req, res);
        if (!businessId) return;
        const setup = await deps.store.get(businessId);
        const [counts, run] = await Promise.all([
            countsFor(businessId),
            setup?.status === 'running' ? deps.latestRun(businessId, setup.started_at || new Date(0).toISOString()) : null,
        ]);
        return res.json(shapeSetupStatus({ setup, run, counts }));
    } catch (error) { return next(error); }
});

router.post('/setup/answers', async (req, res, next) => {
    try {
        const businessId = await resolveBusinessId(req, res);
        if (!businessId) return;
        const checked = validateAnswers(req.body);
        if (checked.error) return res.status(400).json({ ok: false, error: checked.error });
        const { products, ...rest } = checked.value;

        if (products?.approve.length) {
            await supabase.from('products').update({ status: 'approved', approved_at: new Date().toISOString() })
                .eq('business_id', businessId).eq('status', 'discovered').in('id', products.approve);
        }
        if (products?.dismiss.length) {
            await supabase.from('products').update({ status: 'dismissed' })
                .eq('business_id', businessId).eq('status', 'discovered').in('id', products.dismiss);
        }
        const existing = await deps.store.get(businessId);
        const answers = { ...(existing?.answers || {}), ...rest, ...(products ? { products_checked: true } : {}) };
        await deps.store.upsert(businessId, { answers });
        return res.json({ ok: true, answers });
    } catch (error) { return next(error); }
});

// Call once after the server starts: a restart kills in-flight runs, so pick up setups that went quiet.
export async function resumeSetups({ quietMinutes = 3 } = {}) {
    const before = new Date(Date.now() - quietMinutes * 60_000).toISOString();
    const { data } = await supabase.from('business_setup').select('business_id')
        .in('status', ['waiting_history', 'running', 'home_ready', 'finishing']).lt('updated_at', before);
    for (const row of data || []) await orchestrator.start(row.business_id);
    return (data || []).length;
}

export default router;
