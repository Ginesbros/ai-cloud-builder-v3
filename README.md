# AI Cloud Builder v3

Autonomous multi-agent system that plans, builds, debugs, and ships software using a panel of AIs — each one assigned to its strength. Backed by Supabase, GitHub, and a Playwright sandbox. Includes a built-in dashboard UI.

## Who does what

| Role | AI | What it does |
|---|---|---|
| Planner | **Claude Opus 4.5** | Reads the goal, breaks it into a typed task list |
| Researcher | **Perplexity Sonar Pro** | Live web search, citation-backed package picks |
| Librarian | **NotebookLM / Gemini 2.5 Pro** | Digests attached PDFs / docs |
| Developer | **GPT-4.1-mini** (frontend/setup/test/deploy) **GPT-4.1** (backend/database/integration) | Writes code |
| Debugger | **GPT-4.1** | Fixes failed builds in retry loops |
| Reviewer panel | **Claude Sonnet 4.5 + Gemini 2.5 Pro + Grok 4** | Three independent code reviews after every task |
| Designer | **Nano Banana** (Gemini 3.1 Flash Image) | Generates logos / hero images / OG images |
| Specialist | **Manus** | Hands off multi-hour autonomous work |
| Videographer | **Higgsfield** | Renders demo / marketing videos |

Full routing rules in [docs/ROLE_MATRIX.md](docs/ROLE_MATRIX.md).

## What's in this repo

```
.
├── package.json
├── render.yaml                   # API + Worker deploy config for Render
├── .env.example                  # All env vars
├── supabase/schema.sql           # Postgres schema
├── public/                       # Dashboard UI (vanilla HTML/CSS/JS)
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── src/
    ├── server.js                 # Express API (with static dashboard)
    ├── worker.js                 # Background worker (with stale-lock recovery)
    ├── lib/
    │   ├── supabase.js
    │   └── logger.js
    ├── services/
    │   ├── orchestrator.js       # Plan -> dev -> debug -> review -> ship
    │   ├── budget.js
    │   ├── github.js
    │   ├── vercel.js
    │   └── taskLocks.js          # Atomic claim + stale-lock recovery
    ├── agents/
    │   ├── modelRouter.js
    │   ├── jsonUtils.js
    │   ├── openaiClient.js
    │   ├── perplexityClient.js
    │   ├── claudeClient.js
    │   ├── geminiClient.js
    │   ├── grokClient.js
    │   ├── planner.js
    │   ├── developer.js
    │   ├── debugger.js
    │   └── reviewer.js
    ├── sandbox/
    │   ├── commandPolicy.js      # Hardened allow/deny lists
    │   ├── sandboxManager.js
    │   └── smokeRunner.js
    └── tests/
        └── defaultSmoke.js       # Playwright smoke test
```

## Architecture

| Component | Purpose |
|---|---|
| **API** (`npm start`) | Express app on Render. Project creation, status, run-next, run-autonomous, deploy, dashboard |
| **Worker** (`npm run worker`) | Polls Supabase for pending or stale-running tasks, claims atomically, executes |
| **Database** | Supabase Postgres (projects, tasks, project_files, logs, ai_usage, sandbox_runs, approvals, budget_events) |
| **Sandbox** | Local /tmp directory + execa, allow-listed commands only, Playwright smoke tests |
| **AI Providers** | OpenAI required (planner/developer/debugger/reviewer). Claude / Gemini / Grok / Perplexity optional |
| **GitHub** | Auto-creates a private repo per project and pushes generated files via `contents` API |

## Setup

### 1. Supabase
1. Create a Supabase project.
2. Run `supabase/schema.sql` in the SQL editor.
3. Copy the project URL and the service role key into `.env`.
   - `SUPABASE_URL` must be the base URL only (no `/rest/v1` suffix). The app validates this on boot.

### 2. Env vars

Copy `.env.example` to `.env` and fill in:

**Required:** `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GITHUB_TOKEN`, `GITHUB_OWNER`

