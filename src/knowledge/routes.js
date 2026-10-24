// Routes behind the Knowledge section of the persona pack. `auth` (requireBusinessAuth = the shared scope) checks the
// signed-in user may open X-Business-Id (owner, admin or team member) and resolves the WhatsApp account. The selected
// account sees its own sources plus the shared business catalog; a file added while an account is explicitly
// selected (X-Account-Id) belongs to that account, otherwise it is shared (ACCOUNTS.md rule 6).
//
//   GET    /knowledge             the business's sources
//   POST   /knowledge             save a source: { title, use_case, kind, used_by, ... } + { text } or { storage_path, file_name, mime_type, size_bytes }
//   PATCH  /knowledge/:id         change title, use case, kind, who uses it, on/off (a typed note can also change its text)
//   POST   /knowledge/:id/retry   analyse again after a failure
//   GET    /knowledge/:id/url     a ten-minute link to the original file
//   DELETE /knowledge/:id

import express from 'express';

const reply = (res, result, okBody = {}) => (result.ok
    ? res.json({ ok: true, ...okBody, ...(result.id ? { id: result.id } : {}), ...(result.url ? { url: result.url } : {}) })
    : res.status(result.status || 400).json({ ok: false, error: result.error }));

// The account the dashboard explicitly selected (header or body), not the one a single-account business resolves to,
// so files added without picking an account stay in the shared catalog.
const explicitAccountId = (req) => {
    const raw = req.headers?.['x-account-id'] ?? req.body?.accountId;
    return typeof raw === 'string' && raw.trim() && req.accountId === raw.trim() ? req.accountId : null;
};

export function createKnowledgeRouter({ auth, service }) {
    const router = express.Router();
    router.use(auth);

    router.get('/', async (req, res, next) => {
        try { return res.json({ ok: true, sources: await service.list(req.businessId, req.scope) }); } catch (error) { return next(error); }
    });

    router.post('/', async (req, res, next) => {
        try { return reply(res, await service.create({ businessId: req.businessId, userId: req.userId, input: req.body ?? {}, accountId: explicitAccountId(req) })); } catch (error) { return next(error); }
    });

    router.patch('/:id', async (req, res, next) => {
        try { return reply(res, await service.update({ businessId: req.businessId, id: req.params.id, patch: req.body ?? {}, scope: req.scope })); } catch (error) { return next(error); }
    });

    router.post('/:id/retry', async (req, res, next) => {
        try { return reply(res, await service.retry({ businessId: req.businessId, id: req.params.id, scope: req.scope })); } catch (error) { return next(error); }
    });

    router.get('/:id/url', async (req, res, next) => {
        try { return reply(res, await service.signedUrl({ businessId: req.businessId, id: req.params.id, scope: req.scope })); } catch (error) { return next(error); }
    });

    router.delete('/:id', async (req, res, next) => {
        try { return reply(res, await service.remove({ businessId: req.businessId, id: req.params.id, scope: req.scope })); } catch (error) { return next(error); }
    });

    return router;
}
