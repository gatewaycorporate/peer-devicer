export { PeerManager } from './core/PeerManager.js';
export { validateLicense, evictLicenseCache, POLAR_ORGANIZATION_ID, POLAR_BENEFIT_IDS, FREE_TIER_MAX_DEVICES, FREE_TIER_MAX_HISTORY, } from './libs/license.js';
export type { LicenseTier, LicenseInfo } from './libs/license.js';
export type { PeerEdgeType, PeerEdge, PeerDeviceCache, PeerSignals, PeerManagerOptions, PeerReputationResult, PeerIdentifyContext, IdentifyResult, EnrichedIdentifyResult, } from './types.js';
export { createPeerStorage } from './libs/adapters/inmemory.js';
export type { PeerStorage, AsyncPeerStorage } from './libs/adapters/inmemory.js';
export { createSqliteAdapter } from './libs/adapters/sqlite.js';
export { createPostgresAdapter } from './libs/adapters/postgres.js';
export type { PgPoolLike } from './libs/adapters/postgres.js';
export { createRedisAdapter } from './libs/adapters/redis.js';
export type { RedisLike } from './libs/adapters/redis.js';
export { extractPeerSignals, buildEdgeShape, activeSignalEntries, EDGE_WEIGHTS, FREE_TIER_EDGE_TYPES, } from './libs/edges.js';
export type { BuildEdgeInput } from './libs/edges.js';
export { computePeerReputation, computeConfidenceBoost } from './libs/scoring.js';
export type { PeerWithEdge } from './libs/scoring.js';
export { createPeerMiddleware, extractPeerContext, resolveIp, } from './libs/middleware.js';
export type { NextFunction, PeerRequest } from './libs/middleware.js';
//# sourceMappingURL=main.d.ts.map