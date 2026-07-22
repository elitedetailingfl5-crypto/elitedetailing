# Elite Detailing — AI Agent Automation System

A 12-agent AI automation backend for Elite Detailing, connected to GoHighLevel (GHL), with a live black-and-gold dashboard.

## What's included

- **`server.js`** — Express backend with 12 fully implemented agents, hourly cron scheduling, GHL API integration, and a JSON REST API.
- **`public/index.html`** — Auto-refreshing dashboard (black & gold) showing live agent status, metrics, recommendations, and a manual "Sync Now" button.
- **`data/agent-results.json`** — Persisted results so a server restart doesn't lose the last sync (auto-created, gitignored).

## The 12 agents

1. Lead Qualification Bot
2. Instagram Content Calendar
3. Google LSA Optimizer
4. SEO Content Generator
5. Referral Automation Agent
6. Email Nurture Agent
7. Ad Creative Generator
8. Sales Objection Handler
9. Financial Dashboard
10. Job Scheduling & Dispatch
11. Quality Control Agent
12. Crew Coordination Hub

Each agent reads from a shared GHL data snapshot (contacts, opportunities, pipelines) pulled once per sync cycle, and returns `{ name, status, metrics, recommendations, actions }`.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set GHL_API_KEY + GHL_LOCATION_ID
npm start
```

Then open **http://localhost:3000**.

## Configuration (`.env`)

| Variable | Description |
|---|---|
| `GHL_API_KEY` | GoHighLevel Private Integration Token (Settings → Business Profile → Private Integrations) |
| `GHL_LOCATION_ID` | Your GHL sub-account/location ID |
| `GHL_API_BASE` | GHL API base URL (default `https://services.leadconnectorhq.com`) |
| `PORT` | Server port (default `3000`) |
| `AGENT_CRON_SCHEDULE` | Cron expression for auto-runs (default `0 * * * *` = hourly) |
| `MONTHLY_LSA_BUDGET` | Used by the LSA Optimizer agent to compute ROAS |
| `MONTHLY_LEAD_VOLUME_TARGET` | Used by the Lead Qualification Bot for context |

## How it runs

- On boot, all 12 agents run immediately so the dashboard has data right away.
- After that, `node-cron` re-runs all agents on `AGENT_CRON_SCHEDULE` (hourly by default).
- The dashboard polls `/api/status` and `/api/agents` every 30 seconds.
- Clicking **Sync Now** calls `POST /api/sync`, which triggers an immediate off-schedule run.

## Resilience

If the GHL API is unreachable or the key is missing/invalid, each GHL call is wrapped in a try/catch that logs the error and returns an empty result instead of throwing — agents still run and the dashboard shows a "GHL: Offline / degraded" status instead of crashing the server.

## API endpoints

- `GET /api/status` — connection + sync state
- `GET /api/agents` — latest results for all 12 agents
- `GET /api/history` — last 50 sync run summaries
- `POST /api/sync` — trigger an immediate sync
- `GET /health` — health check

## Security note

Your GHL API key was shared in plain text during this session. Treat it as compromised — **rotate/regenerate it in GoHighLevel** (Settings → Private Integrations) and put the new key only in your local `.env` file, which is gitignored and never committed.
