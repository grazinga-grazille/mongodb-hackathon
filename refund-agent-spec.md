# Refund Agent: "Finish the Job"

Build spec for Claude Code. Read this whole file first, then build in the phases listed under **Build order**. Run the stated gate tests after each phase before moving on.

## 1. Context

Hackathon problem statement 3, "Finish the Job": build an agent that completes a long, multi-step task across several systems, using **MongoDB Atlas** to persist verified task state and **Atlas Vector Search** to retrieve relevant past experience, so it survives crashes and system changes and knows what actually happened.

The three questions this project must answer:

1. How does the agent tell an action that took effect from one that was only sent?
2. How does it resume after a crash without replaying its whole history?
3. How does it adapt when a system's fields or workflow change underneath it?

Time budget: about 4 to 5 hours. Scope for that. All systems are mocks. No real money, no real card data.

## 2. The task

A customer asks for a refund on an order. The agent completes the refund across four systems:

| System | Action | Read-back used for verification |
|---|---|---|
| Payment processor | Create a refund against the original charge | Look up refunds by charge ID |
| Ledger | Post a refund entry | Look up entries by reference |
| Order system | Mark the order refunded (full or partial) | Read the order |
| Notifications | Send the customer a confirmation | Look up messages by reference |

Dependencies: ledger, order update, and notification all depend on the processor refund being **verified**. Ledger and order update are independent of each other. The notification depends on all three.

## 3. What goes wrong (the faults we must handle)

- **Timeout after apply:** the processor applied the refund but the reply never arrived.
- **Timeout before apply:** the request never took effect.
- **Silent drop:** the processor returns success but stores nothing.
- **Delayed settlement:** the refund is accepted as `pending` and completes later.
- **Crash:** the agent process is killed mid-run.
- **Schema change:** the processor renames a field (e.g. `amount` becomes `amount_minor`) and calls start failing.
- **Duplicate or out-of-order events** (stretch).
- **Dispute overlap** (stretch): see section 11.

## 4. Guarantees (the acceptance criteria)

1. **No double refund.** A retry never applies the same refund twice.
2. **No false "done".** The agent only tells the customer something is complete when the matching step is `verified`.
3. **Safe resume.** After a kill, the agent continues from verified state, with no repeated completed steps and without replaying full history.
4. **Consistent end state.** On completion, processor, ledger, and order system agree on the refunded amount.
5. **Adaptation.** After a schema change, the agent recovers using a similar past fix retrieved with Vector Search, and verifies the fix by read-back before trusting it.

## 5. Principles

- **MongoDB is the source of truth for what happened.** The LLM never writes step state.
- **The LLM plans and phrases; plain code executes.** State transitions, retries, and verification are deterministic code.
- **Only the verifier can mark a step `verified`.** The executor has no code path that sets it.
- **Timeout means unknown, not failed.** Never retry blindly, and never switch idempotency keys while an outcome is unresolved.
- **Record intent before acting.** Write `sending` before the call, so a crash leaves evidence.

## 6. Architecture

```
Customer (text first, voice optional)
        |
Conversation layer  --  Speech gate (claims must match verified steps)
        |
Agent / planner (LLM)  -- builds the plan, phrases replies, proposes fixes
        |
Executor (deterministic state machine, lease-based worker)
   |            |                    |
   |            |                    +-- Verifier (independent read-backs)
   |            |
   |            +-- Adapters (one per system, with a versioned config overlay)
   |                   |-- Mock payment processor
   |                   |-- Mock ledger
   |                   |-- Mock order system
   |                   '-- Mock notifications
   |
MongoDB Atlas
   |-- tasks         one per refund request
   |-- steps         one per system action
   |-- attempts      append-only log of every call and response
   |-- utterances    what the agent said and which steps it relied on
   |-- experience    past failures and fixes (Vector Search)
   '-- adapter_configs  versioned field-mapping overlays (candidate / active)
```

### Components

