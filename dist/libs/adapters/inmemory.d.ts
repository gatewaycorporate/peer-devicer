import type { PeerStorage } from '../../types.js';
export type { PeerStorage, AsyncPeerStorage } from '../../types.js';
/**
 * Create an in-memory {@link PeerStorage}.
 *
 * Stores edges in a flat map keyed by canonical edge identity
 * (`deviceIdA||deviceIdB||edgeType||signalValue`) and device caches in a
 * separate map.  All data is lost when the process exits.
 *
 * @param maxEdgesPerDevice - Maximum edges retained per device side. Default: 50.
 */
export declare function createPeerStorage(maxEdgesPerDevice?: number): PeerStorage;
//# sourceMappingURL=inmemory.d.ts.map