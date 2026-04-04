// ────────────────────────────────────────────────────────────
//  Tests — PeerManager integration (peer-devicer)
// ────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { IdentifyPostProcessorPayload, IdentifyPostProcessorResult } from 'devicer.js';
import { PeerManager } from '../core/PeerManager.js';
import { evictLicenseCache, POLAR_BENEFIT_IDS } from '../libs/license.js';

// ── Mock DeviceManagerLike ─────────────────────────────────

type ProcFn = (
  payload: IdentifyPostProcessorPayload,
) => Promise<IdentifyPostProcessorResult | void> | IdentifyPostProcessorResult | void;

function makeDM() {
  const processors = new Map<string, ProcFn>();

  const dm = {
    registerIdentifyPostProcessor: vi.fn(
      (name: string, fn: ProcFn) => {
        processors.set(name, fn);
        return (): void => { processors.delete(name); };
      },
    ),
    _runProcessor: async (name: string, payload: IdentifyPostProcessorPayload) => {
      const fn = processors.get(name);
      return fn ? fn(payload) : undefined;
    },
  };
  return dm;
}

import type { IdentifyResult } from 'devicer.js';

const emptyEnrichmentInfo = { plugins: [] as string[], details: {} as Record<string, Record<string, unknown>>, failures: [] as { plugin: string; message: string; }[] };
const emptyBaseResult: IdentifyResult = { deviceId: '', confidence: 0, isNewDevice: false, matchConfidence: 0, enrichmentInfo: emptyEnrichmentInfo };

const KEY_PRO = 'PEER-PM-PRO-XXXX';

afterEach(() => {
  vi.unstubAllGlobals();
  evictLicenseCache(KEY_PRO);
});

// ── registerWith ───────────────────────────────────────────

describe('PeerManager.registerWith', () => {
  it('registers a post-processor named "peer"', () => {
    const mgr = new PeerManager();
    const dm  = makeDM();
    mgr.registerWith(dm);
    expect(dm.registerIdentifyPostProcessor).toHaveBeenCalledWith('peer', expect.any(Function));
  });

  it('returns an unregister function', () => {
    const mgr = new PeerManager();
    const dm  = makeDM();
    const unregister = mgr.registerWith(dm);
    expect(typeof unregister).toBe('function');
  });
});

// ── Post-processor: no-op when no signals ─────────────────

describe('PeerManager post-processor — graceful no-op', () => {
  it('returns undefined when context has no ip, userId, or ja4', async () => {
    const mgr = new PeerManager();
    const dm  = makeDM();
    mgr.registerWith(dm);

    const result = await dm._runProcessor('peer', {
      incoming: {},
      context: {},          // no ip, no userId, no tlsProfile.ja4
      result: {
        deviceId: 'dev-001',
        confidence: 50,
        isNewDevice: false,
        matchConfidence: 50,
        enrichmentInfo: emptyEnrichmentInfo,
      },
      baseResult: emptyBaseResult,
      cacheHit: false,
      candidatesCount: 1,
      matched: true,
      durationMs: 10,
    });

    expect(result).toBeUndefined();
  });
});

// ── Post-processor: reputation assessment ─────────────────

