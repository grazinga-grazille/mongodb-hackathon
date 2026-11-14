# mongodb-hackathon — Refund Guard

A voice AI refund agent whose governed memory (MongoDB Atlas + Vector Search) stops refund scammers who change their story and their account.

- Problem: [PROBLEM.md](PROBLEM.md)
- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)

## Run the backend

```bash
cd backend
cp .env.example .env   # fill in MongoDB credentials + FOOTPRINT_SECRET (openssl rand -hex 32)
npm install
npm run ping           # test the connection
npm run seed           # schema, vector index and demo data
npm run dev            # API + dashboard on http://localhost:3000
npm run demo           # play the demo story (second terminal)
```
