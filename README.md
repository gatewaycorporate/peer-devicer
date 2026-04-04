# peer-devicer

**Peer Reputation Networking Middleware** for the FP-Devicer Intelligence Suite.  
Developed by [Gateway Corporate Solutions](https://gatewaycorporate.io).

---

## Overview

`peer-devicer` enriches every `DeviceManager.identify()` call with a **peer graph score** — linking device identifiers that share common signals (IP subnet, user account, JA4 TLS fingerprint, canvas hash, WebGL hash) and propagating ip/tls reputation through the graph as a confidence adjustment.

### What it does

| Step | Description |
|------|-------------|
| **Signal extraction** | Extracts IP /24 subnet, user ID, JA4, canvas, and WebGL from each request. |
| **Graph construction** | Builds/updates canonical `PeerEdge` records linking devices that share any signal. |
| **Reputation propagation** | Loads the cached ip-risk / TLS-consistency / drift scores of each peer, then computes a weighted `taintScore` and `trustScore` for the current device. |
| **Confidence adjustment** | Emits a `peerConfidenceBoost` delta (−20 → +10 pts) which `DeviceManager` applies to the match confidence. |

---

## Installation

```bash
npm install peer-devicer
```

Optional peer dependencies (install the ones matching your storage choice):

```bash
npm install better-sqlite3   # SQLite adapter
npm install ioredis           # Redis adapter
npm install pg                # PostgreSQL adapter
```

---

## Quick start

```ts
import { DeviceManager }  from 'devicer.js';
import { IpManager }      from 'ip-devicer';
import { TlsManager }     from 'tls-devicer';
import {
  PeerManager,
  createPeerMiddleware,
} from 'peer-devicer';

// ── Initialise plugins ──────────────────────────────────────
const deviceManager = new DeviceManager({ /* … */ });

const ipManager  = new IpManager({ licenseKey: process.env.IP_LICENSE_KEY });
const tlsManager = new TlsManager({ licenseKey: process.env.TLS_LICENSE_KEY });
const peerManager = new PeerManager({ licenseKey: process.env.PEER_LICENSE_KEY });

// Register ip-devicer and tls-devicer FIRST so their enrichmentInfo
// is available when peer-devicer runs (post-processor ordering matters).
ipManager.registerWith(deviceManager);
tlsManager.registerWith(deviceManager);
peerManager.registerWith(deviceManager);   // ← peer runs last

await Promise.all([
  ipManager.init(),
  tlsManager.init(),
  peerManager.init(),
]);

// ── Express middleware ──────────────────────────────────────
app.use(createPeerMiddleware());   // attaches req.peerContext

// ── In your route handler ────────────────────────────────────
app.post('/identify', async (req, res) => {
  const result = await deviceManager.identify(req.body, req.peerContext);
  // result.peerReputation      — { peerCount, taintScore, trustScore, factors, … }
  // result.peerConfidenceBoost — e.g. −12 (tainted cluster) or +8 (clean peers)
  res.json(result);
});
```

---

## Storage adapters

| Adapter | Import | Use case |
|---------|--------|----------|
| In-memory *(default)* | built-in | Dev / testing / single-process |
| SQLite | `createSqliteAdapter` | Single-process production |
| PostgreSQL | `createPostgresAdapter` | Multi-process / HA |
| Redis | `createRedisAdapter` | Distributed / low-latency |

```ts
import { createSqliteAdapter } from 'peer-devicer';

const peerManager = new PeerManager({
  licenseKey: process.env.PEER_LICENSE_KEY,
  storage: createSqliteAdapter('/data/peers.db'),
});
```

---

## Plugin pipeline

`peer-devicer` registers as a DeviceManager post-processor named `'peer'`. It must run **after** `ip-devicer` and `tls-devicer` so it can read their cached enrichment data:

```
identify(payload, context)
   │
   ├─ 'ip'  post-processor  (ip-devicer)
   │     └─> enrichmentInfo.details.ip.riskScore
   │
   ├─ 'tls' post-processor  (tls-devicer)
   │     └─> enrichmentInfo.details.tls.consistencyScore
   │
   └─ 'peer' post-processor (peer-devicer) ← register last
         ├─ builds / updates peer graph
         ├─ computes taintScore / trustScore
         └─> result.peerReputation + result.peerConfidenceBoost
```

---

## Enrichment result shape

```ts
{
  peerReputation: {
    peerCount:       number;   // number of graph neighbours
    taintScore:      number;   // 0–100, higher = more tainted peers
    trustScore:      number;   // 0–100, higher = more trustworthy peers
    isNewDevice:     boolean;  // true when no peer edges exist yet
    factors:         string[]; // 'high_taint_peers' | 'known_bot_cluster' | ...
    peerEdges:       PeerEdge[];
    confidenceBoost: number;
  },
  peerConfidenceBoost: number, // confidence delta applied to DeviceManager result
}
```

---

## License tiers

| Tier | Price | Devices | Edge types | Edges / device |
|------|-------|---------|------------|----------------|
| Free | $0 | 10,000 | user + IP subnet | 10 |
| Pro | $49 / mo | Unlimited | All 5 types | 50 (configurable) |
| Enterprise | $299 / mo | Unlimited | All 5 types | Unlimited |

Get a license key at **[polar.sh/gateway-corporate](https://polar.sh/gateway-corporate)**.

Without a key the library runs on the free tier automatically and logs a warning at startup.

---

## API reference

Full API docs are generated by [TypeDoc](https://typedoc.org) and available in the [`docs/`](./docs) folder:

```bash
npm run docs
```

---

## License

Business Source License 1.1 — see [license.txt](./license.txt).
