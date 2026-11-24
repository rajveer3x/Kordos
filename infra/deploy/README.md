# Deployment and recovery

## Build and release

```sh
docker build --target web -t kordos-web:release .
docker build --target api -t kordos-api:release .
docker build --target worker -t kordos-worker:release .
docker build --target migrate -t kordos-migrate:release .
```

The web target serves the Vite build as static files. A static host can serve the same `apps/web/dist` directory. Use an HTML fallback for client routes, preserve 404s for missing assets, revalidate `index.html`, and cache hashed assets. Retain the prior release's hashed assets during a rolling change so open tabs can load their lazy routes.

Terminate HTTPS at the ingress and set `APP_ORIGIN` to the public origin. Forward `/api/` on the same origin to the API. Forward `/realtime/` with HTTP/1.1 Upgrade and Connection headers and an idle timeout of at least 75 seconds. Preserve the host and Origin. The included Nginx site is an internal HTTP proxy behind ingress and expects Docker DNS. Set `KORDOS_API_UPSTREAM` to the internal service URL, with no trailing slash. Keep internal API and worker ports off the public network. Pass provider webhook bodies intact and disable request-body and raw query-string logging at ingress.

Each API replica uses the same environment-specific Redis service for sessions, presence and the Socket.IO Redis adapter. Kordos uses WebSocket transport. If polling is enabled on both client and server later, configure sticky routing for the Engine.IO session from its first request through upgrade. Redis coordinates replicas. Each socket's feed still rechecks authorization and catches up from PostgreSQL using its last durable cursor.

Run separate environments with separate databases, Redis instances, buckets, backups, Auth0 apps, connector credentials and webhook bindings. Provision pgvector and the `kordos_app` and `kordos_brief_worker` logins as non-owner roles without BYPASSRLS. Keep `MIGRATION_DATABASE_URL` available only to the one-off migration job. Inject runtime secrets from the platform's secret manager. Keep the connector encryption key recoverable for encrypted database backups. Set `NODE_ENV=production` and keep `ENABLE_FOUNDATION_JOBS` disabled. Give the worker enough termination grace to finish bounded provider requests and flush the database receipt. A hard kill relies on durable queue leases.

Record the image digests and pre-release database restore point. Run the migration image once before rolling the API and worker. Add compatible schema and functions first, deploy readers and writers, backfill with bounded batches, and remove obsolete structures in a later release after prior readers are retired. The Feature 20 migration adds worker-only functions and keeps prior functions available. Check `/api/health/live` and `/api/health/ready` separately, then verify sign-in, an API write, worker catch-up and a WebSocket reconnect. Readiness covers PostgreSQL, Redis and the bucket. Use worker backlog and completion signals for processing health.

Actual staging or production release activity requires explicit authorization.

## Telemetry and quotas

Collect structured stdout from API and worker. Aggregate by service, event, queue, provider and outcome. Keep workspace and operation UUIDs as searchable fields with restricted access. Protect logs with an environment-specific retention policy. The records below omit source passages, provider request and response bodies, cookies, credentials and inbound query strings.

