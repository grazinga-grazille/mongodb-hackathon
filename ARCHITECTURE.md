# Architecture — Refund Guard (v1 mock)

> Problem: see [PROBLEM.md](PROBLEM.md). Status: **v1 runs end to end, including live voice calls**.
> Frontend lives in a separate repo: **mongodb-hackathon-frontend** (React + Vite, `http://localhost:5173`).

## 1. System overview
```
 ┌──────────┐  voice   ┌───────────────────────┐
 │  Caller  │ ◀──────▶ │  Voice agent          │  ElevenLabs (speech ⇄ text) + LLM
 └──────────┘          │  explains, never      │  LLM: claude-haiku-5-5 (hosted by ElevenLabs)
                       │  decides              │
                       └──────────┬────────────┘
                                  │ HTTPS tool calls (x-merchant-id)
 ┌──────────────┐                 ▼
 │  Frontend    │ ◀── SSE ── ┌───────────────────────┐ ──▶ Embeddings
 │  (separate   │            │  Backend (Express)    │     local bge-small (default)
 │   repo)      │ ── HTTP ─▶ │  /tools  /admin       │     or Voyage AI (with key)
 └──────────────┘            │  decision engine      │
                             └──────────┬────────────┘
                                        │ driver: queries, $vectorSearch,
                                        │ transactions, change streams
                                        ▼
                             ┌───────────────────────┐
                             │  MongoDB Atlas        │  Cluster0 · db `hackathon`
                             │  records + memories   │  Vector Search · TTL · validation
                             └───────────────────────┘
```

**Design principles**
1. **Rules decide, the AI explains.** The decision engine is deterministic code; the voice agent only talks. A caller can't talk the agent into a refund.
2. **Vector search for what people *say*; exact checks for what *happened*.**
3. **Governance lives in the database**, not in prompts: filters, validators, TTL and unique indexes enforce the memory rules.
4. **Records ≠ memory.** Orders, refunds and disputes are legal records and are never "forgotten"; memories are governed and can be.

## 2. One call, end to end
```
Caller: "The headphones never turned up"        (order ord_1042)
  │
  ▼ POST /tools/check-claim { orderId, claimText, callerQuestions[] }
  1. Load order (merchant-scoped) → customerId comes from the order, never from the caller
  2. Hard stops      refund already active? chargeback open?            → DECLINE
  3. What they SAY   embed claim + questions
                     $vectorSearch scam_script   (≥ 0.78 cosine)        +2
                     $vectorSearch probe_phrase  (≥ 0.75 cosine)        +1
                     classify claim type (never_arrived / empty_box / …)
  4. What HAPPENED   delivery contradicts claim (photo / dispatch weight)  +2
                     other claims from this account in 90 days          +1
                     footprint shared with escalated account            +2
                     footprint shared with confirmed-scam account       +3
                     (skipped if an analyst cleared this customer)
  5. Decide          score ≥ 3 → ESCALATE, else APPROVE
  6. Record          claim + signals + memoryIdsUsed (decision trace)
  │
  ▼ returns { claimId, decision, signals, agentGuidance }
Agent speaks the outcome → APPROVE only: POST /tools/issue-refund
Analyst reviews → POST /tools/record-outcome (confirmed_scam | cleared)
  → memory written / reinforced / revoked → next call behaves differently
```

## 2b. Live voice call
```
Browser (frontend repo)                   Backend                         ElevenLabs
  Start call ─ GET /voice/signed-url ───▶ uses ELEVENLABS_API_KEY ──────▶ signed wss URL
  ◀──────────────────────────── signed URL (key never reaches the browser)
  mic audio ⇄ agent (websocket) ⇄─────────────────────────────────────────▶ speech + LLM
  agent calls client tool check_claim ─▶ POST /tools/check-claim
       (runs in the browser → localhost, so no public tunnel is needed)
  tool result sent back to the agent: decision + agentGuidance only, never signals
  End call ─ POST /voice/calls {conversationId, claimIds}
                                          fetch transcript + summary ───▶ /conversations/:id
                                          store in `calls` (scrubbed, TTL 30 days)
  next call: check-claim returns previousContacts (summaries) for that customer
```
Agent setup is code: `npm run agent` creates/updates the agent and its two client tools (`check_claim`, `issue_refund`) and saves `ELEVENLABS_AGENT_ID` to `.env`.

