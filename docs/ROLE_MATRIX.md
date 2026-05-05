# AI Role Matrix — AI Cloud Builder v3

This is the source of truth for which AI does what. The orchestrator uses
**smart task-type routing**: every task in a plan has a `type` field, and the
router picks the best-of-breed model for that type at execution time.

## Core build roles (every project)

| Role | Primary model | Why this model | When it runs |
|---|---|---|---|
| **Planner** | Claude Opus 4 (claude-opus-4-5) | Best long-form reasoning, breaks goals into clean executable tasks | Once per project (`createProject`) |
| **Researcher** | Perplexity Sonar Pro | Live web search with citations for tech choices, packages, breaking-change risks | Inside the planner, before the plan JSON is written |
| **Librarian** | NotebookLM | Digests PDFs/docs the user attaches into structured context | Inside the planner when `goal` includes attached docs |
| **Developer** | GPT-4.1-mini (default) — escalates per task type below | Cheap, fast, extremely capable for code generation | Every `development`/`frontend`/`backend` task |
| **Debugger** | GPT-4.1 (full) | Stronger reasoning needed when fixes are non-obvious | Each failed verification loop (max 2) |
| **Reviewer panel** | Claude Sonnet 4.5 + Gemini 2.5 Pro + Grok 4 | Three independent perspectives catch what one misses | After every successful task |
| **Designer** | Nano Banana (gemini-3.1-flash-image-preview) | Generates logos, hero images, OG images, favicons | When task type is `design` or `assets` |
| **Videographer** | Higgsfield | Generates demo/marketing videos for shipped projects | When task type is `video` (post-deploy) |
| **Specialist** | Manus | Long-running autonomous agent for multi-hour complex tasks | When task type is `specialist` (planner flags it) |

## Task-type → model routing

The planner emits one of these task types. The orchestrator routes accordingly:

| Task type | Owner agent | Model | Notes |
|---|---|---|---|
| `setup` | developer | gpt-4.1-mini | Project scaffold, package.json |
| `frontend` | developer | gpt-4.1-mini | UI, components, styles |
| `backend` | developer | gpt-4.1 | API routes, DB integration — needs more reasoning |
| `database` | developer | gpt-4.1 | Schema design, migrations |
| `integration` | developer | gpt-4.1 | Third-party API wiring |
| `test` | developer | gpt-4.1-mini | Unit + smoke tests |
| `design` | designer | nano-banana | Generates `public/logo.png`, `public/og.png`, etc |
| `video` | videographer | higgsfield | Posts to `project_assets` table after build |
| `docs` | librarian | notebooklm | When attaching reference PDFs |
| `specialist` | specialist | manus | Multi-hour autonomous tasks |
| `review` | reviewer | claude+gemini+grok | Final pre-deploy review |
| `deploy` | developer | gpt-4.1-mini | Vercel handoff steps |

## Cost-aware behavior

- **Default to mini.** First attempt of every dev task uses `gpt-4.1-mini`.
- **Escalate on retry.** If a task fails verification, the debugger uses full `gpt-4.1`.
- **Reviewers are read-only.** They never push code — only emit review notes
  that the user (or a future v4 auto-fix loop) can act on.
- **Optional providers degrade gracefully.** Missing `ANTHROPIC_API_KEY` /
  `XAI_API_KEY` / `GOOGLE_GEMINI_API_KEY` / `MANUS_API_KEY` / `HIGGSFIELD_API_KEY`
  / `NOTEBOOKLM_API_KEY` returns a "not configured" stub so the build still works
  with just OpenAI + Perplexity.

## Env-var override map

Every model assignment is overridable per env var so you can tune without
touching code. Defaults shown:

```
# Planner / debugger / reviewer
PLANNER_PROVIDER=anthropic                 # openai | anthropic
PLANNER_MODEL=claude-opus-4-5
DEBUGGER_PROVIDER=openai
OPENAI_DEBUGGER_MODEL=gpt-4.1
REVIEWER_CLAUDE_MODEL=claude-sonnet-4-5
REVIEWER_GEMINI_MODEL=gemini-2.5-pro
REVIEWER_GROK_MODEL=grok-4

# Developer per task type
DEV_DEFAULT_MODEL=gpt-4.1-mini
DEV_BACKEND_MODEL=gpt-4.1
DEV_DATABASE_MODEL=gpt-4.1
DEV_INTEGRATION_MODEL=gpt-4.1

# Image / video / specialist
NANO_BANANA_MODEL=gemini-3.1-flash-image-preview
HIGGSFIELD_MODEL=higgsfield-v1
MANUS_BASE_URL=https://open.manus.im
NOTEBOOKLM_API_BASE=https://generativelanguage.googleapis.com/v1beta
```

## Sequence per task

```
plan (Claude Opus + Perplexity) ──► tasks[]
        │
        ▼
for each task:
   ┌───────────────────────────────────────────────┐
   │ router(task.type)                             │
   │   design  → designer (Nano Banana)            │
   │   video   → videographer (Higgsfield)         │
   │   specialist → specialist (Manus)             │
   │   docs    → librarian (NotebookLM)            │
   │   *       → developer (OpenAI, model by type) │
   └────────────────┬──────────────────────────────┘
                    │
              run sandbox + smoke
                    │
              fail? → debugger (GPT-4.1) → retry
                    │
                  pass
                    │
              reviewer panel (Claude + Gemini + Grok, parallel)
                    │
              push to GitHub → Vercel handoff
```
