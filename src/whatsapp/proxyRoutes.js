// The dashboard's only way to talk to Evolution. The Evolution API key used to be shipped to the browser, which let
// anyone with the website read or send on every business's WhatsApp. Now the browser calls these routes as a signed-in
// owner, and only for instances that belong to that owner's business. Each route mirrors the Evolution path it wraps and
// passes Evolution's answer (and status code) straight back, so the dashboard reads the same shapes as before.
import { Router } from 'express';

const INSTANCE_NAME = /^[A-Za-z0-9_-]{3,80}$/;
// A connection the owner started but never finished (QR not scanned) is removed after this long.
export const ABANDONED_AFTER_MS = 60 * 60_000;

function sendEvolutionError(res, error) {
    const status = Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 502;
    return res.status(status).json(error?.body ?? { message: error?.message || 'evolution_unreachable' });
}

// Each connection belongs to one HeySasa account (one WhatsApp number, see ACCOUNTS.md). The dashboard sends the
// account in X-Account-Id; members only reach the accounts they are assigned to.
function inScope(req, accountId) {
    const scope = req.scope;
    if (!scope) return true;                         // auth without account scope (tests, older callers)
    if (accountId == null) return scope.isAdmin;     // a row from before accounts existed
    if (scope.accountId) return accountId === scope.accountId;
    return scope.accountIds.includes(accountId);
}