| Signal                                                                       | Use                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.request`                                                               | Join the server-generated `X-Request-ID` with status, route template and latency. Check latency and 5xx by route.                                                                                                                                                                                                                                                                         |
| `connector.receipt`, `provider.connector`, `execution.approved`, `queue.job` | Follow the receipt or execution UUID from acceptance to processing. Compare active, completed and failed counts, BullMQ queue age, run time and retry count. A completed queue job can record a durable refusal or failure. Read its canonical receipt for the business outcome.                                                                                                          |
| `queue.backlog`, `queue.backlog_unavailable`                                 | Sample durable pending counts, oldest age in seconds and recorded retries every 30 seconds. Queues with zero eligible rows are absent. Take the maximum across replicas for the same interval. Alert on missing samples, sustained growth or a GitHub reconciliation requirement. Inbox and connector work scheduled for the future is excluded. Brief age uses the original intake time. |
| `provider.model`                                                             | Track model call latency, HTTP status, usage and optional estimated USD. Calibrate against provider billing. Missing rate or usage fields yield a null estimate.                                                                                                                                                                                                                          |
| `model.quota`                                                                | Check applied limits, denied calls or quota-store failures by opaque workspace ID. Monitor denied counts separately from provider 429s.                                                                                                                                                                                                                                                   |

Set the same `MODEL_INTERACTIVE_DAILY_LIMIT` and `MODEL_INDEX_DAILY_LIMIT` in all API and worker replicas. Defaults are 1,000 interactive requests and 2,000 indexing requests per workspace per UTC day. The interactive limit covers brief extraction, audio transcription, query embeddings and cited answers. Background embedding calls are grouped by workspace and use the indexing limit. Counts represent attempted calls and reset at midnight UTC. Redis loss can reset the counters. Configure provider-side spend controls independently. When Redis cannot confirm allowance or a quota is exhausted, manual work and local search stay available. A rejected indexing request leaves the leased batch eligible for retry.

Set `MODEL_PRICES_USD` to an optional JSON object keyed by `provider/model`. Its rates are `inputPerMillion`, `outputPerMillion` and `audioPerHour` in USD. Use the rates for the deployed account. Connector telemetry measures sync and delivery latency at the batch level.

To follow a source, review revision, execution or audit event, start from its workspace and UUID. In the workspace, follow the review receipt to the effect and audit event. Authorized platform operators can use the following parameterized query on a restricted, read-only database connection. It returns lineage and identifiers without source content.

```sh
psql --set=ON_ERROR_STOP=1 --set=workspace="$KORDOS_WORKSPACE_ID" \
  --set=ref="$KORDOS_OPERATION_ID" --file=infra/recovery/trace.sql
