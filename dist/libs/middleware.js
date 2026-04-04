// ────────────────────────────────────────────────────────────
//  middleware — Express/Connect-compatible peer context extractor
// ────────────────────────────────────────────────────────────
// ── IP extraction (mirrors ip-devicer header priority) ────────
/**
 * Resolve the real client IP from request headers using the same priority
 * chain as `ip-devicer`:
 *
 * CF-Connecting-IP → True-Client-IP → X-Real-IP → X-Forwarded-For → remoteAddress
 *
 * Defers to `req.resolvedIp` (set by ip-devicer middleware) when available.
 */
export function resolveIp(req) {
    // If ip-devicer has already resolved the IP, use it
    const enriched = req;
    if (enriched.resolvedIp)
        return enriched.resolvedIp;
    function first(v) {
        if (!v)
            return undefined;
        const raw = Array.isArray(v) ? v[0] : v;
        const trimmed = raw?.trim();
        return trimmed?.length ? trimmed : undefined;
    }
    const cf = first(req.headers['cf-connecting-ip']);
    if (cf)
        return cf;
    const tci = first(req.headers['true-client-ip']);
    if (tci)
        return tci;
    const xri = first(req.headers['x-real-ip']);
    if (xri)
        return xri;
    const xff = first(req.headers['x-forwarded-for']);
    if (xff) {
        const firstIp = xff.split(',')[0]?.trim();
        if (firstIp?.length)
            return firstIp;
    }
    return req.socket.remoteAddress ?? 'unknown';
}
// ── Context extraction ────────────────────────────────────────
/**
 * Extract a {@link PeerIdentifyContext} from an incoming request.
 *
 * - `ip`         — resolved via {@link resolveIp}
 * - `userId`     — reads the `x-user-id` header as a convenience; callers
 *                  should override after authentication if needed
 * - `tlsProfile` — defers to `req.tlsProfile` (set by tls-devicer middleware)
 *                  then falls back to `x-ja4` / `x-ja3` proxy headers
 */
export function extractPeerContext(req) {
    const ip = resolveIp(req);
    const tlsReq = req;
    const ja4 = tlsReq.tlsProfile?.ja4 ??
        req.headers['x-ja4'] ??
        req.headers['cf-ja4'];
    const ja3 = tlsReq.tlsProfile?.ja3 ??
        req.headers['x-ja3'];
    const userId = req.headers['x-user-id'];
    const ctx = { ip };
    if (userId)
        ctx.userId = userId;
    if (ja4 || ja3)
        ctx.tlsProfile = { ja4, ja3 };
    return ctx;
}
// ── Middleware factory ────────────────────────────────────────
/**
 * Create an Express/Connect-compatible middleware that attaches a
 * `PeerIdentifyContext` to `req.peerContext` on every request.
 *
 * ### Setup
 * ```ts
 * // Register ip-devicer and tls-devicer middleware first so their enriched
 * // fields (req.resolvedIp, req.tlsProfile) are available here.
 * app.use(createIpMiddleware());
 * app.use(createTlsMiddleware());
 * app.use(createPeerMiddleware());
 *
 * app.post('/identify', async (req, res) => {
 *   const result = await deviceManager.identify(req.body, req.peerContext);
 * });
 * ```
 */
export function createPeerMiddleware() {
    return function peerMiddleware(req, _res, next) {
        req.peerContext = extractPeerContext(req);
        next();
    };
}
//# sourceMappingURL=middleware.js.map