- **Conversation layer:** receives the request, creates the task, streams status updates. Text interface first; voice is a thin layer added last.
- **Planner (LLM):** produces a plan (a small DAG of steps) and customer-facing wording. Output is structured JSON validated against a schema.
- **Executor:** claims a task via a lease, advances steps with conditional updates, calls adapters, and never marks `verified`.
- **Verifier:** the only writer of `verified`. Reads the target system through a different endpoint than the write, normalizes values, compares to the desired state, and handles eventual consistency with a deadline and backoff.
- **Adapters:** hide each system's API. Each applies its active config overlay (field mappings) to requests and responses.
- **Speech gate:** the agent's reply must include `claims: [{step_id, kind}]`. A validator rejects any `completed` claim whose step is not `verified` and regenerates.
- **Experience memory:** Vector Search over past failures and fixes, used only when something unexpected breaks.

## 7. Data model (MongoDB)

Database: `refund_agent`. Connection string from env `MONGODB_URI`.

### `tasks`
```json
{
  "_id": "task_001",
  "caller_id": "cust_204",
  "goal": "refund",
  "desired": {"order_id": "ord_55", "charge_id": "ch_9", "amount_minor": 5000, "currency": "USD"},
  "status": "running",
  "lease": {"owner": "worker-1", "expires_at": "<iso>"},
  "version": 3,
  "created_at": "<iso>", "updated_at": "<iso>"
}
```
`status`: `running | completed | needs_human | failed`.

### `steps`
```json
{
  "_id": "task_001:processor",
  "task_id": "task_001",
  "system": "processor",
  "depends_on": [],
  "desired_hash": "9f2c...",
  "idem_key": "task_001:processor:9f2c",
  "state": "planned",
  "attempts": 0,
  "last_error": null,
  "verification": {"method": "readback", "deadline": null, "result": null},
  "version": 1
}
```

### `attempts` (append-only)
`{step_id, attempt_no, request, response, error, started_at, ended_at, adapter_config_version}`

### `utterances`
`{task_id, text, claims: [{step_id, kind}], created_at}`

### `experience`
```json
{
  "_id": "exp_001",
  "system": "processor",
  "signature_text": "processor refund create failed: unknown field 'amount'; expected 'amount_minor'",
  "fix": {"kind": "field_rename", "from": "amount", "to": "amount_minor"},
  "outcome_status": "verified_success",
  "success_count": 1, "failure_count": 0,
  "embedding": [0.01, 0.02],
  "embedding_model": "all-MiniLM-L6-v2",
  "created_at": "<iso>"
}
```

### `adapter_configs`
`{system, version, status: "candidate" | "active" | "discarded", field_map: {"amount": "amount_minor"}, source_experience_id}`

### Indexes
- `steps`: `{task_id: 1}`, and `{state: 1}`.
- `tasks`: `{"lease.expires_at": 1}`.
- `attempts`: `{step_id: 1, attempt_no: 1}` unique.
- Schema validation (`$jsonSchema`) on `steps` restricting `state` to the enum and requiring `idem_key`.

### Atlas Vector Search index on `experience` (name: `experience_vector`)
```json
{
  "fields": [
    {"type": "vector", "path": "embedding", "numDimensions": 384, "similarity": "cosine"},
    {"type": "filter", "path": "system"},
    {"type": "filter", "path": "outcome_status"}
  ]
}
```
`numDimensions` must match the embedding model. Default model: a local `sentence-transformers` model (all-MiniLM-L6-v2, 384 dims) so no API key is needed. Make the embedding function pluggable and store the model name on every record. Never mix models in one index.

## 8. Step state machine

```
planned -> sending -> sent -> verifying -> verified (terminal, success)
              |                    |
              v                    v
           unknown ------------> verifying
                                   |
                                   v
                               mismatch -> sending (retry, same idem_key)  |  adapting
failed (terminal)  |  needs_human (terminal)
```

Rules:
1. **Write-ahead intent.** Transition `planned -> sending` and commit *before* the adapter call.
2. **Conditional transitions only.** Every change is a compare-and-set on `(_id, state, version)`:
   ```python
   def advance(steps, step_id, expect_state, new_state, expect_version, **fields):
       r = steps.update_one(
           {"_id": step_id, "state": expect_state, "version": expect_version},
           {"$set": {"state": new_state, **fields}, "$inc": {"version": 1}})
       return r.modified_count == 1
   ```
