import { randomUUID } from "node:crypto";
import { setDatabaseScope } from "@kordos/db";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { issuer, startOidcFixture } from "./oidc-fixture.js";

const run = randomUUID();
const alice = {
  name: "Alice",
  email: `alice-${run}@example.test`,
  email_verified: true,
};
const bo = {
  name: "Bo",
  email: `bo-${run}@example.test`,
  email_verified: true,
};
const casey = {
  name: "Casey",
  email: `casey-${run}@example.test`,
  email_verified: true,
};
const projectName = "Checkout modernization";
const aliceProject = randomUUID();
const boProject = randomUUID();
const privateProject = randomUUID();

function required(value: string | undefined) {
  if (!value)
    throw new Error(
      "Set both database URLs and the browser origin before testing identity.",
    );
  return value;
}

async function signIn(page: Page, account: { name: string }, path: string) {
  await page.goto(path);
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByRole("button", { name: "Continue to sign in" }).click();
  await page.getByRole("link", { name: account.name, exact: true }).click();
}

async function createWorkspace(page: Page, name: string) {
  await page.getByLabel("Workspace name").fill(name);
  await page.getByLabel("Timezone").fill("Asia/Kolkata");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/w\/[\da-f-]+\/workspace$/);
  return required(new URL(page.url()).pathname.split("/")[2]);
}

