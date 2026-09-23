export function requireDebugToken(req, res, next) {
    const configuredToken = process.env.DEBUG_TOKEN;

    if (!configuredToken) {
        return res.status(503).json({ ok: false, error: 'debug_token_not_configured' });
    }

    const rawHeaderToken = req.headers['x-debug-token'];
    const headerToken = Array.isArray(rawHeaderToken)
        ? rawHeaderToken[0]
        : rawHeaderToken;

    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const queryToken = typeof req.query?.token === 'string' ? req.query.token : null;
    const providedToken = (typeof headerToken === 'string' ? headerToken.trim() : '') || bearerToken || queryToken;

    if (!providedToken || providedToken !== configuredToken) {
        return res.status(401).json({ ok: false, error: 'invalid_debug_token' });
    }

    return next();
}

export default requireDebugToken;
