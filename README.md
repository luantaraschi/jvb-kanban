# JVB Kanban

A shared Kanban board and management dashboard for a law firm's team, with an
audit trail on every task change and an AI layer that reads case documents and
proposes who should handle what.

[Case study](https://luantaraschi.dev/en/projeto-jvb.html)

## Overview

The firm's work arrives as documents and turns into tasks, and the manager
needs to know who is overloaded, who is fast at which kind of matter, and what
came in today. This is the tool built for that, in production use.

Everyone on the team works one shared board rather than a private one, so
tasks carry their author and last editor and every change is written to an
activity log. The manager gets a second surface on top: user administration, a
daily close that snapshots the board, and an intelligence panel that turns the
task history into per person, per category performance profiles.

The design constraint worth knowing up front: the AI is additive. Every number
the manager sees is computed from the database first, deterministically. The
model rewrites and annotates that summary, and when it is unavailable, off,
out of quota, or timing out, the panel still works.

## Architecture

```
public/index.html + app.js        static frontend, no build step
        |  fetch /api/*, Bearer token or cookie
        v
Express app (src/app.js)
        |  helmet CSP, cors, JSON body limit 25mb
        +-- src/auth.js ....... JWT, 8h TTL, role guards
        +-- src/routes.js ..... board, team, history, manager, AI
        +-- src/ai.js ......... Gemini, JSON schema constrained
        +-- src/operational-intelligence.js
        |                        deterministic metrics + AI enrichment
        +-- src/storage.js .... Supabase Storage for uploaded PDFs
        v
    PostgreSQL (Supabase)

Deployed on Netlify:
  netlify/functions/api.js .................... the same Express app, wrapped
  netlify/functions/ai-refresh.js ............. cron, every 30 minutes
  netlify/functions/ai-refresh-background.js .. the long running half
```

The same `createApp()` runs locally under `node src/server.js` and in
production through `serverless-http`, so there is one application rather than
a local version and a deployed version that drift apart.

## Engineering Highlights

### Scheduled work that outlives the request timeout

Rebuilding operational intelligence means querying the whole task history,
computing profiles and calling a language model. That does not fit in the
execution window a scheduled function gets.

The work is split in two. `ai-refresh.js` carries the `*/30 * * * *` schedule
and does almost nothing: it fires a request at `ai-refresh-background.js` and
returns 202 immediately. The background function is the one that runs the
expensive job. They authenticate to each other with a shared secret in the
`x-ai-refresh-secret` header, so the background endpoint cannot be triggered
by anyone who finds the URL.

If no deploy URL is available in the environment, the scheduled function falls
back to running the refresh inline rather than silently doing nothing. It
degrades to slow, not to broken.

### The metrics are computed, then the AI is allowed to comment

`refreshOperationalIntelligence` runs in a fixed order. `buildManagerContext`
pulls the real task data. `computePerformanceProfiles` derives the numbers:
completion counts, average time to done, review and protocol rates, keyword
hits per category, with a sample size and a confidence value attached to each
profile. `buildHeuristicSnapshot` turns that into a complete, usable report
with no model involved.

Only then does `buildAiSnapshot` get a chance to enrich it, and it is called
with `.catch(() => null)`. A model failure produces `null`, the heuristic
snapshot is persisted unchanged, and the manager sees real numbers without the
prose. The snapshot and every performance profile are written in a single
transaction, so a partial refresh cannot leave the panel showing profiles that
disagree with the report they came from.

### Constrained generation, and answers checked against the data

Every model call goes through `requestStructuredJson`, which sends a full JSON
Schema in `responseJsonSchema` with `temperature: 0.2`, so the reply is parsed
rather than scraped. The system prompt states the rule directly: use only the
provided context, invent nothing.

That is not trusted on its own. Every response passes through a sanitizer
before it is stored. `sanitizeEmployeeFeedback` reconciles each entry against
the real `employeeMetrics`, backfilling names from the database rather than
from the model and substituting explicit defaults for missing fields, so a
half filled response renders as "no feedback generated" instead of as blanks.
Task assignment is stricter: `sanitizeAssignmentCandidates` filters the
model's suggestions against the actual roster and drops any `userId` that does
not exist, falling back to the computed candidate list when nothing survives.
The model cannot assign work to a person who is not there.

Calls are wrapped in an `AbortController` set to `AI_TIMEOUT_MS`, and the
error paths map to distinct statuses instead of a generic 500: 503 when the AI
is disabled or unkeyed, 502 for an upstream error or an empty completion, 504
on timeout.

### Two authorization layers, and a complete audit trail

`requireAuth` and `requireManager` are separate middleware, and both reload
the user from the database on every request rather than trusting the token's
claims. Deactivating a user takes effect on their next request; their unexpired
JWT stops working immediately, because `loadActiveUser` rejects an inactive
row. Passwords are bcrypt hashed at cost 12.

Task mutations write to `task_activity` with the action, the actor, the target
user and `before_json` and `after_json` snapshots. For a firm where task
assignment is a matter of professional responsibility, who moved what and when
is not an optional feature. The schema enforces the rest with `CHECK`
constraints on roles, task status and AI run kinds, so invalid states are
rejected by Postgres rather than by application code alone.

### PDF intake as a reviewed queue, not an automatic action

An uploaded case document is parsed with `pdf-parse`, stored in Supabase
Storage, and analyzed into task suggestions with a proposed assignee, category
and priority. Those suggestions land in `ai_pending_document_suggestions` with
the document in an `uploaded` state.

Nothing is created until a manager applies them, moving the document to
`analyzed` and then `applied`. When the model cannot produce usable
suggestions, `buildFallbackDocumentTasks` generates them from the performance
profiles instead, so an upload always yields something to review. The AI
proposes; a person decides.

## Tech Stack

| Layer | Choice | Role in this project |
|---|---|---|
| Frontend | Static HTML and vanilla JS | Board and panels, no build step |
| Server | Express 4 | API, also wrapped for serverless |
| Auth | jsonwebtoken, bcryptjs | 8 hour JWTs, cost 12 hashes |
| Hardening | helmet, cors | CSP, origin locked in production |
| Database | PostgreSQL on Supabase | Tasks, history, audit, AI artifacts |
| Storage | Supabase Storage | Uploaded PDFs |
| AI | Gemini 2.5 Flash | Schema constrained JSON generation |
| Documents | pdf-parse | Text extraction before analysis |
| Hosting | Netlify Functions | API, scheduled and background jobs |

## API

The API is grouped into five areas: authentication (`/api/auth/*`), the board
(`/api/tasks/*`), the team roster (`/api/team`), the daily history
(`/api/history/*`), and the manager surface (`/api/manager/*`) which holds user
administration and every AI endpoint. Manager routes are gated by
`requireManager`; everything else by `requireAuth`.

Route definitions are in [`src/routes.js`](src/routes.js).

## Testing & Reliability

There is no automated test suite in this repository, and no CI. It is worth
stating plainly, because the parts most worth testing are the deterministic
ones: `computePerformanceProfiles`, `detectCategories`, `scoreKeywordHits` and
the normalizers in `operational-intelligence.js` are pure functions over data
already shaped by the caller.

What the code does have is failure handling that has been thought through:
transactional writes for multi table updates, a schema whose `CHECK`
constraints reject invalid states, timeouts and mapped status codes on every
external call, an AI path that degrades to deterministic output, and an
`initDb()` that memoizes a single idempotent schema run per process, clearing
its cached promise on failure so a transient database error does not leave
the process permanently convinced it has already migrated.

## Running Locally

Requires Node 18+ and a Postgres database. Supabase's pooler connection string
works directly.

```bash
cp .env.example .env    # fill in DATABASE_URL, JWT_SECRET, ADMIN_* at minimum
npm install
npm run setup:db        # creates the schema, ensures an active manager exists
npm run dev
```

Then open `http://localhost:3000` and sign in with the `ADMIN_USERNAME` and
`ADMIN_PASSWORD` you set. The reference schema is in
[`db/schema.sql`](db/schema.sql).

The AI features are optional. Leave `AI_ENABLED=false` or omit
`GEMINI_API_KEY` and the board, the audit trail and the manager panel all work;
the AI endpoints return 503 with an explanation.

Deployment to Netlify is configured in `netlify.toml` and needs the same
variables set in the site environment, plus `AI_REFRESH_SECRET` for the
scheduled refresh.

## Known Limitations

- No automated tests, as described above.
- `JWT_SECRET` falls back to a hardcoded development string when unset, which
  is convenient locally and dangerous if it ever reaches production unset.
- Operational intelligence is recomputed on a schedule rather than
  incrementally, so the panel can be up to 30 minutes behind the board.
- The frontend is a single static page with no build step. That keeps
  deployment trivial and puts a ceiling on how far the UI can grow.

## License

Internal tool built for JVB Advocacia.
