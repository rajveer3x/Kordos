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

## Auth0 sign-in

Create an Auth0 Regular Web Application that supports authorization code flow and `client_secret_post`. Set `AUTH0_ISSUER` to the tenant issuer URL and set `AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET` in the server environment. Add `http://127.0.0.1:4317/api/auth/callback` to the application's Allowed Callback URLs for local development. For a deployment, set `APP_ORIGIN` to its HTTPS origin and allow its corresponding callback URL. Serve the web app and `/api` on that same origin. Auth0 sends the verified email used to redeem invitations.

After sign-in, create a workspace and choose its IANA timezone. In **Settings**, an administrator can create an invitation link, copy it to the recipient, and manage member roles. Invitations expire after seven days, and removing a member revokes their outstanding links to that workspace. To change the last administrator, assign the role to another member first.

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

With Compose running and the database migrated, stop any running `pnpm dev` processes before running the browser check. Playwright starts all three app processes and temporarily stops Redis in the local Compose project. The identity check uses a loopback OIDC fixture on port 4399, configurable with `TEST_OIDC_PORT`.

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

To check recovery manually, run `docker compose stop redis` while the health page is open. Wait for **Degraded**, then submit a test job and keep its ID. The worker logs the Redis connection failure. Run `docker compose start redis` and watch the same job become **Completed**.