**Optional:** `PERPLEXITY_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GEMINI_API_KEY`, `XAI_API_KEY`, `VERCEL_TOKEN`

**Production:** set `ADMIN_TOKEN` to a long random string. This protects the `/debug/*` routes. The dashboard accepts `?token=...` once via URL and stores it in localStorage.

### 3. Run locally

```bash
npm install
npx playwright install chromium
cp .env.example .env       # then fill it in
npm start                  # in one terminal — API + dashboard on :3001
npm run worker             # in another terminal — background worker
```

Open http://localhost:3001 to use the dashboard.

### 4. Deploy to Render

`render.yaml` declares two web services. After adding env vars to **both** `ai-cloud-builder-api` and `ai-cloud-builder-worker`, push to GitHub and Render will auto-deploy.

## API endpoints

```
GET  /health
GET  /api/budget
GET  /api/projects
POST /api/projects                                  body: { goal, name?, autonomyMode? }
GET  /api/projects/:projectId
POST /api/projects/:projectId/run-next
POST /api/projects/:projectId/run-autonomous
POST /api/projects/:projectId/deploy

GET  /debug/env-safe          (requires x-admin-token)
GET  /debug/supabase-test     (requires x-admin-token)
```

## Multi-AI orchestration

Every task in a plan has a `type` field. The orchestrator's `modelRouter`
dispatches by task type at execution time:

```
task.type = setup | frontend | test | deploy            → developer (gpt-4.1-mini)
task.type = backend | database | integration            → developer (gpt-4.1)
task.type = design | assets | image                     → designer (Nano Banana)
task.type = video                                       → videographer (Higgsfield)
task.type = specialist | long_running                   → specialist (Manus)
task.type = docs                                        → librarian (NotebookLM)
task.type = review                                      → reviewer panel (Claude+Gemini+Grok)
```

All provider/model assignments are overridable via env (see `.env.example`).
Every optional provider degrades gracefully when its API key is missing.

## Improvements over v3 base

This build includes several hardenings on top of the source-of-truth document:

1. **Stale-lock recovery** — `claimNextTask` picks pending tasks *or* running tasks whose `locked_until` has expired, so a crashed worker no longer leaves tasks stuck.
2. **Hardened sandbox policy** — allow-list extended (Vite, Next.js, pnpm, yarn, lint, typecheck), denylist now blocks command chaining (`;`, `&&`, `|`), command substitution (`` ` ``, `$()`), and secret env reads (`printenv`, `.env`).
3. **Secret scrubbing in sandbox** — execa is invoked with a minimal env (`PATH`, `HOME`, `CI`, `NODE_ENV`, `APP_PORT`) so generated code can never read your API keys.
4. **Robust JSON parsing** — agents (`planner`, `developer`, `debugger`) tolerate fenced ```json blocks and prose-wrapped JSON.
5. **Protected debug routes** — `/debug/env-safe` and `/debug/supabase-test` are gated by `ADMIN_TOKEN` when set.
6. **Worker heartbeat** — `projects.last_worker_heartbeat` is updated after each task so the dashboard can show worker liveness.
7. **Mirror logs to stdout** — `logEvent` also writes to console for easy Render log streaming.
8. **Vercel auto-link** — when `VERCEL_TOKEN` is set, `/api/projects/:id/deploy` attempts a one-shot Vercel project link; otherwise returns a clean manual handoff message.
9. **Dashboard UI** — projects list, plan tasks with status badges, file tree, log stream, sandbox runs, spending bars.

## Operational tips

- Reset stuck tasks: `update tasks set status='pending', assigned_worker_id=null, locked_until=null, attempts=0;`
- Hard-stop the worker: set `WORKER_ENABLED=false` in the worker service env.
- Increase debug loops: `MAX_DEBUG_LOOPS=3`.
- Use a smaller developer model to save credits: `OPENAI_DEVELOPER_MODEL=gpt-4.1-mini`.

## Suggested next improvement

Add a Vercel webhook receiver so a deploy success/failure event flips the project's `status` to `complete` or `deploy_failed` automatically.