## 3. Data model (`hackathon` database)
| Collection | Kind | Key fields | Notes |
|---|---|---|---|
| `merchants` | record | `_id`, `name` | Tenants |
| `customers` | record | `_id`, `merchantId`, `name`, `address` | Merchant's own PII; never copied into memory |
| `orders` | record | `item{name, weightKg}`, `amount`, `delivery{status, photo, dispatchWeightKg}` | Facts the claim is checked against |
| `footprints` | record | `addressHash`, `cardHash`, `deviceHash` | HMAC hashes only; address normalized first |
| `claims` | record | `text`, `claimType`, `decision`, `signals[]`, `memoryIdsUsed[]`, `status` | Decision trace: *why* the agent did what it did |
| `refunds` | record | `orderId`, `amount`, `active` | Unique index: one active refund per order |
| `disputes` | record | `orderId`, `status` | Chargebacks (simulated bank webhook) |
| `calls` | record (TTL) | `conversationId`, `customerId`, `claimIds`, `summary`, `transcript[]`, `expiresAt` | Scrubbed transcripts; deleted after 30 days or on forget-me |
| `memories` | **memory** | `type`, `scope`, `text`, `embedding`, `status`, `version`, `expiresAt`, `seenCount`, `confidence`, `usedInDecisions[]` | Vector indexed, validated, TTL |
| `audit_log` | record | `action`, ids, `at` | Append only, no PII |

**Memory types**
| Type | Scope | Embedded | Lives | Written when |
|---|---|---|---|---|
| `scam_script` | network (shared) | ✅ | 90 days, reset when seen again | Analyst confirms a scam (near-duplicates ≥ 0.9 reinforce instead) |
| `probe_phrase` | network (shared) | ✅ | 90 days | Seeded / analyst |
| `suspect_account` | merchant (private) | — | 180 days | Analyst confirms a scam |
| `cleared_customer` | merchant (private) | — | 180 days | Analyst clears a customer |

## 4. Memory governance and how it's enforced
| Rule | Enforced by |
|---|---|
| **Changes the next run** | `record-outcome` writes/reinforces/revokes memories; `check-claim` reads them; `usedInDecisions` + `memoryIdsUsed` prove the link |
| **Who can read** | Every `$vectorSearch` carries a pre-filter `{scope.level: network} OR {scope.merchantId: <caller>}` on indexed filter fields. Schema validation forbids network memories from holding `merchantId`/`customerId` |
| **How long it lives** | TTL index on `expiresAt` (Atlas deletes it); "seen again" pushes `expiresAt` forward |
| **Corrected** | New version with `supersedes`; old one marked `superseded` (never overwritten). Clearing a customer revokes `suspect_account` and adds `cleared_customer` |
| **Forgotten** | `forget-me` deletes the customer's memories, footprints and call transcripts, scrubs claim text; keeps orders/refunds/disputes; audit entry stores only a hashed subject |
| **No card data in memory** | `$jsonSchema` rejects any memory text containing a 13–19 digit sequence; `scrubText()` removes cards/emails/phones before writes |
| **Never pay twice** | Hard-stop check + transaction re-check for open disputes + unique partial index on `refunds.orderId` |

## 5. Indexes
| Collection | Index | Purpose |
|---|---|---|
| `memories` | `memory_vec` (vectorSearch, cosine, 384 dims; filters: `type`, `status`, `scope.level`, `scope.merchantId`, `scope.customerId`) | Semantic recall with access control |
| `memories` | `expiresAt` TTL (`expireAfterSeconds: 0`) | Lifespan |
| `memories` | `scope.merchantId, scope.customerId, type, status` | Customer memory lookups |
| `refunds` | `orderId` unique, partial `{active: true}` | One refund per order |
| `footprints` | `merchantId + addressHash / cardHash / deviceHash`; `merchantId + customerId` unique | Ring detection |
| `claims` | `merchantId, customerId, createdAt` | Repeat-claim window |

## 6. API
**Agent tools** (`/tools/*`, header `x-merchant-id` required)
| Endpoint | Body | Returns |
|---|---|---|
| `POST /tools/check-claim` | `orderId, claimText, callerQuestions[]?, claimType?` | `decision`, `riskScore`, `signals[]`, `memoryIdsUsed`, `agentGuidance` |
| `POST /tools/issue-refund` | `claimId` | refund, or `409` if already refunded / chargeback open / not approved |
| `POST /tools/record-outcome` | `claimId, outcome: confirmed_scam \| cleared` | memories written/revoked |
| `POST /tools/forget-me` | `customerId` | counts deleted / kept |

