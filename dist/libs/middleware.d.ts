import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PeerIdentifyContext } from '../types.js';
/** Express/Connect-style continuation callback used by the peer middleware. */
export type NextFunction = (err?: unknown) => void;
/** Request object after all three middlewares have run. */
export interface PeerRequest extends IncomingMessage {
    resolvedIp?: string;
    tlsProfile?: {
        ja4?: string;
        ja3?: string;
    };
    peerContext?: PeerIdentifyContext;
}
/**
 * Resolve the real client IP from request headers using the same priority
 * chain as `ip-devicer`:
 *
 * CF-Connecting-IP → True-Client-IP → X-Real-IP → X-Forwarded-For → remoteAddress
 *
 * Defers to `req.resolvedIp` (set by ip-devicer middleware) when available.
 */
export declare function resolveIp(req: IncomingMessage): string;
/**
 * Extract a {@link PeerIdentifyContext} from an incoming request.
 *
 * - `ip`         — resolved via {@link resolveIp}
 * - `userId`     — reads the `x-user-id` header as a convenience; callers
 *                  should override after authentication if needed
 * - `tlsProfile` — defers to `req.tlsProfile` (set by tls-devicer middleware)
 *                  then falls back to `x-ja4` / `x-ja3` proxy headers
 */
export declare function extractPeerContext(req: IncomingMessage): PeerIdentifyContext;
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
export declare function createPeerMiddleware(): (req: PeerRequest, _res: ServerResponse, next: NextFunction) => void;
//# sourceMappingURL=middleware.d.ts.map