3. A step found in `sending` or `sent` on resume is treated as `unknown`. Resolve it by reading the target system, never by assuming.
4. **Retries reuse the same `idem_key`.** The key is `task_id:step_id:desired_hash`.
5. The verifier alone sets `verified`. The executor code must not contain a path that does.
6. `mismatch` after the verification deadline triggers a retry (same key) or, if the error looks like a schema problem, the adaptation path (section 10).

### Verification details
- `read_back(desired)` fetches through a different endpoint than the write.
- Normalize before comparing (case, whitespace, amount units).
- Eventual consistency: poll with backoff until `verification.deadline`. A mismatch before the deadline means "not yet"; after it, `mismatch`.
- For the processor, if a refund is `pending`, stay in `verifying` until it is `completed`.

## 9. Resume

- A worker claims a task with a compare-and-set on `lease` (owner and expiry), and heartbeats while working.
- If the worker dies, the lease expires and any worker can claim the task.
- Resume procedure: claim lease, load the task's steps (small), reconcile any step in `sending`, `sent`, `verifying`, or `unknown` by reading the system, then continue the DAG from verified state.
- The LLM context on resume is rebuilt from state only: goal, desired values, verified facts, open steps and reasons, and the last few utterances. **Not** the full transcript.
- Log the token count of this resume context for the metrics report.

## 10. Adaptation with Vector Search

Triggered when a write fails with a validation or shape error, or a read-back returns an unexpected shape.

1. **Build a failure signature:** a short text with the system, the error message, and what changed (e.g. a schema diff).
2. **Exact match first:** look up identical signatures in `experience`.
3. **Vector search second:** embed the signature and run `$vectorSearch` on `experience_vector` with `filter` on `system` and `outcome_status = "verified_success"`. Apply a similarity threshold. Below the threshold, treat as no match.
4. **Apply safely:** a fix is a **declarative patch** only (field mapping, default for a new required field), never free-form code. Write it to `adapter_configs` as a `candidate`, run the step, verify by read-back.
   - On success: promote the config to `active`, increment `success_count`.
   - On failure: mark it `discarded`, increment `failure_count`.
5. **No match:** ask the LLM to propose a patch from the error and schema diff. It goes through the same candidate-then-verify path.
6. **Store the outcome** as a new `experience` record, with `retrieved_experience_used: true/false` logged on the attempt so retrieval impact is measurable.

## 11. Stretch: dispute guard

Bank disputes and refunds run on separate systems that do not coordinate. Add a per-charge record:

```
charges: {charge_id, amount, refunded_verified, refunds_in_flight, dispute_status, dispute_amount, version}
```
Rule: `refunded_verified + refunds_in_flight + dispute_amount <= amount`. Reserve the refund amount with an atomic conditional update before calling the processor. Add a pre-refund step that reads dispute status from the processor, and a post-refund re-check. If both a refund and a dispute exist, set `needs_human` and do not tell the customer the matter is settled. Needs a mock dispute service with a "dispute arrives mid-refund" fault.

## 12. Mock systems

Small HTTP services (FastAPI), each with a control endpoint `POST /_faults` taking `{"mode": "...", "once": true}` and `POST /_reset`.

| Service | Endpoints |
|---|---|
| Processor | `POST /refunds` (header `Idempotency-Key`, body `{charge_id, amount}`), `GET /refunds?charge_id=`, `GET /refunds/{id}` |
| Ledger | `POST /entries`, `GET /entries?ref=` |
| Orders | `PATCH /orders/{id}`, `GET /orders/{id}` |
| Notifications | `POST /messages`, `GET /messages?ref=` |

Processor fault modes: `timeout_after_apply`, `timeout_before_apply`, `silent_drop`, `delayed_settlement` (refund `pending` for N seconds), `rename_field` (expects `amount_minor`, returns 422 naming the unknown field). The processor must honor idempotency keys: the same key returns the original result and never creates a second refund.

## 13. Speech gate

Before each agent reply, build a claims context from MongoDB: `assertable` (verified steps) and `pending` (everything else with its state). The LLM returns structured output:
```json
{"say": "Your refund of $50 is confirmed. I'm still sending your confirmation email.",
 "claims": [{"step_id": "task_001:processor", "kind": "completed"},
            {"step_id": "task_001:notify", "kind": "in_progress"}]}
```
A validator rejects any `completed` claim whose step is not `verified`, and regenerates with the violation as feedback. Persist accepted utterances with their claims. Also gate future-tense commitments ("you'll receive an email") on a scheduled step existing.

