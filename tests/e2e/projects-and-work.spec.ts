import { randomUUID } from "node:crypto";
import { setDatabaseScope } from "@kordos/db";
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import {
  createTestWorkspace,
  issuer,
  signIn,
  startOidcFixture,
} from "./oidc-fixture.js";

const run = randomUUID();
const lead = {
  name: "Asha",
  email: `asha-${run}@example.test`,
  email_verified: true,
};
const admin = {
  name: "Morgan",
  email: `morgan-${run}@example.test`,
  email_verified: true,
};
const contributor = {
  name: "Ravi",
  email: `ravi-${run}@example.test`,
  email_verified: true,
};
const accounts = {
  [`lead-${run}`]: lead,
  [`admin-${run}`]: admin,
  [`contributor-${run}`]: contributor,
};
const projectName = "Restricted release";
const originalTitle = "Verify checkout accessibility";

function inspector(page: Page) {
  return page.getByRole("dialog", { name: "Work item details" });
}

test("plan, edit and reopen work with private project isolation", async ({
  browser,
  baseURL,
}) => {
  if (
    !baseURL ||
    !process.env.DATABASE_URL ||
    !process.env.MIGRATION_DATABASE_URL
  ) {
    throw new Error(
      "Set the browser origin and both database URLs before testing planning.",
    );
  }
  const origin = baseURL;
  const headers = { Origin: origin };
  const owner = postgres(process.env.MIGRATION_DATABASE_URL);
  const runtime = postgres(process.env.DATABASE_URL, { max: 1 });
  const stopProvider = await startOidcFixture(accounts, origin);
  const leadContext = await browser.newContext({ baseURL });
  const adminContext = await browser.newContext({ baseURL });
  const contributorContext = await browser.newContext({ baseURL });
  const leadPage = await leadContext.newPage();
  const adminPage = await adminContext.newPage();
  const contributorPage = await contributorContext.newPage();
  let workspace = "";
  try {
    await Promise.all([
      signIn(leadPage, lead, "/workspace"),
      signIn(adminPage, admin, "/workspace"),
      signIn(contributorPage, contributor, "/workspace"),
    ]);
    workspace = await createTestWorkspace(leadPage, "Planning Studio");
    const scope = `/w/${workspace}`;
    const api = `/api/workspaces/${workspace}`;
    for (const [account, context, role] of [
      [admin, adminContext, "admin"],
      [contributor, contributorContext, "contributor"],
    ] as const) {
      const invite = await leadContext.request.post(`${api}/invitations`, {
        headers,
        data: { email: account.email, role },
      });
      expect(invite.status()).toBe(201);
      const { token } = await invite.json();
      expect(
        (
          await context.request.post("/api/invitations/accept", {
            headers,
            data: { token },
          })
        ).status(),
      ).toBe(200);
    }

    await leadPage.goto(`${scope}/projects`);
    await leadPage.getByRole("button", { name: "Create project" }).click();
    const newProject = leadPage.getByRole("dialog", { name: "Create project" });
    await expect(
      newProject.getByRole("radio", { name: "Restricted", exact: true }),
    ).toBeChecked();
    await newProject.getByLabel("Project name").fill(projectName);
    await newProject
      .getByLabel("Description")
      .fill("Prepare the checkout release.");
    await newProject.getByLabel("Sat").check();
    await newProject.getByLabel("Nonworking dates").fill("2026-12-25");
    await newProject.getByRole("button", { name: "Create project" }).click();
    await expect(
      leadPage.getByRole("heading", { name: projectName }),
    ).toBeVisible();
    const projectUrl = new URL(leadPage.url()).pathname;
    const project = projectUrl.split("/").at(-1)!;
    const projectApi = `${api}/projects/${project}`;
    expect(
      await (await leadContext.request.get(projectApi)).json(),
    ).toMatchObject({
      visibility: "restricted",
      timeZone: "Asia/Kolkata",
      workdays: [1, 2, 3, 4, 5, 6],
      nonworkingDates: ["2026-12-25"],
      role: "lead",
      lead: { name: lead.name },
    });

    await test.step("Assign project roles and record work with independent blocker state", async () => {
      await leadPage.getByRole("link", { name: "Project settings" }).click();
      await leadPage
        .getByLabel("Workspace member")
        .selectOption({ label: contributor.name });
      await leadPage
        .getByRole("combobox", { name: "Project role", exact: true })
        .selectOption("contributor");
      await leadPage.getByRole("button", { name: "Add member" }).click();
      await expect(
        leadPage.getByLabel(`Project role for ${contributor.name}`),
      ).toHaveValue("contributor");
      await leadPage.getByRole("link", { name: "Create task" }).click();
      const dialog = leadPage.getByRole("dialog", { name: "Create work item" });
      await dialog.getByLabel("Title", { exact: true }).fill(originalTitle);
      await dialog
        .getByRole("combobox", { name: "Status", exact: true })
        .selectOption("in_progress");
      await dialog
        .getByRole("combobox", { name: "Owner", exact: true })
        .selectOption({ label: contributor.name });
      await expect(
        dialog
          .getByRole("combobox", { name: "Owner", exact: true })
          .locator("option"),
      ).toHaveText(["Unassigned", lead.name, contributor.name]);
      await dialog.getByLabel("Estimate (working days)").fill("3");
      await dialog.getByLabel("Deadline").fill("2026-12-24");
      await dialog.getByLabel("Record a blocker").check();
      await dialog
        .getByLabel("Blocker reason")
        .fill("Waiting for design review.");
      await dialog
        .getByLabel("Blocker owner")
        .selectOption({ label: contributor.name });
      await dialog.getByRole("button", { name: "Create task" }).click();
      await expect(
        inspector(leadPage).getByRole("heading", { name: originalTitle }),
      ).toBeVisible();
      await expect(
        inspector(leadPage).getByText("In progress", { exact: true }),
      ).toBeVisible();
      await expect(
        inspector(leadPage).getByText("Blocked", { exact: true }),
      ).toBeVisible();
    });
    const taskUrl = new URL(leadPage.url()).pathname;
    const taskId = taskUrl.split("/").at(-1)!;
    const taskApi = `${projectApi}/work/${taskId}`;

    await test.step("Deny a same-workspace admin in the browser, HTTP API and runtime database", async () => {
      await adminPage.goto(`${scope}/projects`);
      await expect(
        adminPage.getByText("There are no active projects you can access."),
      ).toBeVisible();
      await adminPage.goto(taskUrl);
      await expect(
        adminPage.getByRole("heading", { name: "Project unavailable" }),
      ).toBeVisible();
      await expect(adminPage.getByText(originalTitle)).toHaveCount(0);
      for (const path of [
        projectApi,
        `${projectApi}/work?q=checkout`,
        taskApi,
        `${taskApi}/history`,
      ]) {
        const missing = await adminContext.request.get(path);
        expect(missing.status()).toBe(404);
        expect((await missing.text()).includes(originalTitle)).toBe(false);
      }
      const { identity } = await (
        await adminContext.request.get("/api/session")
      ).json();
      await runtime.begin(async (sql) => {
        await setDatabaseScope(sql, identity.id, workspace);
        expect(
          await sql`SELECT id FROM projects WHERE id = ${project}`,
        ).toEqual([]);
        expect(
          await sql`SELECT title FROM work_items WHERE id = ${taskId}`,
        ).toEqual([]);
        expect(
          await sql`SELECT details FROM audit_events WHERE project_id = ${project}`,
        ).toEqual([]);
      });
      await contributorPage.goto(`${scope}/workspace`);
      await expect(
        contributorPage.getByRole("heading", { name: "Assigned to you" }),
      ).toBeVisible();
      await expect(
        contributorPage.getByRole("link", { name: new RegExp(originalTitle) }),
      ).toBeVisible();
    });

    const boardUrl = `${projectUrl}/work?view=board`;
    await test.step("Edit from the board and verify conflict handling during concurrent saves", async () => {
      await Promise.all([
        leadPage.goto(boardUrl),
        contributorPage.goto(boardUrl),
      ]);
      const boardCard = leadPage
        .getByRole("region", { name: "In progress", exact: true })
        .getByRole("link", { name: new RegExp(originalTitle) });
      await boardCard.press("Enter");
      await expect(
        inspector(leadPage).getByRole("button", { name: "Back" }),
      ).toBeFocused();
      await leadPage.keyboard.press("Escape");
      await expect(boardCard).toBeFocused();
      const aTitle = "Confirm checkout accessibility";
      const bTitle = "Review checkout accessibility";
      for (const [page, title] of [
        [leadPage, aTitle],
        [contributorPage, bTitle],
      ] as const) {
        await page
          .getByRole("link", { name: new RegExp(originalTitle) })
          .click();
        await inspector(page)
          .getByRole("button", { name: "Edit task" })
          .click();
        await inspector(page).getByLabel("Title", { exact: true }).fill(title);
      }
      await inspector(leadPage)
        .getByLabel("Blocker resolution")
        .fill("Design approved the flow.");
      const responses = await Promise.all(
        [leadPage, contributorPage].map(async (page) => {
          const response = page.waitForResponse(
            (res) =>
              res.url() === origin + taskApi &&
              res.request().method() === "PATCH",
          );
          await inspector(page)
            .getByRole("button", { name: "Save changes" })
            .click();
          return (await response).status();
        }),
      );
      expect([...responses].sort()).toEqual([200, 409]);
      const leadLost = responses[0] === 409;
      const [loser, keptTitle, latestTitle] = leadLost
        ? [leadPage, aTitle, bTitle]
        : [contributorPage, bTitle, aTitle];
      const stale = inspector(loser);
      await expect(stale.getByRole("alert")).toContainText(
        "Someone saved a newer version",
      );
      await expect(stale.getByLabel("Title", { exact: true })).toHaveValue(
        keptTitle,
      );
      await expect(
        stale.getByText(latestTitle, { exact: true }).last(),
      ).toBeVisible();
      await stale
        .getByRole("button", { name: "Keep my edits and use latest version" })
        .click();
      await expect(stale.getByLabel("Title", { exact: true })).toHaveValue(
        keptTitle,
      );
      await stale.getByRole("button", { name: "Save changes" }).click();
      await expect(
        stale.getByRole("heading", { name: keptTitle }),
      ).toBeVisible();
      await expect(
        stale.getByText("Blocker resolved", { exact: true }),
      ).toBeVisible();
      await stale.getByRole("button", { name: "Back" }).click();
      await loser.getByRole("button", { name: "List", exact: true }).click();
      await loser.reload();
      const result = loser.getByRole("link", { name: new RegExp(keptTitle) });
      await expect(result).toBeVisible();
      await loser.getByLabel("Find work").fill("no matching title");
      await expect(
        loser.getByText("No work matches these filters."),
      ).toBeVisible();
      await loser.getByLabel("Find work").fill("checkout");
      await expect(result).toBeVisible();
      await loser.goto(taskUrl);
      await expect(
        inspector(loser).getByRole("heading", { name: keptTitle }),
      ).toBeVisible();
      for (const width of [1440, 1024, 390, 320]) {
        await loser.setViewportSize({ width, height: 760 });
        await expect(inspector(loser)).toBeVisible();
        expect(
          await loser.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
      }
      await loser.setViewportSize({ width: 1440, height: 900 });
    });

    await test.step("Complete and reopen with attribution, then archive and restore through the stable link", async () => {
      await leadPage.goto(taskUrl);
      const task = inspector(leadPage);
      await task.getByRole("button", { name: "Edit task" }).click();
      await task
        .getByRole("combobox", { name: "Status", exact: true })
        .selectOption("done");
      await task.getByRole("button", { name: "Save changes" }).click();
      await task.getByRole("button", { name: "Reopen task" }).click();
      await expect(
        task.getByRole("listitem").filter({ hasText: "Reopened by Asha" }),
      ).toBeVisible();
      await expect(task.getByText(/Done → Ready/)).toBeVisible();
      const history = await (
        await leadContext.request.get(`${taskApi}/history`)
      ).json();
      expect(history.items[0]).toMatchObject({
        action: "work.reopened",
        actor: { name: lead.name },
        before: { status: "done" },
        after: { status: "ready", completedAt: null },
      });

      await task.getByRole("button", { name: "Archive task" }).click();
      await expect(
        task.getByRole("button", { name: "Restore task" }),
      ).toBeVisible();
      await leadPage.goto(projectUrl);
      await expect(leadPage.getByText("0 active work items")).toBeVisible();
      await contributorPage.goto(`${scope}/workspace`);
      await expect(
        contributorPage.getByText("You have no open work assigned to you."),
      ).toBeVisible();
      await leadPage.goto(`${projectUrl}/work?archived=true`);
      await expect(
        leadPage.getByRole("link", { name: /checkout accessibility/ }),
      ).toBeVisible();
      await leadPage.goto(taskUrl);
      await task.getByRole("button", { name: "Restore task" }).click();
      await expect(
        task.getByRole("button", { name: "Archive task" }),
      ).toBeVisible();
    });

    await test.step("Require a lead for commitments and visibility, preview audience, and reopen an archived project", async () => {
      const fields = {
        mutationId: randomUUID(),
        title: "Checkout launch",
        description: null,
        kind: "milestone",
        status: "ready",
        ownerId: null,
        estimateDays: null,
        deadline: null,
        commitment: "2026-12-30",
        blockerReason: null,
        blockerOwnerId: null,
        blockerResolution: null,
      };
      expect(
        (
          await contributorContext.request.post(`${projectApi}/work`, {
            headers,
            data: fields,
          })
        ).status(),
      ).toBe(403);
      const createMilestone = () =>
        leadContext.request.post(`${projectApi}/work`, {
          headers,
          data: fields,
        });
      const [created, replay] = await Promise.all([
        createMilestone(),
        createMilestone(),
      ]);
      expect(created.status()).toBe(201);
      expect(replay.status()).toBe(201);
      expect(await created.json()).toEqual(await replay.json());
      const events =
        await owner`SELECT a.action, o.kind FROM outbox o JOIN audit_events a USING (id)
        WHERE o.workspace_id = ${workspace} AND o.mutation_id = ${fields.mutationId}`;
      expect(events).toEqual([
        { action: "work.created", kind: "work.created" },
      ]);
      const projectDetails = await (
        await leadContext.request.get(projectApi)
      ).json();
      expect(
        (
          await contributorContext.request.patch(projectApi, {
            headers,
            data: {
              ...projectDetails,
              visibility: "workspace",
              action: "edit",
              expectedVersion: projectDetails.version,
              mutationId: randomUUID(),
            },
          })
        ).status(),
      ).toBe(404);

      await leadPage.goto(`${projectUrl}/settings`);
      await leadPage.getByRole("radio", { name: "Workspace-visible" }).check();
      await expect(
        leadPage.getByText(/3 current members of Planning Studio/),
      ).toBeVisible();
      await leadPage.getByRole("button", { name: "Save project" }).click();
      await expect(
        leadPage.getByText("Visible to this workspace", { exact: false }),
      ).toBeVisible();
      await adminPage.goto(taskUrl);
      await expect(
        inspector(adminPage).getByRole("heading", {
          name: /checkout accessibility/,
        }),
      ).toBeVisible();
      await expect(
        inspector(adminPage).getByRole("button", { name: "Edit task" }),
      ).toHaveCount(0);

      await leadPage.goto(`${projectUrl}/settings`);
      await leadPage
        .getByRole("radio", { name: "Restricted", exact: true })
        .check();
      await leadPage.getByRole("button", { name: "Save project" }).click();
      await expect(
        adminPage.getByRole("heading", { name: "Project unavailable" }),
      ).toBeVisible();
      await leadPage.goto(`${projectUrl}/settings`);
      await leadPage.getByRole("button", { name: "Archive project" }).click();
      await expect(
        leadPage.getByText("Archived project", { exact: true }),
      ).toBeVisible();
      await expect(leadPage.getByText("0 active work items")).toBeVisible();
      await leadPage.goto(`${scope}/projects`);
      await expect(
        leadPage.getByRole("link", { name: new RegExp(projectName) }),
      ).toHaveCount(0);
      await leadPage.getByLabel("Project state").selectOption("true");
      await expect(
        leadPage.getByRole("link", { name: new RegExp(projectName) }),
      ).toBeVisible();
      await leadPage.goto(`${projectUrl}/settings`);
      await leadPage.getByRole("button", { name: "Reopen project" }).click();
      await expect(leadPage.getByText("2 active work items")).toBeVisible();
    });

    await test.step("Revoke explicit membership without erasing work history", async () => {
      await contributorPage.goto(taskUrl);
      await expect(
        inspector(contributorPage).getByRole("heading", {
          name: /checkout accessibility/,
        }),
      ).toBeVisible();
      await leadPage.goto(`${projectUrl}/settings`);
      await leadPage.getByRole("button", { name: "Remove Asha" }).click();
      await expect(leadPage.getByRole("alert")).toHaveText(
        "Assign another project lead first.",
      );
      await leadPage.getByRole("button", { name: "Remove Ravi" }).click();
      await expect(
        leadPage.getByRole("button", { name: "Remove Ravi" }),
      ).toHaveCount(0);
      expect((await contributorContext.request.get(taskApi)).status()).toBe(
        404,
      );
      await expect(
        contributorPage.getByRole("heading", { name: "Project unavailable" }),
      ).toBeVisible();
      const revisions = await (
        await leadContext.request.get(`${taskApi}/history`)
      ).json();
      expect(
        revisions.items.some(
          (revision: { actor: { name: string } }) =>
            revision.actor.name === contributor.name,
        ),
      ).toBe(true);
    });
  } finally {
    await Promise.all([
      leadContext.close(),
      adminContext.close(),
      contributorContext.close(),
    ]);
    await stopProvider();
    await owner.begin(async (sql) => {
      if (workspace) {
        await sql`DELETE FROM outbox WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM audit_events WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM work_items WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM project_members WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM projects WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM invitations WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM memberships WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM workspaces WHERE id = ${workspace}`;
      }
      await sql`DELETE FROM users WHERE issuer = ${issuer} AND subject IN ${sql(Object.keys(accounts))}`;
    });
    await Promise.all([runtime.end(), owner.end()]);
  }
});
