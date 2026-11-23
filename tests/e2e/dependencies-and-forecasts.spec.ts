import { randomUUID } from "node:crypto";
import {
  graphSchema,
  projectCommandResponseSchema,
  scenarioSchema,
  type DependencyChange,
} from "@kordos/contracts";
import { setDatabaseScope } from "@kordos/db";
import { expect, test, type APIResponse } from "@playwright/test";
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
  email: `forecast-lead-${run}@example.test`,
  email_verified: true,
};
const teammate = {
  name: "Ravi",
  email: `forecast-peer-${run}@example.test`,
  email_verified: true,
};
const accounts = {
  [`forecast-lead-${run}`]: lead,
  [`forecast-peer-${run}`]: teammate,
};

function offset(date: string, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

async function saved(response: APIResponse, status: number) {
  expect(response.status(), await response.text()).toBe(status);
  return projectCommandResponseSchema.parse(await response.json()).id;
}

test("forecast scenarios preserve the plan and concurrent dependencies cannot create a cycle", async ({
  browser,
  baseURL,
}) => {
  if (
    !baseURL ||
    !process.env.DATABASE_URL ||
    !process.env.MIGRATION_DATABASE_URL
  ) {
    throw new Error(
      "Set the origin and both database URLs for the forecast test.",
    );
  }
  const headers = { Origin: baseURL };
  const owner = postgres(process.env.MIGRATION_DATABASE_URL);
  const runtime = postgres(process.env.DATABASE_URL, { max: 1 });
  const stopProvider = await startOidcFixture(accounts, baseURL);
  const [leadContext, peerContext] = await Promise.all([
    browser.newContext({ baseURL }),
    browser.newContext({ baseURL }),
  ]);
  const [page, peer] = await Promise.all([
    leadContext.newPage(),
    peerContext.newPage(),
  ]);
  let workspace = "";
  try {
    await Promise.all([
      signIn(page, lead, "/workspace"),
      signIn(peer, teammate, "/workspace"),
    ]);
    workspace = await createTestWorkspace(page, "Forecast Studio");
    const api = `/api/workspaces/${workspace}`;
    const projectFields = {
      name: "Checkout release",
      description: null,
      visibility: "restricted",
      timeZone: "America/Los_Angeles",
      workdays: [1, 2, 3, 4, 5],
      nonworkingDates: [],
    };
    const project = await saved(
      await leadContext.request.post(`${api}/projects`, {
        headers,
        data: { ...projectFields, mutationId: randomUUID() },
      }),
      201,
    );
    const endpoint = `${api}/projects/${project}`;
    const graphUrl = `/w/${workspace}/projects/${project}/graph`;
    const getGraph = async () => {
      const response = await leadContext.request.get(`${endpoint}/graph`);
      expect(response.status(), await response.text()).toBe(200);
      return graphSchema.parse(await response.json());
    };

    await page.goto(graphUrl);
    await expect(
      page.getByText("Add a task or milestone to start planning dependencies."),
    ).toBeVisible();

    const invite = await leadContext.request.post(`${api}/invitations`, {
      headers,
      data: { mutationId: randomUUID(), email: teammate.email, role: "admin" },
    });
    expect(invite.status()).toBe(201);
    const { token } = await invite.json();
    expect(
      (
        await peerContext.request.post("/api/invitations/accept", {
          headers,
          data: { token },
        })
      ).status(),
    ).toBe(200);
    expect((await peerContext.request.get(`${endpoint}/graph`)).status()).toBe(
      404,
    );
    const [leadUser, peerUser] = await Promise.all([
      owner<
        { id: string }[]
      >`SELECT id FROM public.users WHERE email = ${lead.email}`,
      owner<
        { id: string }[]
      >`SELECT id FROM public.users WHERE email = ${teammate.email}`,
    ]);
    await saved(
      await leadContext.request.patch(
        `${endpoint}/members/${peerUser[0]!.id}`,
        {
          headers,
          data: {
            mutationId: randomUUID(),
            expectedVersion: null,
            role: "contributor",
          },
        },
      ),
      200,
    );

    const beginning = (await getGraph()).asOf;
    const day = new Date(beginning).getUTCDay();
    const monday = offset(beginning, 7 + ((8 - day) % 7));
    const friday = offset(monday, -3);
    const thursday = offset(monday, -4);
    const workFields = {
      title: "",
      kind: "task",
      description: null,
      status: "ready",
      ownerId: leadUser[0]!.id,
      estimateDays: 1,
      deadline: null,
      commitment: null,
      blockerReason: null,
      blockerOwnerId: null,
      blockerResolution: null,
    };
    async function work(data: Partial<typeof workFields>) {
      return saved(
        await leadContext.request.post(`${endpoint}/work`, {
          headers,
          data: { ...workFields, ...data, mutationId: randomUUID() },
        }),
        201,
      );
    }
    const handoff = await work({ title: "API handoff" });
    const qa = await work({
      title: "Quality assurance",
      estimateDays: 2,
      ownerId: peerUser[0]!.id,
    });
    const launch = await saved(
      await leadContext.request.post(`${endpoint}/work`, {
        headers,
        data: {
          ...workFields,
          title: "Launch",
          kind: "milestone",
          commitment: monday,
          estimateDays: null,
          mutationId: randomUUID(),
        },
      }),
      201,
    );

    await test.step("Serialize opposite edits, return the cycle, and deduplicate retries", async () => {
      const graph = await getGraph();
      const forward = {
        action: "add",
        predecessorId: handoff,
        successorId: qa,
        expectedVersion: graph.graphVersion,
        mutationId: randomUUID(),
      } satisfies DependencyChange;
      const reverse = {
        ...forward,
        predecessorId: qa,
        successorId: handoff,
        mutationId: randomUUID(),
      };
      const [first, second] = await Promise.all([
        leadContext.request.post(`${endpoint}/dependencies`, {
          headers,
          data: forward,
        }),
        peerContext.request.post(`${endpoint}/dependencies`, {
          headers,
          data: reverse,
        }),
      ]);
      expect(
        [first.status(), second.status()].sort(),
        `${await first.text()} ${await second.text()}`,
      ).toEqual([200, 409]);
      const failed = first.ok() ? second : first;
      const failure = await failed.json();
      const attempted = first.ok() ? reverse : forward;
      expect(failure.current.path.map(({ id }: { id: string }) => id)).toEqual([
        attempted.predecessorId,
        attempted.successorId,
        attempted.predecessorId,
      ]);
      const [from, to] = first.ok()
        ? ([leadContext, forward] as const)
        : ([peerContext, reverse] as const);
      const receipt = await (first.ok() ? first : second).json();
      expect(
        await saved(
          await from.request.post(`${endpoint}/dependencies`, {
            headers,
            data: to,
          }),
          200,
        ),
      ).toBe(receipt.id);
      const [counts] = await owner<
        { edges: number; events: number; outbox: number }[]
      >`
        SELECT (SELECT count(*)::int FROM dependency_edges WHERE project_id = ${project}) AS edges,
          (SELECT count(*)::int FROM audit_events WHERE target_id = ${receipt.id}) AS events,
          (SELECT count(*)::int FROM outbox WHERE target_id = ${receipt.id}) AS outbox
      `;
      expect(counts).toEqual({ edges: 1, events: 1, outbox: 1 });
      if (!first.ok()) {
        await saved(
          await leadContext.request.post(`${endpoint}/dependencies`, {
            headers,
            data: {
              ...reverse,
              action: "remove",
              expectedVersion: (await getGraph()).graphVersion,
              mutationId: randomUUID(),
            },
          }),
          200,
        );
        await saved(
          await leadContext.request.post(`${endpoint}/dependencies`, {
            headers,
            data: {
              ...forward,
              expectedVersion: (await getGraph()).graphVersion,
              mutationId: randomUUID(),
            },
          }),
          200,
        );
      }
    });

    await page.reload();
    await page.getByLabel("Predecessor").selectOption(qa);
    await page.getByLabel("Successor").selectOption(launch);
    await page.getByRole("button", { name: "Add dependency" }).click();
    await expect(page.getByText("Dependency added.")).toBeVisible();
    await page.getByLabel("Predecessor").selectOption(launch);
    await page.getByLabel("Successor").selectOption(handoff);
    await page.getByRole("button", { name: "Add dependency" }).click();
    await expect(
      page
        .getByRole("list", { name: "Conflicting path" })
        .getByRole("listitem"),
    ).toHaveText(["Launch", "API handoff", "Quality assurance", "Launch"]);

    const baseline = await getGraph();
    let fridayScenario = "";
    await test.step("Compare Wednesday and Tuesday against Monday, inspect the path by keyboard, and preserve the baseline", async () => {
      const canvas = page.getByRole("region", { name: "Dependency canvas" });
      await expect(
        canvas.getByText("Quality assurance", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Ordered list" }).focus();
      await page.keyboard.press("Enter");
      const list = page.getByRole("list", { name: "Work in dependency order" });
      await expect(list.getByRole("button")).toHaveText([
        "API handoff",
        "Quality assurance",
        "Launch",
      ]);
      await list.getByRole("button", { name: "Quality assurance" }).focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("region", { name: "Selected work" }),
      ).toContainText("Ravi");

      const form = page.getByRole("region", { name: "What-if scenario" });
      await form
        .getByRole("combobox", { name: "Task", exact: true })
        .selectOption(handoff);
      const dates = page.getByRole("region", { name: "Milestone forecasts" });
      for (const [change, result] of [
        [friday, offset(monday, 2)],
        [thursday, offset(monday, 1)],
      ] as const) {
        await form.getByLabel("Hypothetical handoff").fill(change);
        const created = page.waitForResponse(
          (response) =>
            response.url().endsWith("/scenarios") &&
            response.request().method() === "POST",
        );
        await form.getByRole("button", { name: "Preview scenario" }).click();
        const response = await created;
        expect(response.status(), await response.text()).toBe(201);
        const scenario = scenarioSchema.parse(await response.json());
        if (change === friday) {
          fridayScenario = scenario.id;
          const retry = await leadContext.request.post(
            `${endpoint}/scenarios`,
            {
              headers,
              data: response.request().postDataJSON(),
            },
          );
          expect(retry.status(), await retry.text()).toBe(201);
          expect(await retry.json()).toEqual(scenario);
        }
        expect(scenario.forecast.find(({ id }) => id === launch)).toMatchObject(
          { start: result, finish: result },
        );
        await expect(dates.locator("time").last()).toHaveAttribute(
          "datetime",
          result,
        );
        await expect(dates.locator("time").first()).toHaveAttribute(
          "datetime",
          monday,
        );
        await expect(
          page.getByRole("region", { name: "Affected path" }).getByRole("link"),
        ).toHaveText(["API handoff", "Quality assurance", "Launch"]);
        await expect(
          page.getByRole("region", { name: "Affected path" }),
        ).toContainText("Ravi");
      }

      await page.getByRole("button", { name: "Close scenario" }).click();
      await expect(page.getByText("Private scenario preview")).toHaveCount(0);
      expect(await getGraph()).toEqual(baseline);
      await page.goto(`${graphUrl}?scenario=${fridayScenario}`);
      await expect(page.getByText("Private scenario preview")).toBeVisible();
      expect(
        (
          await peerContext.request.get(
            `${endpoint}/scenarios/${fridayScenario}`,
          )
        ).status(),
      ).toBe(404);
      expect(
        (
          await peerContext.request.delete(
            `${endpoint}/scenarios/${fridayScenario}`,
            { headers },
          )
        ).status(),
      ).toBe(404);
      await runtime.begin(async (sql) => {
        await setDatabaseScope(sql, peerUser[0]!.id, workspace);
        expect(
          await sql`SELECT id FROM public.scenarios WHERE id = ${fridayScenario}`,
        ).toHaveLength(0);
        expect(
          await sql`SELECT id FROM public.dependency_edges WHERE project_id = ${project}`,
        ).toHaveLength(2);
      });
      await page.getByRole("button", { name: "Reset preview" }).click();
      await expect(page.getByText("Private scenario preview")).toHaveCount(0);
      expect(
        (
          await leadContext.request.get(
            `${endpoint}/scenarios/${fridayScenario}`,
          )
        ).status(),
      ).toBe(404);
      expect(await getGraph()).toEqual(baseline);

      for (const width of [1440, 1024, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width);
      }
    });

    await test.step("Reject a scenario created from stale work and immediately enforce project revocation", async () => {
      await saved(
        await leadContext.request.patch(`${endpoint}/work/${qa}`, {
          headers,
          data: {
            ...workFields,
            title: "Quality assurance",
            estimateDays: null,
            ownerId: peerUser[0]!.id,
            action: "edit",
            expectedVersion: 1,
            mutationId: randomUUID(),
          },
        }),
        200,
      );
      const old = await leadContext.request.post(`${endpoint}/scenarios`, {
        headers,
        data: {
          inputRevision: baseline.inputRevision,
          asOf: baseline.asOf,
          changes: [{ kind: "handoff", workId: handoff, finish: friday }],
          mutationId: randomUUID(),
        },
      });
      expect(old.status()).toBe(409);
      expect(
        (await getGraph()).forecast.find(({ id }) => id === launch)
          ?.provisional,
      ).toBe(true);
      await expect(
        page.getByRole("region", { name: "Milestone forecasts" }),
      ).toContainText("Uncertain");
      await peer.goto(graphUrl);
      await expect(
        peer.getByRole("heading", { name: "Dependencies and forecast" }),
      ).toBeVisible();
      await saved(
        await leadContext.request.patch(
          `${endpoint}/members/${peerUser[0]!.id}`,
          {
            headers,
            data: { role: null, expectedVersion: 1, mutationId: randomUUID() },
          },
        ),
        200,
      );
      expect(
        (await peerContext.request.get(`${endpoint}/graph`)).status(),
      ).toBe(404);
      await expect(
        peer.getByText("Quality assurance", { exact: true }),
      ).toHaveCount(0);
      await runtime.begin(async (sql) => {
        await setDatabaseScope(sql, peerUser[0]!.id, workspace);
        expect(
          await sql`SELECT id FROM public.dependency_edges WHERE project_id = ${project}`,
        ).toHaveLength(0);
      });
    });
  } finally {
    await Promise.all([
      leadContext.close(),
      peerContext.close(),
      stopProvider(),
      runtime.end(),
    ]);
    await owner.begin(async (sql) => {
      if (workspace) {
        await sql`DELETE FROM scenarios WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM dependency_edges WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM outbox WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM audit_events WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM work_items WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM inbox_entries WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM inbox_preferences WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM project_members WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM projects WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM invitations WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM memberships WHERE workspace_id = ${workspace}`;
        await sql`DELETE FROM workspaces WHERE id = ${workspace}`;
      }
      await sql`DELETE FROM users WHERE issuer = ${issuer} AND subject IN ${sql(Object.keys(accounts))}`;
    });
    await owner.end();
  }
});
