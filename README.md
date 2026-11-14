# mongodb-hackathon: Refund Guard (backend)

A voice AI refund agent whose governed memory (MongoDB Atlas + Vector Search) stops refund scammers who change their story and their account.

- Problem: [PROBLEM.md](PROBLEM.md)
- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- **Frontend:** separate repo, [`mongodb-hackathon-frontend`](../mongodb-hackathon-frontend) (clone it next to this one)

```
Desktop/Coding/
  mongodb-hackathon/            ← this repo: API on http://localhost:3000
  mongodb-hackathon-frontend/   ← UI on http://localhost:5173 (proxies API calls to :3000)
```

## Run the backend

```bash
cd backend
cp .env.example .env   # fill in values (see below)
npm install
npm run ping           # test the MongoDB connection
npm run seed           # schema, vector index and demo data
npm run agent          # create/update the ElevenLabs voice agent (saves ELEVENLABS_AGENT_ID)
npm run dev            # API on http://localhost:3000
npm run demo           # optional: play the demo story from the terminal
```

Then start the frontend (in the other repo): `npm install && npm run dev`, open http://localhost:5173 in Chrome.

## Environment (`backend/.env`)

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_USER`, `MONGODB_PASSWORD`, `MONGODB_HOST`, `MONGODB_DB` | ✅ | Atlas connection (your IP must be on the Atlas access list) |
| `FOOTPRINT_SECRET` | ✅ | Hashes addresses/cards/devices (`openssl rand -hex 32`); changing it needs `npm run seed` |
| `ELEVENLABS_API_KEY` | for voice | Server-side only, never sent to the browser |
| `ELEVENLABS_AGENT_ID` | for voice | Written by `npm run agent` |
| `CORS_ORIGINS` | optional | Browser origins allowed to call the API. Default `http://localhost:5173,http://localhost:4173` |
| `EMBEDDING_PROVIDER`, `VOYAGE_API_KEY` | optional | `local` (default, no key) or `voyage` |
| `PORT` | optional | Default `3000` |

## How the frontend talks to the backend

| Frontend uses | Backend endpoint |
|---|---|
| Health / connection badge | `GET /health` |
| Dashboard data (merchant-scoped via `x-merchant-id`) | `GET /admin/state` |
| Live updates (MongoDB change stream → SSE) | `GET /admin/events` |
| Voice: start a call | `GET /voice/config`, `GET /voice/signed-url` |
| Voice: agent tools during the call | `POST /tools/check-claim`, `POST /tools/issue-refund` |
| Voice: store transcript after the call | `POST /voice/calls` |
| Analyst actions | `POST /tools/record-outcome`, `POST /tools/forget-me`, `POST /admin/memories/:id/{correct,expire}` |
| Demo controls | `POST /admin/disputes`, `POST /admin/reset` |

In development the frontend calls its own origin and Vite proxies `/tools`, `/admin`, `/voice` and `/health` to `http://localhost:3000`, so no CORS is involved. Direct browser calls are allowed only from `CORS_ORIGINS`.

## Troubleshooting

- **`Server selection timed out`**: your public IP changed; add it under Atlas → Network Access.
- **Frontend shows "Backend unreachable"**: start the backend first (`npm run dev` here).
- **"Voice not configured"**: set `ELEVENLABS_API_KEY` and run `npm run agent`.
- The server prints a `libc++abi ... mutex lock failed` line when stopped; that's the local embedding library on shutdown and is harmless.
