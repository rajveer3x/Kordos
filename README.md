# Kordos

Kordos is the AI workspace for software teams. The local foundation includes a web app, an API and a worker. See the [delivery tracker](context/progress-tracker.md) for feature status.

## Local development

Use Node.js 24 or newer, pnpm 10.34.9, and Docker with the Compose plugin.

```sh
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up -d --wait
pnpm db:migrate
pnpm dev
```

Open [Workspace health](http://127.0.0.1:4317/health) and select **Run test job**. The page reports PostgreSQL, Redis and private storage readiness. The worker writes one synthetic result per job ID to PostgreSQL.

```sh
curl -i http://127.0.0.1:4301/api/health/live
curl -i http://127.0.0.1:4301/api/health/ready
```

Readiness returns HTTP 503 when a dependency is down. Liveness checks the API process. The example environment uses loopback ports and synthetic credentials. The migration command uses the migration database role. The API and worker use the limited runtime role. Keep the unauthenticated test-job routes disabled outside local development by omitting `ENABLE_FOUNDATION_JOBS` or setting it to `false`.

Stop the app processes with Ctrl+C. Use `docker compose down` to stop infrastructure and retain its data.

## Deployment and recovery

The same workspace builds static web, API, worker and migration images. The [deployment and recovery runbook](infra/deploy/README.md) covers ingress, secret separation, structured telemetry, model quotas, rollout, rollback, restore and replay. Run `pnpm test:recovery` for the isolated database and private storage rehearsal.

## Auth0 sign-in

Create an Auth0 Regular Web Application that supports authorization code flow and `client_secret_post`. Set `AUTH0_ISSUER` to the tenant issuer URL and set `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET` in the server environment. Add `http://127.0.0.1:4317/api/auth/callback` to the application's Allowed Callback URLs for local development. For a deployment, set `APP_ORIGIN` to its HTTPS origin and allow its corresponding callback URL. Serve the web app and `/api` on that same origin. Auth0 sends the verified email used to redeem invitations.

After sign-in, create a workspace and choose its IANA timezone. In **Settings**, an administrator can create an invitation link, copy it to the recipient, and manage member roles. Invitations expire after seven days, and removing a member revokes their outstanding links to that workspace. To change the last administrator, assign the role to another member first.

## Groq AI

Set `GROQ_API_KEY` in your local `.env` and restart the API and worker. For hosting, set the key in both server environments. Kordos then uses Groq for brief extraction, cited search answers and audio transcription. The defaults are `openai/gpt-oss-20b` for text and `whisper-large-v3-turbo` for audio. Use `GROQ_TEXT_MODEL` or `GROQ_TRANSCRIPTION_MODEL` to choose a compatible Groq model. Groq mode uses local keyword and exact-ID search, with Groq selecting passages for cited answers.

Groq Whisper supplies transcript timestamps. Speaker labels can be added in the meeting's transcript editor. When a provider request fails or reaches its usage limit, the brief and recording stay available for retry, manual planning and pasted transcripts remain available, and search falls back to local passages. Groq Free has model-specific request, token and audio limits. [Groq rate limits](https://console.groq.com/docs/rate-limits) · [Groq data controls](https://console.groq.com/docs/your-data)

## Brief extraction

Open a project and choose **Add a brief** to paste text, or choose **Plan from this revision** in a project document. Use the [Groq setup](#groq-ai) to enable extraction, or set `OPENAI_API_KEY` and `OPENAI_BRIEF_MODEL` in the worker environment for an OpenAI model that supports Chat Completions structured outputs. The worker sends the selected source title and text. It resolves today, tomorrow and weekday phrases using the source revision’s timestamp and the project timezone at intake. You can enter dates or plan manually from the saved brief. [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

The extraction worker uses `BRIEF_WORKER_DATABASE_URL`. Fresh local Compose databases provision this restricted login using the example environment. For a local database volume created before Feature 09, run the migration, then set a password for the worker role from the local PostgreSQL console and add the matching URL to `.env`.

```sh
docker compose exec postgres psql -U kordos_migrator -d kordos
```

```sql
ALTER ROLE kordos_brief_worker LOGIN;
\password kordos_brief_worker
```

## Meeting recordings

Open the **Meetings** tab in a project to create a meeting, add an agenda, and upload an authorized recording or paste a transcript. The worker uses the same restricted database connection as brief extraction. Use the [Groq setup](#groq-ai) for timestamped transcription. The OpenAI option uses `OPENAI_API_KEY` and defaults to `gpt-4o-transcribe-diarize` for automatic speaker labels. Pasted transcripts and suggestion reprocessing run locally. [OpenAI file transcription](https://developers.openai.com/api/docs/guides/speech-to-text)

Recording uploads accept MP3, WAV and M4A up to 20 MB. Set a retention period of 7, 30 or 90 days when creating or editing a meeting. Playback checks project access on each request. Removal and expiry revoke playback and queue deletion of the private object. Saved transcript revisions follow the workspace transcript policy. Approved follow-up keeps its own project access.

## Workspace retention

Workspace administrators can open **Settings → Retention and deletion** to set the number of days to retain audio, transcript revisions, imported source revisions, and audit details. The defaults are 90, 365, 365, and 90 days, respectively. A meeting can expire audio sooner. Transcript age starts when a revision is saved, and imported revisions use the observation time supplied by the connector.

Shortening a policy can make existing evidence unavailable immediately. Meeting playback and private document downloads use authenticated, non-cacheable API URLs. Search filters expired evidence before ranking, and weekly reports resolve proposals and their evidence on every read. Revoking a shared excerpt removes access immediately. The worker deletes the excerpt and its index entries while preserving independently authorized shares, confirmed decisions, and approved work.

The restricted worker connection in `BRIEF_WORKER_DATABASE_URL` runs retention sweeps without a model or connector configured. **Deletion progress** shows pending and finished records by category. PostgreSQL commits each batch with its redactions and search rebuild requests. Audio removal records a durable marker before deleting from private storage and records completion after storage acknowledges the delete. A restarted worker retries unfinished deletion. Audit redaction keeps actor, action, timestamps, and reference IDs. Platform logs such as stdout use the deployment's logging configuration and should contain no source text.

Deployments must expire encrypted database backups and archived WAL within 30 days and apply the same maximum to noncurrent private object versions. In a restore exercise, replay share revocations and deletion markers recorded after the restored snapshot, run retention and rebuild the search index before reopening access. The deployment and restore rehearsal is tracked in [Feature 20](context/feature-specs/20-operability-and-delivery.md).

## Interface preview

With `pnpm dev` running, open the [populated project](http://127.0.0.1:4317/preview/#/projects/checkout) or the [empty project](http://127.0.0.1:4317/preview/#/projects/developer-portal). The preview uses synthetic workspace data in development. The live entry point at `/` routes to sign-in.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

With Compose running and the database migrated, stop any running `pnpm dev` processes before running the browser check. Playwright starts all three app processes and temporarily stops Redis in the local Compose project. The identity check uses a loopback OIDC fixture on port 4399, configurable with `TEST_OIDC_PORT`. Brief extraction uses a loopback model fixture on port 4429, configurable with `TEST_BRIEF_MODEL_PORT`.

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

To check recovery manually, run `docker compose stop redis` while the health page is open. Wait for **Degraded**, then submit a test job and keep its ID. The worker logs the Redis connection failure. Run `docker compose start redis` and watch the same job become **Completed**.

## Inbox delivery

The worker schedules deadlines and processes in-app delivery automatically. Configure `BRIEF_WORKER_DATABASE_URL`, `INBOX_EMAIL_URL`, `INBOX_EMAIL_KEY` and `INBOX_EMAIL_FROM` together to enable email. A deployed sender can use the Resend `/emails` endpoint and a verified sending address. The worker uses `APP_ORIGIN` for links and sends messages with [Resend-compatible idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).

For local development, start `node infra/email/sink.ts`, enable the example email variables, and open [the local email sink](http://127.0.0.1:4491/messages) to inspect captured messages. The sink keeps messages in memory and listens on loopback.

Notification preferences are per workspace member. By default, the inbox uses the workspace timezone for delivery and sends no email. Deadline dates include the entire day in the project timezone. The default reminder is at 09:00 project time one calendar day before the deadline, and escalation begins two calendar days after the work becomes overdue. Quiet hours and the 08:00 digest use the member's delivery timezone. Email links open the authorized inbox entry or daily digest.

## Connector runtime

Workspace administrators can inspect connection health in **Settings → Connectors**. A connection owner who leads the destination project can configure its mappings. **Documents → External sources** shows the mirrors and individually shared excerpts that the reader can access. A private provider grant limits mirrors to its owner with project access, even if the mapping selects a project audience. Explicitly shared excerpts remain available to the project until the sharer or a project lead revokes them.

Feature 13 includes the fixture adapter. Configure `CONNECTOR_TOKEN_KEY` in the API and worker with the same 32-byte base64url key, and set `CONNECTOR_FIXTURE_URL` and `BRIEF_WORKER_DATABASE_URL`. A connector credential changed in Settings is encrypted using that key. Keep the key available across deployments. Set a separate `CONNECTOR_FIXTURE_WEBHOOK_SECRET` of at least 32 characters to enable signed fixture deliveries. The [connector browser test](tests/e2e/connectors.spec.ts) starts its own provider and supplies synthetic credentials.

A fixture provider accepts bearer credentials and serves two HTTPS or loopback HTTP endpoints.

| Endpoint                                 | Response                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /scopes/{encodedScope}/entitlement` | A JSON object with `audience` set to `project` or `private`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /scopes/{encodedScope}/changes`     | Changes with `externalId`, `revisionKey`, and `observedAt`. An `upsert` includes `title`, `body`, and an optional HTTPS source URL represented as `url` or null. A `delete` withdraws that object. Return an opaque `nextPage` or a final `checkpoint` and set the other field to null. Requests use `checkpoint` for incremental sync, `rebuild=1` for a complete snapshot and `page` for follow-up pages. Return HTTP 410 when the checkpoint expires. |

To deliver a fixture event, POST a JSON body with `scope` and `changes` to `/api/connectors/fixture/{installationId}/deliveries`. Include the delivery ID in `X-Kordos-Delivery` and HMAC-SHA256 in `X-Kordos-Signature` as `sha256=<hex>`. Sign the installation UUID, a newline, the delivery ID, a newline, and the unchanged request body. The worker verifies entitlement for the selected scope before applying either a sync or a delivery.

Scheduled reconciliation runs every five minutes. Successful scope verification grants mirror access for up to ten minutes. A failed verification clears mirror access and an invalid credential pauses its connection. Disconnect immediately removes access, discards the credential, and cancels queued work. Deferred cleanup removes mirrored text after five minutes.

## GitHub App

Create a GitHub App for Kordos and install it on selected repositories. Grant repository metadata read access and Issues and Pull requests read and write access. Subscribe to Issues, Pull requests and Repository events. Set the webhook URL to the API origin followed by `/api/connectors/github/webhook` and configure `GITHUB_WEBHOOK_SECRET` on the API. Installation and repository access changes trigger verification. [GitHub App installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

Set `GITHUB_INSTALLATIONS` in the API and worker to a JSON object mapping GitHub installation IDs to authorized Kordos workspace UUIDs. Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` on the worker. An administrator who leads the destination project can then open **Settings → Connectors → Connect GitHub repository** and map an installed repository by `owner/repo`. Add further repositories from that installation to the connection. The worker verifies each repository and uses a repository-scoped installation token. Private repository mirrors are restricted to the connection owner with project access.

The project’s Activity tab shows GitHub issues and pull requests. The worker checks for missed updates every five minutes and performs a complete repository scan daily to catch missed deletions. A scan supports up to 50 pages per item type and a 12 MB normalized batch. If a scan exceeds those limits, the connector reports an invalid batch and preserves its checkpoint. Write `Kordos-Work: <work UUID>` in the item title or body, or include the Kordos work URL, to link it to eligible work in the mapped project. A project lead can confirm a match from the source page. Open a source linked to work to draft a comment and submit it from Reviews. Approval binds the repository, issue or pull request, and the exact Markdown. Review displays the delivery reference included in that Markdown. If the network fails after GitHub accepts the comment, Kordos can identify the comment by that reference and the GitHub App author. If reconciliation cannot verify a receipt, the review shows **Reconciliation required**. Audit History can find the approved revision from the published GitHub comment URL.

`pnpm test:e2e --project=github --no-deps` runs against a loopback GitHub API fixture. Set `TEST_GITHUB_PORT` to override the fixture’s default port 4494. Live verification uses a designated GitHub App test installation.

## Google Calendar and Gmail

Enable the Calendar and Gmail APIs in a Google Cloud project and create a web OAuth client. Register `http://127.0.0.1:4317/api/connectors/google/callback` for local development and the corresponding HTTPS URL for the deployed `APP_ORIGIN`. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the same `CONNECTOR_TOKEN_KEY` in the API and worker environment. Google sync uses `BRIEF_WORKER_DATABASE_URL`. Gmail uses the read-only restricted scope, so follow Google’s verification and server-side data requirements for your deployment. [Google web server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server) · [Gmail scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes)

An administrator who leads the destination project can authorize Calendar or Gmail under **Settings → Connectors**, then select a calendar or a Gmail user label and a project. Create a separate connection for each selected scope. Reconnecting requires the Google account that originally authorized the connection. The worker checks access and syncs each selected scope every five minutes.

- Open **Documents → External sources** to preview owner-only sources. For Calendar, use **Add to project meetings** to share the event title and start time with the project. Subsequent event changes update the meeting. Cancellation keeps the transcript, reviewed actions and confirmed decisions. Calendar attendance does not affect project access.
- For Gmail, open one labeled message and preview the exact excerpt before sharing it with the project. Previews use plain text where available and a Gmail snippet otherwise. A share records who shared it and links internally to the individual message revision. Its project copy includes only the excerpt, a generic title and the share attribution. Share or revoke each message individually.

Google sync commits the cursor after the complete batch. An expired Calendar sync token or Gmail history ID triggers a rescan of that connection’s selected scope. Each run has a 55-second provider budget and a 30-page limit, with up to 5,000 Calendar events or 1,000 Gmail message candidates and a 4 MB normalized Gmail batch. A failed batch leaves the saved cursor available for retry. [Calendar sync](https://developers.google.com/workspace/calendar/api/guides/sync) · [Gmail sync](https://developers.google.com/workspace/gmail/api/guides/sync)

Run `pnpm test:e2e --project=google --no-deps` for the loopback Google OAuth and API fixture. Set `TEST_GOOGLE_PORT` to override port 4495. Live verification uses designated Google test accounts and a configured OAuth client.

## Workspace search

Open **Search** from the workspace navigation. Filter by project, source type, owner and source date. Searches are shareable as URLs and use the reader's current access. Search results link to the work item, source revision, decision, transcript passage or shared excerpt. Use a work UUID, `PR #17`, `owner/repo#17` or a GitHub PR URL for an exact lookup.

The worker uses `BRIEF_WORKER_DATABASE_URL` to backfill the text index and process changes. Keyword and exact-ID search run locally. With OpenAI selected, set `OPENAI_API_KEY` and the same `OPENAI_SEARCH_EMBEDDING_MODEL` in the API and worker to enable semantic ranking. Use an embeddings model that accepts 512 dimensions, such as `text-embedding-3-small`. Semantic results appear as embeddings are filled in. If a new query embedding fails, the API uses keyword search. The worker submits eligible titles and passages for embedding. Owner-only GitHub mirrors use keyword and exact-ID search, and Gmail indexing uses explicitly shared excerpts.

Setting `GROQ_API_KEY` enables cited passage selection. With OpenAI selected, configure `OPENAI_SEARCH_ANSWER_MODEL` in the API for a model that supports structured outputs. The API sends the question and up to eight currently authorized passages. The answer displays verbatim source text with attribution, dates and links. When evidence is insufficient or the model is unavailable, the answer shows the available passages. The OpenAI search adapter uses `OPENAI_BASE_URL` unless `OPENAI_SEARCH_BASE_URL` is set.

Run `pnpm test:e2e --project=search --no-deps` for the browser journey and loopback model fixture. Set `TEST_SEARCH_MODEL_PORT` to override port 4496.

## Weekly health and duplicate review

Open **Weekly health** from a project overview. The worker uses `BRIEF_WORKER_DATABASE_URL` to capture each active project's report in its own time zone. Weeks start on Monday. A report becomes eligible for refresh after one minute, and the last successful capture remains available for each week. Decision links are checked against the reader's current access. Weekly reports and duplicate retrieval use local data and need no model credentials.

Open **Review similar tasks** from a task. Suggestions compare open work in the same project by title and deliverable wording, with owners and dependencies visible for comparison. Dismissal applies to the two reviewed task versions. A consolidation proposal names the task to keep and the exact dependencies to add. A project lead must approve it before the worker archives and links the other task. Both histories stay available through the work items.