// deps: { auth, supabase, evolution(path, options) -> parsed JSON (throws { status, body } on a bad answer), log, now }
export function createWhatsAppProxyRouter({ auth, supabase, evolution, log = () => {}, now = () => Date.now() }) {
    const router = Router();
    router.use(auth);

    // The instance must be one of this business's WhatsApp connections (any status, so a half-finished one can be
    // polled and cancelled). Sets req.session.
    async function owned(req, res, next) {
        const name = String(req.params.name || '');
        if (!INSTANCE_NAME.test(name)) return res.status(400).json({ message: 'invalid_instance_name' });
        const { data, error } = await supabase.from('whatsapp_sessions')
            .select('id, business_id, account_id, instance_name, status, updated_at')
            .eq('instance_name', name).eq('business_id', req.businessId).maybeSingle();
        if (error) return res.status(500).json({ message: 'lookup_failed' });
        if (!data || !inScope(req, data.account_id)) return res.status(404).json({ message: 'instance_not_found' });
        req.session = data;
        return next();
    }

    // Best effort: connections this business started over an hour ago and never finished.
    async function clearAbandoned(businessId) {
        const cutoff = new Date(now() - ABANDONED_AFTER_MS).toISOString();
        const { data } = await supabase.from('whatsapp_sessions').select('id, instance_name, updated_at')
            .eq('business_id', businessId).eq('status', 'pending').lt('updated_at', cutoff);
        // The account stays (pending or disconnected); only the unfinished connection goes.
        for (const row of data || []) {
            try { await evolution(`/instance/delete/${encodeURIComponent(row.instance_name)}`, { method: 'DELETE' }); } catch { /* already gone */ }
            await supabase.from('whatsapp_sessions').delete().eq('id', row.id).eq('status', 'pending');
            log('info', 'whatsapp.abandoned_removed', { businessId, instance: row.instance_name });
        }
    }

    // Starts a new connection for the selected account. The session row is written first (as pending), so webhooks
    // for this instance are recognised from the very first event, even if the owner closes the window early.
    // A business with no account yet gets its first one from the database (whatsapp_sessions_ensure_account).
    router.post('/instance/create', async (req, res) => {
        const name = String(req.body?.instanceName || '');
        if (!INSTANCE_NAME.test(name)) return res.status(400).json({ message: 'invalid_instance_name' });
        const accountId = req.scope?.accountId ?? null;
        if (!accountId && req.scope?.accountIds?.length) return res.status(400).json({ message: 'account_required' });
        await clearAbandoned(req.businessId).catch(() => {});

        if (accountId) {
            const { data: live } = await supabase.from('whatsapp_sessions').select('instance_name')
                .eq('account_id', accountId).eq('status', 'connected').limit(1);
            if (live?.length) return res.status(409).json({ message: 'account_already_connected', instance: live[0].instance_name });
        }
        const { data: taken } = await supabase.from('whatsapp_sessions').select('id').eq('instance_name', name).maybeSingle();
        if (taken) return res.status(409).json({ message: 'instance_name_taken' });
        const { data: row, error } = await supabase.from('whatsapp_sessions')
            .insert({ business_id: req.businessId, account_id: accountId, instance_name: name, status: 'pending', updated_at: new Date(now()).toISOString() })
            .select('id').single();
        if (error || !row) return res.status(500).json({ message: 'could_not_save_connection' });

        try {
            const created = await evolution('/instance/create', {
                method: 'POST',
                body: JSON.stringify({ instanceName: name, integration: 'WHATSAPP-BAILEYS', qrcode: req.body?.qrcode === true }),
            });
            log('info', 'whatsapp.instance_created', { businessId: req.businessId, instance: name });
            return res.status(201).json(created ?? {});
        } catch (evolutionError) {
            await supabase.from('whatsapp_sessions').delete().eq('id', row.id);
            return sendEvolutionError(res, evolutionError);
        }
    });

    router.get('/instance/connect/:name', owned, async (req, res) => {
        const number = String(req.query.number || '').replace(/\D/g, '');
        // The account is locked to the first number that connected it; say so before WhatsApp issues a code.
        if (number && req.session.account_id) {
            const { data: account } = await supabase.from('accounts').select('phone_number').eq('id', req.session.account_id).maybeSingle();
            if (account?.phone_number && account.phone_number !== number.replace(/^0+/, '')) {
                return res.status(409).json({ message: 'phone_mismatch', expected: account.phone_number });
            }
        }
        const query = number ? `?number=${number}` : '';
        try { return res.json(await evolution(`/instance/connect/${encodeURIComponent(req.session.instance_name)}${query}`) ?? {}); }
        catch (error) { return sendEvolutionError(res, error); }
    });

    router.get('/instance/connectionState/:name', owned, async (req, res) => {
        try { return res.json(await evolution(`/instance/connectionState/${encodeURIComponent(req.session.instance_name)}`) ?? {}); }
        catch (error) { return sendEvolutionError(res, error); }
    });

    // Removes the instance from Evolution. A connection that never finished is also removed here; a finished one is
    // removed by the dashboard's own disconnect step, as before.
    router.delete('/instance/delete/:name', owned, async (req, res) => {
        let result = {};
        try { result = await evolution(`/instance/delete/${encodeURIComponent(req.session.instance_name)}`, { method: 'DELETE' }) ?? {}; }
        catch (error) { if (Number(error?.status) !== 404) return sendEvolutionError(res, error); }
        if (req.session.status === 'pending') await supabase.from('whatsapp_sessions').delete().eq('id', req.session.id);
        log('info', 'whatsapp.instance_deleted', { businessId: req.businessId, instance: req.session.instance_name });
        return res.json(result);
    });

    // Only this business's instances, so one owner can never see another's numbers.
    router.get('/instance/fetchInstances', async (req, res) => {
        const { data, error } = await supabase.from('whatsapp_sessions').select('instance_name, account_id').eq('business_id', req.businessId);
        if (error) return res.status(500).json({ message: 'lookup_failed' });
        const mine = new Set((data || []).filter((row) => inScope(req, row.account_id)).map((row) => row.instance_name).filter(Boolean));
        if (!mine.size) return res.json([]);
        try {
            const all = await evolution('/instance/fetchInstances');
            return res.json((Array.isArray(all) ? all : []).filter((instance) => mine.has(instance?.name)));
        } catch (error) { return sendEvolutionError(res, error); }
    });

    const passThrough = (path) => router.post(`/${path}/:name`, owned, async (req, res) => {
        try {
            const body = await evolution(`/${path}/${encodeURIComponent(req.session.instance_name)}`, { method: 'POST', body: JSON.stringify(req.body ?? {}) });
            return res.json(body ?? {});
        } catch (error) { return sendEvolutionError(res, error); }
    });
    passThrough('message/sendText');
    passThrough('chat/findChats');
    passThrough('chat/findMessages');
    passThrough('chat/getBase64FromMediaMessage');

    return router;
}
