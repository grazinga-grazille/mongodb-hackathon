# mongodb-hackathon
## Backend

```bash
cd backend
cp .env.example .env   # fill in MongoDB credentials
npm install
npm run ping           # test the connection
npm run dev            # API on http://localhost:3000
```

CRUD for any collection lives under `/api/:collection` (see `backend/src/server.js`).