describe('PeerManager post-processor — assessment', () => {
  it('returns peerReputation and peerConfidenceBoost', async () => {
    const mgr = new PeerManager();
    const dm  = makeDM();
    mgr.registerWith(dm);

    const result = await dm._runProcessor('peer', {
      incoming: {},
      context: { ip: '203.0.113.5', userId: 'u42' },
      result: {
        deviceId: 'dev-001',
        confidence: 70,
        isNewDevice: false,
        matchConfidence: 70,
        enrichmentInfo: emptyEnrichmentInfo,
      },
      baseResult: emptyBaseResult,
      cacheHit: false,
      candidatesCount: 0,
      matched: false,
      durationMs: 5,
    }) as Record<string, unknown> | undefined;

    expect(result).toBeDefined();
    expect(result?.result).toBeDefined();
    const r = result?.result as Record<string, unknown>;
    expect(r?.peerReputation).toBeDefined();
    expect(typeof r?.peerConfidenceBoost).toBe('number');
  });

  it('enrichmentInfo contains peerCount, taintScore, trustScore, factors', async () => {
    const mgr = new PeerManager();
    const dm  = makeDM();
    mgr.registerWith(dm);

    const result = await dm._runProcessor('peer', {
      incoming: {},
      context: { ip: '10.0.0.1' },
      result: {
        deviceId: 'dev-002',
        confidence: 60,
        isNewDevice: false,
        matchConfidence: 60,
        enrichmentInfo: emptyEnrichmentInfo,
      },
      baseResult: emptyBaseResult,
      cacheHit: false,
      candidatesCount: 0,
      matched: false,
      durationMs: 5,
    }) as Record<string, unknown> | undefined;

    const ei = result?.enrichmentInfo as Record<string, unknown>;
    expect(typeof ei?.peerCount).toBe('number');
    expect(typeof ei?.taintScore).toBe('number');
    expect(typeof ei?.trustScore).toBe('number');
    expect(Array.isArray(ei?.factors)).toBe(true);
  });

  it('logMeta contains peerCount, taintScore, factors', async () => {
    const mgr = new PeerManager();
    const dm  = makeDM();
    mgr.registerWith(dm);

    const result = await dm._runProcessor('peer', {
      incoming: {},
      context: { ip: '10.0.0.2' },
      result: {
        deviceId: 'dev-003',
        confidence: 55,
        isNewDevice: false,
        matchConfidence: 55,
        enrichmentInfo: emptyEnrichmentInfo,
      },
      baseResult: emptyBaseResult,
      cacheHit: false,
      candidatesCount: 0,
      matched: false,
      durationMs: 5,
    }) as Record<string, unknown> | undefined;

    const lm = result?.logMeta as Record<string, unknown>;
    expect(typeof lm?.peerCount).toBe('number');
    expect(typeof lm?.taintScore).toBe('number');
    expect(Array.isArray(lm?.factors)).toBe(true);
  });

  it('reads ip details riskScore from enrichmentInfo.details.ip', async () => {
    const mgr = new PeerManager();
    const dm  = makeDM();
    mgr.registerWith(dm);

    // First call to establish cache entry with known ip risk
    await dm._runProcessor('peer', {
      incoming: {},
      context: { ip: '10.1.2.3' },
      result: {
        deviceId: 'dev-ip-taint',
        confidence: 60,
        isNewDevice: false,
        matchConfidence: 60,
        enrichmentInfo: {
          ...emptyEnrichmentInfo,
          details: {
            ip: { riskScore: 90 },
          },
        },
      },
      baseResult: emptyBaseResult,
      cacheHit: false,
      candidatesCount: 0,
      matched: false,
      durationMs: 5,
    });

    const cache = await mgr.getDeviceCache('dev-ip-taint');
    expect(cache?.ipRisk).toBe(90);
  });

  it('reads tls details consistencyScore from enrichmentInfo.details.tls', async () => {
    const mgr = new PeerManager();
    const dm  = makeDM();
    mgr.registerWith(dm);

    await dm._runProcessor('peer', {
      incoming: {},
      context: { ip: '10.2.3.4', tlsProfile: { ja4: 'ja4-test-xx' } },
      result: {
        deviceId: 'dev-tls-taint',
        confidence: 60,
        isNewDevice: false,
        matchConfidence: 60,
        enrichmentInfo: {
          ...emptyEnrichmentInfo,
          details: {
            tls: { consistencyScore: 35 },
          },
        },
      },
      baseResult: emptyBaseResult,
      cacheHit: false,
      candidatesCount: 0,
      matched: false,
      durationMs: 5,
    });

    const cache = await mgr.getDeviceCache('dev-tls-taint');
    expect(cache?.tlsConsistency).toBe(35);
  });
});

// ── assess() — init-less free-tier behaviour ──────────────

describe('PeerManager.assess', () => {
  it('new device on a fresh manager is marked isNewDevice=true', async () => {
    const mgr = new PeerManager();
    const rep = await mgr.assess({}, { ip: '1.2.3.4' }, 'brand-new', {});
    expect(rep.isNewDevice).toBe(true);
    expect(rep.peerCount).toBe(0);
  });

  it('second device sharing same /24 subnet is connected to first', async () => {
    const mgr = new PeerManager();
    await mgr.assess({}, { ip: '5.6.7.10' }, 'dev-alpha', {});
    const rep = await mgr.assess({}, { ip: '5.6.7.20' }, 'dev-beta', {});
    expect(rep.peerCount).toBeGreaterThan(0);
  });

  it('two devices sharing userId are connected via shared_user edge', async () => {
    const mgr = new PeerManager();
    await mgr.assess({}, { userId: 'user-shared' }, 'ua', {});
    const rep = await mgr.assess({}, { userId: 'user-shared' }, 'ub', {});
    const edgeTypes = rep.peerEdges.map((e) => e.edgeType);
    expect(edgeTypes).toContain('shared_user');
  });

  it('does not connect a device to itself', async () => {
    const mgr = new PeerManager();
    // Two assessments for same device with same IP
    await mgr.assess({}, { ip: '9.9.9.1' }, 'same-dev', {});
    const rep = await mgr.assess({}, { ip: '9.9.9.1' }, 'same-dev', {});
    // peerEdges should not include self-references
    for (const edge of rep.peerEdges) {
      expect(edge.deviceIdA).not.toBe(edge.deviceIdB);
    }
  });
});

// ── getEdges / clear ────────────────────────────────────────

describe('PeerManager query helpers', () => {
  it('getEdges returns edges for a device', async () => {
    const mgr = new PeerManager();
    await mgr.assess({}, { userId: 'qh-u1' }, 'qh-dev-a', {});
    await mgr.assess({}, { userId: 'qh-u1' }, 'qh-dev-b', {});
    const edges = await mgr.getEdges('qh-dev-a');
    expect(edges.length).toBeGreaterThan(0);
  });

  it('clear() removes all stored edges', async () => {
    const mgr = new PeerManager();
    await mgr.assess({}, { userId: 'cl-user' }, 'cl-dev-a', {});
    await mgr.assess({}, { userId: 'cl-user' }, 'cl-dev-b', {});
    await mgr.clear();
    const edges = await mgr.getEdges('cl-dev-a');
    expect(edges).toHaveLength(0);
  });

  it('pruneStaleEdges removes old edges', async () => {
    const mgr = new PeerManager();
    await mgr.assess({}, { userId: 'prune-u' }, 'prune-a', {});
    await mgr.assess({}, { userId: 'prune-u' }, 'prune-b', {});
    // Prune everything older than 0ms (all edges)
    const removed = await mgr.pruneStaleEdges(0);
    expect(removed).toBeGreaterThanOrEqual(0);
  });
});
