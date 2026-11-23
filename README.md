# North Bergen Constituent Chatbot (Deployable Backend)

A standalone Node.js + Express version of the Township of North Bergen
constituent chatbot, ready to deploy to Render. It reproduces the verified
behavior of the in-house prototype:

- Bilingual English / Spanish chat UI in township burgundy (#6f1d2f) and gold,
  with quick-question chips.
- Deterministic answers from a verified local index (`data/index.json`) in
  the house style: one natural sentence that directly answers first, details
  and steps next, contact phones, addresses and source links gathered in a
  Contact block at the end.
- "When is the next commissioners meeting?" is computed from the full
  verified 2026 Board of Commissioners schedule (`data/meetings.json`,
  rendered from northbergen.org/Meetings and checked November 20, 2026),
  using the current date in America/New_York.
- Questions the index does not cover are answered by the Meta Model API
  (Muse Wonder) **only if** `MODEL_API_KEY` is set, and only with context
  drawn from the approved trusted sources list (`data/trusted-sources.json`).
  If the model has no covering source, or no key is set, the answer is the
  Township Help Desk fallback (201-875-9110) rather than a guess.
- Emergencies (fire, crime in progress, medical) get a 911 redirect.
- The chatbot never collects personal information.

## Files

- `server.js` — Express server, answering logic, model fallback.
- `public/index.html` — chat UI (no build step).
- `data/index.json` — verified topic index (EN + ES).
- `data/meetings.json` — verified 2026 Board of Commissioners schedule.
- `data/trusted-sources.json` — approved source list, enforced for model
  context. PSE&G is listed as NOT approved.
- `render.yaml` — Render blueprint (one Starter web service, $7/month).
  Storage is JSON files in the repo plus in-memory runtime state, so no
  database service is needed for the test deployment.
- `.env.example` — environment variable names only. No secrets in this repo.

## Run locally

```bash
npm install
npm start            # http://localhost:3000
curl http://localhost:3000/health
curl -X POST http://localhost:3000/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"Who is the mayor?"}'
```

## Deploy to Render (exact steps, needs a Render account)

1. Put this folder in a Git repository (GitHub, GitLab or Bitbucket) and push
   it. Do not commit a `.env` file or any API key.
2. In Render, sign in with the account that will own the service (for the
   test, the VMMI account), then choose **New +** > **Blueprint**, and select
   the repository. Render reads `render.yaml` and proposes one web service
   named `north-bergen-chatbot` on the Starter plan ($7/month). Confirm and
   create it. (Manual alternative: **New +** > **Web Service**, connect the
   repo, set Build Command to `npm install`, Start Command to
   `node server.js`, instance type Starter, and Health Check Path to
   `/health`.)
3. When prompted for `MODEL_API_KEY` (marked `sync: false` in the
   blueprint), paste the Meta Model API key from the Model API dashboard at
   dev.meta.ai (API keys). It is stored by Render as a server secret and is
   never in the repo. To run the first test without the model, leave it
   blank; uncovered questions will return the Help Desk fallback.
4. Deploy. Render builds with `npm install` and starts `node server.js`.
5. Verify: open `https://<your-service>.onrender.com/health`. It returns
   `{"ok": true, "modelConfigured": true, ...}` once the key is set (the key
   value itself is never returned). Open the service URL and ask the test
   questions: next commissioners meeting, who is the mayor, handicap space,
   birth certificate.
6. Moving it later: the same repo deploys unchanged under a township-owned
   Render account. Create the service there, set `MODEL_API_KEY` in that
   account, point the township's chosen web address at it, and have the
   northbergen.org site admin paste the embed snippet that points at the new
   address. Nothing needs to be rebuilt.

## Notes and limits

- The meetings schedule is a verified snapshot of the 2026 calendar. Update
  `data/meetings.json` when the township posts a new schedule, and update
  `lastChecked` in `data/index.json` when topics are re-verified.
- Model usage is billed by Meta against the account the key belongs to, at
  $4.00 per million input tokens, $0.20 per million cached input tokens and
  $20.00 per million output tokens. Set the spending cap on the Meta account
  itself (the test cap agreed for this project is $10).
- Answers are guidance from official township sources, not official notice.
  A Clerk's-office review and privacy/records sign-off are still required
  before a public launch on northbergen.org.

## Question logging

Every `/api/ask` request is logged so unanswered questions can be reviewed
and used to improve the verified index.

What IS stored:

- Timestamp and language of the question.
- For questions the index matched: the matched topic id only (counts of
  which topics get asked about). The matched question text is NOT stored.
- For questions the index did NOT match (Help Desk fallback or model
  fallback): the question text, and whether the model fallback was used.
  This is the list that shows where the index has gaps.

What is NOT stored: names, contact details, or any personal information
(residents are never asked for any), and matched question text.

Where the log lives:

- Each entry is written to `logs/questions.jsonl` in the service directory.
  Render's filesystem is ephemeral, so that file only lasts while the
  instance lives and resets on redeploys and restarts.
- Each entry is ALSO emitted as a structured console line prefixed
  `CHATLOG`, which lands in the Render service logs (dashboard > service >
  Logs) and can be searched and exported from there. Treat the Render logs
  as the durable copy.

Review endpoint:

- `GET /api/admin/unanswered` returns the unmatched questions, grouped so
  near-duplicates (same words, different case or punctuation) show as one
  entry with a count, sorted by count.
- It is enabled ONLY when the `ADMIN_TOKEN` environment variable is set.
  Set it in the Render dashboard: service > Environment > Add Environment
  Variable, key `ADMIN_TOKEN`, value a long random string of your choosing.
  The service redeploys automatically.
- Call it with the header `x-admin-token: <your ADMIN_TOKEN>`. Without the
  env var set the endpoint returns 404; with a missing or wrong token it
  returns 401.