**Dashboard & demo** (`/admin/*`, local only)
**Voice:** `GET /voice/config` · `GET /voice/signed-url` · `POST /voice/calls`

`GET /admin/state` · `GET /admin/events` (SSE from change stream) · `GET /admin/memories/search?q=` · `POST /admin/memories/:id/correct` · `POST /admin/memories/:id/expire` · `POST /admin/disputes` (simulate bank) · `POST /admin/reset`

## 7. Security & privacy (mock vs. production)
| Area | Mock | Production |
|---|---|---|
| Merchant identity | `x-merchant-id` header | Per-merchant API key / signed tool calls from the voice platform |
| Admin/dashboard | Bound to `127.0.0.1`, no auth | Analyst SSO + roles |
| Browser access | CORS allowlist (`CORS_ORIGINS`); dev uses Vite proxy (same origin) | Same allowlist with the deployed frontend origin |
| Card data | Never spoken or stored; validator + scrubber | Collected via keypad/secure link at the processor; never reaches the LLM |
| Footprints | HMAC with `FOOTPRINT_SECRET` | Secret in a KMS; rotate with re-hash |
| Voice | Not recorded | Disclose AI analysis at call start; no voiceprints (biometric law) |
| Refunds | Simulated rows | Processor refund API, idempotency key = claimId |
| Generic CRUD | Off unless `ENABLE_GENERIC_API=true` | Removed |

## 8. Project layout
```
backend/
  src/
    server.js              app wiring, CORS allowlist, error handler
    config.js              thresholds, weights, TTLs (tune here)
    db.js                  single MongoClient + pool
    db/schema.js           collections, validators, indexes, vector index
    db/seed.js             synthetic demo world
    db/cli.js              npm run setup | seed
    lib/embeddings.js      local bge-small or Voyage
    lib/privacy.js         address normalization, HMAC hashing, text scrubbing
    lib/audit.js · lib/http.js
    services/claims.js     decision engine + analyst outcomes
    services/memory.js     governed memory: search, learn, reinforce, correct, expire
    services/refunds.js    refund transaction, forget-me
    routes/tools.js        agent tools
    routes/admin.js        dashboard + demo controls
    routes/voice.js        signed URLs + call transcript storage
    routes/crud.js         legacy generic API (disabled)
  scripts/demo.sh          plays the 4-call story
  scripts/create-agent.js  creates/updates the ElevenLabs agent + tools
```

## 9. Running it
```bash
cd backend
npm install
npm run seed     # schema + vector index + demo data (first run downloads the local model)
npm run agent    # create/update the ElevenLabs voice agent (needs ELEVENLABS_API_KEY)
npm run dev      # API on http://localhost:3000
# then start the frontend repo: npm run dev → http://localhost:5173
npm run demo     # in another terminal: plays Jake → Maria → Priya → Jake again
```

## 10. Iteration roadmap
| # | Next | Notes |
|---|---|---|
| 1 | Voyage embeddings | Set `VOYAGE_API_KEY` + `EMBEDDING_PROVIDER=voyage`, re-run `npm run seed` (index rebuilds at 1024 dims), re-tune thresholds |
| 2 | Hybrid search | `$rankFusion` (vector + Atlas Search keywords) for scripts with exact tells ("porch", "empty box") |
| 3 | Ring view | Dashboard graph of accounts joined by shared footprint |
| 4 | Threshold tuning | Small labeled set of honest vs. scam phrasings; measure precision per threshold |
| 5 | Production hardening | API keys, analyst auth, processor webhooks for disputes, phone line (Twilio) instead of browser mic |

## 11. Decisions & open questions
- ✅ **Rules decide, LLM explains** (predictable demo, no prompt-injection refunds).
- ✅ **Local embeddings by default** so the mock runs with no API keys; Voyage is a config switch.
- ✅ Thresholds: script 0.78, probe 0.75, claim-type 0.68 (bge-small). Tune in `config.js`.
- ❓ Should a `script_match` alone ever escalate high-value orders (e.g. > $500)?
- ❓ Should cleared customers also get a discount on `script_match` weight, or only skip footprint links?
- ❓ Should probing phrases be learned automatically from escalated calls, or analyst-only?
