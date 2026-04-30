# EasyFix_Backend

Unified Node.js/Express backend for the EasyFix platform. Serves `CRM_UI`, `Client_UI`, and `EasyFixer_App` from a single service, plus external client API integrations (e.g. Decathlon) via a legacy-compatible contract at `/api/integration/v1/*`.

See `CLAUDE.md` for the full working notes. Master spec is `EasyFix Docs/EasyFix_Platform_Blueprint.md`.

## Quick start

```bash
cp .env.example .env   # fill DB credentials + JWT_SECRET
npm install
npm run test:db        # verify MySQL connection
npm run dev            # start on :5100 with hot reload
```

## Endpoints available after Step 1

| Route | Purpose |
|---|---|
| `GET /api/health`              | Process uptime (modern response shape) |
| `GET /api/health/db`           | MySQL connectivity check |
| `GET /api/integration/_ping`   | Legacy-shape response canary |

Everything else is stubbed in `routes/index.js` and will be implemented in subsequent steps per the blueprint.