## 14. Test matrix (each is an automated test asserting on MongoDB state and the utterance log)

| Scenario | Expected |
|---|---|
| Happy path | All steps verified, systems agree, task completed |
| `timeout_after_apply` | Step goes `unknown`, read finds the refund, no second refund created |
| `timeout_before_apply` | Step `unknown`, read finds nothing, retry with the same key, one refund |
| `silent_drop` | Read-back mismatch, targeted retry, never claimed "done" early |
| `delayed_settlement` | Stays `verifying` until the refund completes, then `verified` |
| Kill worker mid-step | Lease expires, new worker resumes, completed steps not repeated |
| `rename_field` first occurrence | No match found, fix worked out, verified, stored in `experience` |
| `rename_field` with different wording on a different field | Fix retrieved via Vector Search, applied as candidate, verified |
| Unrelated failure | Nothing retrieved above threshold, falls back to working it out |
| Speech gate | Zero unsupported `completed` claims across all runs |

## 15. Metrics report (printed at the end of a demo run)

- False "done" claims: target 0.
- Duplicate refunds: target 0.
- Redundant writes after a crash: target 0.
- Resume context size (tokens) versus full-history replay.
- Time to fix: first schema change versus second, and whether retrieval was used.

## 16. Repo layout

```
refund-agent/
  README.md
  pyproject.toml
  .env.example              # MONGODB_URI, LLM key, embedding model name
  mocks/                    # processor.py, ledger.py, orders.py, notifications.py
  agent/
    db.py                   # Mongo client, collections, indexes, schema validation
    state_machine.py        # advance(), transitions
    executor.py             # lease, DAG scheduling, adapter calls
    verifier.py             # read-backs, deadlines, unknown resolution
    adapters/               # one per system + config overlay loader
    experience.py           # signatures, embeddings, $vectorSearch, candidate-then-verify
    planner.py              # LLM plan + wording (structured output)
    speech_gate.py          # claim validation
    cli.py                  # run a refund, inject faults, kill/resume
  tests/                    # one file per row of the test matrix
  scripts/demo.py           # scripted fault run + metrics report
```

## 17. Tech defaults (change if needed)

Python 3.11, FastAPI + uvicorn for mocks, pymongo, httpx, pytest, `sentence-transformers` for local embeddings. Any LLM provider for the planner, behind a small interface.

## 18. Build order (with gates)

| # | Phase | About | Gate |
|---|---|---|---|
| 0 | Setup: repo, Atlas cluster, collections, indexes, schema validation | 10 min | Can write and read a step document |
| 1 | Mock systems with fault switches | 45 min | Each fault can be triggered on demand |
| 2 | State machine, write-ahead intent, idempotency | 50 min | Happy path test passes |
| 3 | Verifier and unknown resolution | 40 min | `timeout_after_apply` yields exactly one refund |
| 4 | Lease, resume, speech gate (text interface) | 40 min | Kill-and-resume test and zero unsupported claims |
| 5 | Vector Search adaptation | 40 min | Different-wording field rename retrieves the earlier fix |
| 6 | Demo script and metrics report | 30 min | Clean end-to-end run |

Stretch, in this order: dispute guard (section 11), voice layer, extra faults (duplicate or out-of-order events, partial refunds). If time runs short, cut stretch items first. Never cut the verifier, the resume test, or the Vector Search gate.

## 19. Non-goals

- No real payments or card data; mock data only, with orders referenced by ID.
- No fraud decisions or deciding whether a refund should be approved.
- No chargeback evidence or dispute response handling.
- Voice is an optional front end. The core is the task engine underneath it.

## 20. Instructions for Claude Code

1. Start with phase 0 and 1, then confirm the mocks work by hand before building the agent.
2. Keep state-changing logic deterministic and unit-tested. The LLM only plans and phrases.
3. After each phase, run its gate test. Do not start the next phase until it passes.
4. Write tests from the matrix in section 14 as you go, not at the end.
5. Ask before adding dependencies beyond section 17 or changing the data model.