test("OIDC, invitation redemption, revocation and pooled database tenant isolation", async ({
  browser,
  baseURL,
}) => {
  const origin = required(baseURL);
  const owner = postgres(required(process.env.MIGRATION_DATABASE_URL));
  const runtime = postgres(required(process.env.DATABASE_URL), { max: 1 });
  const createdWorkspaces: string[] = [];
  const accounts = {
    [`alice-${run}`]: alice,
    [`bo-${run}`]: bo,
    [`casey-${run}`]: casey,
  };
  const stopProvider = await startOidcFixture(accounts, origin);
  const aliceContext = await browser.newContext({ baseURL });
  const boContext = await browser.newContext({ baseURL });
  const caseyContext = await browser.newContext({ baseURL });
  const alicePage = await aliceContext.newPage();
  const boPage = await boContext.newPage();
  const caseyPage = await caseyContext.newPage();
  const headers = { Origin: origin };

  try {
    await test.step("Sign in through OIDC and create isolated workspaces", async () => {
      await Promise.all([
        signIn(alicePage, alice, "/workspace"),
        signIn(boPage, bo, "/workspace"),
        signIn(caseyPage, casey, "/workspace"),
      ]);
      await expect(
        alicePage.getByRole("heading", { name: "Your workspaces" }),
      ).toBeVisible();
      await expect(
        boPage.getByRole("heading", { name: "Your workspaces" }),
      ).toBeVisible();
      await expect(
        caseyPage.getByRole("heading", { name: "Your workspaces" }),
      ).toBeVisible();
    });
    const a = await createWorkspace(alicePage, "Alice Studio");
    createdWorkspaces.push(a);
    const b = await createWorkspace(boPage, "Bo Studio");
    createdWorkspaces.push(b);
    const { identity: aliceIdentity } = await (
      await aliceContext.request.get("/api/session")
    ).json();
    const { identity: boIdentity } = await (
      await boContext.request.get("/api/session")
    ).json();
    expect(aliceIdentity).toMatchObject({
      email: alice.email,
      emailVerified: true,
    });
    expect(boIdentity).toMatchObject({ email: bo.email, emailVerified: true });

    await owner`INSERT INTO projects ${owner([
      {
        id: aliceProject,
        workspace_id: a,
        name: projectName,
        description: "Alice project scope",
        visibility: "workspace",
      },
      {
        id: boProject,
        workspace_id: b,
        name: projectName,
        description: "Bo project scope",
        visibility: "workspace",
      },
      {
        id: privateProject,
        workspace_id: b,
        name: "Restricted checkout",
        description: "Private project scope",
        visibility: "restricted",
      },
    ])}`;

    await test.step("Prove runtime RLS with no context, a wrong tenant and a reused connection", async () => {
      const [role] = await runtime`
        SELECT current_user AS name, pg_backend_pid() AS pid, r.rolsuper, r.rolbypassrls,
          pg_has_role(c.relowner, 'MEMBER') AS owns_projects, c.relrowsecurity
        FROM pg_roles r, pg_class c
        WHERE r.rolname = current_user AND c.oid = 'public.projects'::regclass
      `;
      expect(role).toMatchObject({
        name: "kordos_app",
        rolsuper: false,
        rolbypassrls: false,
        owns_projects: false,
        relrowsecurity: true,
      });
      expect(await runtime`SELECT id FROM projects`).toHaveLength(0);
      expect(await runtime`SELECT id FROM users`).toHaveLength(0);

      async function visible(actor: string, workspace: string) {
        return runtime.begin(async (sql) => {
          await setDatabaseScope(sql, actor, workspace);
          const [connection] = await sql`SELECT pg_backend_pid() AS pid`;
          expect(connection?.pid).toEqual(role?.pid);
          return sql`SELECT id, name FROM projects`;
        });
      }
      expect(await visible(aliceIdentity.id, a)).toEqual([
        { id: aliceProject, name: projectName },
      ]);
      expect(await visible(aliceIdentity.id, b)).toHaveLength(0);
      expect(await visible(boIdentity.id, a)).toHaveLength(0);
      expect(await visible(boIdentity.id, b)).toEqual([
        { id: boProject, name: projectName },
      ]);
      await expect(
        runtime.begin(async (sql) => {
          await setDatabaseScope(sql, aliceIdentity.id, a);
          await sql`UPDATE projects SET name = 'forbidden' WHERE id = ${boProject}`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
      const [connection] = await runtime`SELECT pg_backend_pid() AS pid`;
      expect(connection?.pid).toEqual(role?.pid);
      expect(await runtime`SELECT id FROM projects`).toHaveLength(0);
      expect(await runtime`SELECT id FROM users`).toHaveLength(0);
      expect(
        (await aliceContext.request.get(`/api/workspaces/${b}`)).status(),
      ).toBe(404);
      expect(
        (await boContext.request.get(`/api/workspaces/${a}`)).status(),
      ).toBe(404);
    });

    let token = "";
    await test.step("Verify last-admin protection and create a one-time invitation in settings", async () => {
      await boPage.getByRole("link", { name: "Settings" }).click();
      await expect(boPage.getByText("Asia/Kolkata")).toBeVisible();
      for (const width of [1440, 1024, 390, 320]) {
        await boPage.setViewportSize({ width, height: 840 });
        await expect(
          boPage.getByRole("heading", { name: "Settings" }),
        ).toBeVisible();
        await expect(
          boPage.getByRole("heading", { name: "Invite a member" }),
        ).toBeVisible();
        expect(
          await boPage.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
      }
      await boPage.setViewportSize({ width: 1440, height: 840 });
      const memberPath = `/api/workspaces/${b}/members/${boIdentity.id}`;
      const demotion = await boContext.request.patch(memberPath, {
        headers,
        data: { role: "viewer", expectedVersion: 1 },
      });
      expect(demotion.status()).toBe(409);
      expect(await demotion.json()).toMatchObject({ code: "last_admin" });
      await boPage.getByRole("button", { name: "Remove Bo" }).click();
      await boPage.getByRole("button", { name: "Confirm removal" }).click();
      await expect(boPage.getByRole("alert")).toContainText(
        "Assign another administrator first",
      );

      await boPage.getByLabel("Email address").fill(alice.email.toUpperCase());
      await boPage.getByLabel("Invitation role").selectOption("contributor");
      await boPage.getByRole("button", { name: "Create invitation" }).click();
      await expect(boPage.getByLabel("Invitation link")).toHaveValue(
        /\/join#[a-zA-Z0-9_-]{43}$/,
      );
      token = new URL(
        await boPage.getByLabel("Invitation link").inputValue(),
      ).hash.slice(1);
      const expired = await boContext.request.post(
        `/api/workspaces/${b}/invitations`,
        {
          headers,
          data: { email: casey.email, role: "viewer" },
        },
      );
      expect(expired.status()).toBe(201);
      await owner`UPDATE invitations SET expires_at = now() - interval '1 second'
        WHERE workspace_id = ${b} AND email = ${casey.email}`;
      const expiredToken = (await expired.json()).token;
      expect(
        (
          await caseyContext.request.post("/api/invitations/accept", {
            headers,
            data: { token: expiredToken },
          })
        ).status(),
      ).toBe(404);
    });

    await test.step("Reject another recipient and accept exactly once under concurrency", async () => {
      const mismatch = await caseyContext.request.post(
        "/api/invitations/accept",
        { headers, data: { token } },
      );
      expect(mismatch.status()).toBe(404);
      const crossOrigin = await aliceContext.request.post(
        "/api/invitations/accept",
        {
          headers: { Origin: "https://another.example.test" },
          data: { token },
        },
      );
      expect(crossOrigin.status()).toBe(403);
      const attempts = await Promise.all(
        Array.from({ length: 3 }, () =>
          aliceContext.request.post("/api/invitations/accept", {
            headers,
            data: { token },
          }),
        ),
      );
      expect(attempts.map((response) => response.status()).sort()).toEqual([
        200, 404, 404,
      ]);
      const memberships = await owner`SELECT role, version FROM memberships
        WHERE workspace_id = ${b} AND user_id = ${aliceIdentity.id}`;
      expect(memberships).toEqual([{ role: "contributor", version: 1 }]);
      const roster = await aliceContext.request.get(
        `/api/workspaces/${b}/members`,
      );
      expect(roster.status()).toBe(404);
    });

    await test.step("Resume a signed-out invitation after OIDC and join in the browser", async () => {
      const invite = await boContext.request.post(
        `/api/workspaces/${b}/invitations`,
        {
          headers,
          data: { email: casey.email, role: "viewer" },
        },
      );
      expect(invite.status()).toBe(201);
      const { token: caseyToken } = await invite.json();
      await caseyPage.getByRole("button", { name: "Sign out" }).click();
      await expect(caseyPage).toHaveURL(/\/sign-in$/);
      await signIn(caseyPage, casey, `/join#${caseyToken}`);
      await expect(caseyPage).toHaveURL(`${origin}/join#${caseyToken}`);
      await expect(caseyPage.getByText(casey.email)).toBeVisible();
      await caseyPage
        .getByRole("button", { name: "Accept invitation" })
        .click();
      await expect(caseyPage).toHaveURL(`${origin}/w/${b}/workspace`);
    });

    await test.step("Switch identical projects without carrying data across scopes", async () => {
      await alicePage.goto(`/w/${a}/projects`);
      await alicePage.getByRole("link", { name: projectName }).click();
      await expect(alicePage.getByText("Alice project scope")).toBeVisible();
      await alicePage
        .getByRole("button", {
          name: /Switch workspace, current workspace Alice Studio/,
        })
        .click();
      await alicePage
        .getByRole("dialog", { name: "Switch workspace" })
        .getByRole("link", { name: /Bo Studio/ })
        .click();
      await expect(alicePage).toHaveURL(new RegExp(`/w/${b}/workspace$`));
      await expect(
        alicePage.getByRole("button", {
          name: /Switch workspace, current workspace Bo Studio/,
        }),
      ).toBeVisible();
      await alicePage
        .getByRole("navigation", { name: "Workspace", exact: true })
        .getByRole("link", { name: "Projects", exact: true })
        .click();
      await expect(alicePage.getByText("Restricted checkout")).toHaveCount(0);
      await alicePage.getByRole("link", { name: projectName }).click();
      await expect(alicePage.getByText("Bo project scope")).toBeVisible();
      await expect(alicePage.getByText("Alice project scope")).toHaveCount(0);
      await alicePage.getByRole("link", { name: "Work", exact: true }).click();
      await expect(alicePage).toHaveURL(
        new RegExp(`/w/${b}/projects/${boProject}/work$`),
      );
      await alicePage.reload();
      await expect(
        alicePage.getByRole("heading", { name: "Work", exact: true }),
      ).toBeVisible();
      await alicePage.goto(`/w/${b}/projects/${aliceProject}`);
      await expect(
        alicePage.getByRole("heading", { name: "Project unavailable" }),
      ).toBeVisible();
      await alicePage.goto(`/w/${b}/projects/${boProject}`);
      await expect(alicePage.getByText("Bo project scope")).toBeVisible();
    });

    await test.step("Revoke the open workspace and retain historical attribution", async () => {
      await boPage.reload();
      await boPage.getByLabel("Role for Alice").selectOption("viewer");
      await boPage.getByRole("button", { name: "Save role for Alice" }).click();
      const memberPath = `/api/workspaces/${b}/members/${aliceIdentity.id}`;
      await expect
        .poll(async () => {
          const rows = await (
            await boContext.request.get(`/api/workspaces/${b}/members`)
          ).json();
          return rows.find(
            (member: { id: string }) => member.id === aliceIdentity.id,
          )?.role;
        })
        .toBe("viewer");
      const staleWrite = await boContext.request.patch(memberPath, {
        headers,
        data: { role: "contributor", expectedVersion: 1 },
      });
      expect(staleWrite.status()).toBe(409);
      expect(await staleWrite.json()).toMatchObject({
        code: "conflict",
        current: { role: "viewer", version: 2 },
      });
      await boPage.getByRole("button", { name: "Remove Alice" }).click();
      await boPage.getByRole("button", { name: "Confirm removal" }).click();
      await expect
        .poll(async () =>
          (await aliceContext.request.get(`/api/workspaces/${b}`)).status(),
        )
        .toBe(404);
      await expect(
        alicePage.getByRole("heading", { name: "Workspace unavailable" }),
      ).toBeVisible();
      await expect(alicePage.getByText("Bo project scope")).toHaveCount(0);
      const remaining = await (
        await aliceContext.request.get("/api/workspaces")
      ).json();
      expect(remaining).toMatchObject([{ id: a, role: "admin" }]);

      const events = await runtime.begin(async (sql) => {
        await setDatabaseScope(sql, boIdentity.id, b);
        return sql`SELECT action, actor_id, target_id FROM audit_events`;
      });
      expect(
        events.filter(
          ({ action, actor_id }) =>
            action === "invitation.accepted" && actor_id === aliceIdentity.id,
        ),
      ).toEqual([expect.objectContaining({ actor_id: aliceIdentity.id })]);
      expect(events).toContainEqual({
        action: "membership.removed",
        actor_id: boIdentity.id,
        target_id: aliceIdentity.id,
      });
      await expect(
        runtime.begin(async (sql) => {
          await setDatabaseScope(sql, boIdentity.id, b);
          await sql`DELETE FROM audit_events WHERE workspace_id = ${b}`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
      await alicePage.getByRole("link", { name: "Your workspaces" }).click();
      await expect(
        alicePage.getByRole("link", { name: /Alice Studio/ }),
      ).toBeVisible();
      await alicePage.getByRole("button", { name: "Sign out" }).click();
      await expect(alicePage).toHaveURL(/\/sign-in$/);
      expect(
        await (await aliceContext.request.get("/api/session")).json(),
      ).toMatchObject({ identity: null });
    });
  } finally {
    await Promise.all([
      aliceContext.close(),
      boContext.close(),
      caseyContext.close(),
    ]);
    await stopProvider();
    await owner.begin(async (sql) => {
      await sql`DELETE FROM public.audit_events WHERE workspace_id = ANY(${createdWorkspaces}::uuid[])`;
      await sql`DELETE FROM public.invitations WHERE workspace_id = ANY(${createdWorkspaces}::uuid[])`;
      await sql`DELETE FROM public.projects WHERE workspace_id = ANY(${createdWorkspaces}::uuid[])`;
      await sql`DELETE FROM public.memberships WHERE workspace_id = ANY(${createdWorkspaces}::uuid[])`;
      await sql`DELETE FROM public.workspaces WHERE id = ANY(${createdWorkspaces}::uuid[])`;
      await sql`DELETE FROM public.users WHERE issuer = ${issuer} AND subject IN ${sql(Object.keys(accounts))}`;
    });
    await Promise.all([runtime.end(), owner.end()]);
  }
});