```

## Worker crash or growing queue

1. Compare the API dependency checks, worker exits and backlog samples. Record the oldest age, current count and a representative operation ID. If Redis is unavailable, restore connectivity while preserving the PostgreSQL rows.
2. Restart the worker on the same release and environment. Watch `queue.job` and the canonical job status. Pending database jobs dispatch again. A claimed brief or meeting that lost its worker becomes interrupted when its lease expires. Retry it through its normal UI if still relevant.
3. An uncertain external write may already exist. Check the GitHub receipt and exact delivery reference before retrying. Use the existing execution reconciliation flow. Compare queue age, retry counts and effects after recovery.

## Expired or revoked credentials

1. Check **Settings → Connectors** and `provider.connector` for the installation or scope that failed. Check neighboring scopes to distinguish a revoked grant from a provider-wide incident.
2. Reauthorize the original account or restore the expected GitHub App scope. Keep the installation and mapping IDs. Rotate the provider secret through the secret manager if needed, then restart the processes that consume it.
3. Request a fresh sync and check the cursor and canonical revision. Expired Google cursors trigger a scan of the selected scopes. Mirrors remain subject to current permissions throughout. Keep uncertain GitHub executions in reconciliation until the remote outcome is verified.

## Restore and cutover

Database objectives are a recovery point within 15 minutes and recovery within four hours. Configure encrypted PostgreSQL base backups and continuous WAL archiving with monitoring for a WAL archive gap approaching 15 minutes. Pair each database restore point with recoverable private object versions or an equivalent coordinated inventory. Expire database backups, WAL and noncurrent object versions within 30 days. Keep an independently recoverable record of post-backup access revocations, retention changes and deletions until the oldest eligible backup expires. Test retrieval of the backup keys and the connector key separately from the primary services.

For a versioned S3 bucket, merge a rule for noncurrent versions into the existing lifecycle policy. On a separate, unversioned archive bucket, set current-object expiration to 30 days and verify expiration in an inventory report. For managed PostgreSQL, set recovery-point retention and any exported backup or WAL retention to at most 30 days. Record the effective platform settings in the deployment record.

```json
{
  "Rules": [
    {
      "ID": "expire-kordos-noncurrent-objects",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 }
    }
  ]
}
```

1. Freeze ingress and outbound delivery. Record the failure time, the last durable commit or WAL position, the object inventory watermark and provider receipts. Restore to an isolated network with a separate database, Redis and private bucket. Keep `ENABLE_EXTERNAL_WRITES=false`, no live webhooks, and provider egress disabled while comparing the restored state.
2. Restore the database to the selected point using the hosting platform's PITR process. Check extensions, the migration journal, grants and restricted role behavior. Restore matching object versions to a private destination. For small, quiesced environments the repository's logical alternative uses `pg_dump -Fc` and `pg_restore --exit-on-error` into an empty database with roles present, plus these storage commands. Run snapshot operations after stopping writes and cleanup across both stores. Keep the archive on an encrypted volume. A failed copy should be retried into a fresh empty bucket.

   ```sh
   node infra/recovery/storage.mjs snapshot "$KORDOS_BACKUP_DIR/objects"
   # Set STORAGE_* for the empty recovery bucket before restoring.
   node infra/recovery/storage.mjs restore "$KORDOS_BACKUP_DIR/objects"
   ```

3. Apply post-backup membership and share revocations, deletion markers and updated retention policies using the recovered change record. Run the retention and indexing workers. Verify revoked URLs and citations fail, compare expected missing and restored objects by key and checksum, and check the bucket remains private. If the revocation record is unavailable, hold affected data out of user access until it is reconciled.
4. Compare counts and selected IDs for workspaces, work, source revisions, attachment metadata, outbox, audit and executions at the selected restore point. Verify a restricted source through an authorized account and a denied account. Allow reauthentication on the fresh Redis service. Measure loss from the chosen database point to the incident and recovery time from the incident to verified service.
5. Follow the replay steps below. Reconcile GitHub comments by remote delivery reference and email sends by original provider idempotency key, including effects newer than the restore point. Hold publication if receipts or provider outcomes are uncertain. Reopen access and external writes only after the authorized cutover.

## Event replay

Keep the PostgreSQL outbox and job receipt tables intact. Start workers against the restored database and a fresh Redis instance for an isolated restore. The dispatcher recreates eligible BullMQ jobs from PostgreSQL. Inbox and search index consumers also resume from their durable state. Browser collaboration clients replay from their saved cursor. Compare event IDs, work versions and approval receipts before and after catch-up.

For missed webhook deliveries, use provider redelivery with the original delivery ID and signature where supported. For gaps beyond provider replay, run authorized connector reconciliation from the last durable cursor. Verify that receipt, source revision and action counts converge. Do not alter job keys, mark pending effects complete by hand or re-send a remote write based only on a missing local receipt.

## Rollback

1. Pause the rollout. Stop affected worker replicas before changing versions if they may consume a new command shape. Save the incident window, current image digests and recent effects.
2. Restart the prior API and worker images against the compatible expanded schema and restore the prior web build. Check ingress and readiness, then verify manual edits and queue progress. Keep migrations applied if the schema remains compatible.
3. For data corruption or incompatible writes, use a separate restore and reconcile intervening edits, access changes and external effects before cutover. Verify application counts and permissions before routing traffic back.

## Local rehearsal

```sh
pnpm exec playwright install chromium
pnpm test:recovery --output=test-results/feature-20-recovery
```

The test creates two synthetic Compose projects on loopback and removes only the resources it creates. It starts a model fixture that returns 503, edits work while the model is down, kills and restarts the worker, and restores a logical PostgreSQL dump and SHA-256 checked S3 object into an independent stack. It reauthenticates, replays an event from an earlier cursor and runs a queued approval with its original receipt. It measures local recovery and demonstrates the loss of a write made after the backup.

Managed WAL/PITR, production-sized backups, backup expiration, secret-manager recovery, production TLS and real provider reconciliation remain staging exercises. Record those results separately from local timing.
