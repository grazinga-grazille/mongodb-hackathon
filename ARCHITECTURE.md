# Architecture (v0, a simple mock to iterate on)

## The big picture
```
 ┌──────────┐   voice    ┌──────────────────────┐
 │  Caller  │ ◀────────▶ │  Voice agent         │   ElevenLabs: speech ⇄ text
 └──────────┘            │  (Claude decides)    │
                         └──────────┬───────────┘
                                    │ tool calls (HTTP)
                                    ▼
                         ┌──────────────────────┐        ┌───────────────┐
                         │  Backend (Express)   │ ─────▶ │  Voyage AI    │
                         │  /tools/*            │ ◀───── │  text → embed │
                         └──────────┬───────────┘        └───────────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐        ┌───────────────┐
                         │  MongoDB Atlas       │ ─────▶ │  Dashboard    │
                         │  data + Vector Search│ change │  (live view)  │
                         └──────────────────────┘ stream └───────────────┘
```

## One call, step by step
```
1. Caller: "My headphones never arrived"   (order #1042)
2. Agent  → /tools/check-claim  { orderId, claimText }
3. Backend:
     a. embed claimText (Voyage)
     b. vector search memories   → similar scam stories?    (what they SAY)
     c. look up order + delivery → delivered with photo?     (what HAPPENED)
     d. look up footprint        → address/card on a flagged account?
     e. look up money history    → refund or chargeback already?
4. Backend → returns checks + recommendation: APPROVE | ESCALATE | DECLINE
5. Agent tells the caller the outcome
6. Agent  → /tools/issue-refund   (only if APPROVE)
7. Analyst later confirms scam / clears customer → /tools/record-outcome
   → memory written or corrected, so the next call behaves differently
```

## Collections (MongoDB Atlas, db: `hackathon`)
| Collection | Holds | Searched by |
|---|---|---|
| `orders` | Item, value, delivery status, photo, customer | Exact lookup |
| `footprints` | Hashed address, card token, device per account | Exact lookup |
| `refunds` | Refunds issued, open chargebacks | Exact lookup |
| `memories` | Scam stories, probing phrases, links, analyst outcomes, plus embedding | **Vector Search** (filtered by merchant, scope, status) + TTL on `expiresAt` |
| `audit_log` | Who did what, no personal data | Append only |

## Backend endpoints (the agent's tools)
| Endpoint | Does |
|---|---|
| `POST /tools/check-claim` | Runs checks a–e, returns a recommendation and the memories that drove it |
| `POST /tools/issue-refund` | Refuses if a refund or chargeback already exists |
| `POST /tools/record-outcome` | Analyst confirms a scam or clears a customer; writes or corrects memory |
| `POST /tools/forget-me` | Deletes a customer's memories; keeps order and refund records |

## Build order
1. Seed synthetic data (orders, footprints, a few scam stories)
2. `check-claim` with vector search + exact checks (test with curl)
3. `issue-refund` + `record-outcome`
4. Voice agent wired to the tools
5. Dashboard

## Open questions to iterate on
- Thresholds: what similarity score counts as a match (start at ~0.85)?
- Does Claude make the final call, or do fixed rules decide and Claude explains?
- Dashboard: simple HTML page, or skip and show MongoDB collections directly?
