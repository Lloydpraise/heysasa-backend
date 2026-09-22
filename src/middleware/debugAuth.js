import crypto from 'node:crypto';

// Protects every /debug/* route and the two unauthenticated /instance/*
// routes. Reads the token from (in order): Authorization: Bearer, the
// x-debug-token header, or a ?token= query param — the query param exists
// because the browser's EventSource API cannot send custom headers, and
// the live event stream needs a way in.
export function requireDebugToken(req, res, next) {
    const configuredToken = process.env.DEBUG_TOKEN || '';
    if (!configuredToken) {
        res.status(503).json({ ok: false, error: 'debug_token_not_configured' });
        return;
    }

    const authHeader = req.headers['authorization'] || '';
    const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const suppliedToken = headerToken || req.headers['x-debug-token'] || req.query?.token || null;

    if (!suppliedToken) {
        res.status(401).json({ ok: false, error: 'debug_token_required' });
        return;
    }

    const a = Buffer.from(String(suppliedToken));
    const b = Buffer.from(String(configuredToken));
    const same = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!same) {
        res.status(401).json({ ok: false, error: 'debug_token_invalid' });
        return;
    }

    next();
}
