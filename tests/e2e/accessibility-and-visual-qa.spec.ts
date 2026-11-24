import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  graphSchema,
  meetingDetailSchema,
  proposalDetailSchema,
  scenarioSchema,
  workItemSchema,
} from "@kordos/contracts";
import {
  expect,
  test,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";
import { startChromiumZoom } from "./chromium-zoom.js";
import {
  createTestWorkspace,
  signIn,
  startOidcFixture,
} from "./oidc-fixture.js";

const widths = [1440, 1024, 390, 320];
const longText =
  "Readiness lighthouse confirms this roll-out decision.\n\n" +
  "SyntheticTicket".repeat(27);
const taskName =
  "Verify accessibility before publishing the deliberately long release handoff";

async function json<T>(request: Promise<APIResponse>, status: number) {
  const response = await request;
  expect(response.status(), await response.text()).toBe(status);
  return (await response.json()) as T;
}

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let count = 0; count < 75; count++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function enter(page: Page, target: Locator) {
  await tabTo(page, target);
  await page.keyboard.press("Enter");
}

test("operating screens reflow and keyboard focus follows work, evidence and conflicts", async ({
  page,
  baseURL,
}, info) => {
  test.setTimeout(150_000);
  if (!baseURL) throw new Error("Set the browser origin.");
  const user = {
    email: `a11y-${randomUUID()}@example.test`,
    email_verified: true,
    name: "Avery Release Lead",
  };
  const close = await startOidcFixture({ lead: user }, baseURL);
  const headers = { Origin: baseURL };
  const post = (path: string, data: object) =>
    page.request.post(path, {
      headers,
      data: { mutationId: randomUUID(), ...data },
    });
  const patch = (path: string, data: object) =>
    page.request.patch(path, {
      headers,
      data: { mutationId: randomUUID(), ...data },
    });
  const id = (response: Promise<APIResponse>, status: number) =>
    json<{ id: string }>(response, status).then((body) => body.id);

  async function inspect(
    name: string,
    ready: Locator,
    primary: Locator | ((width: number) => Locator),
  ) {
    await expect(ready).toBeVisible();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const action = typeof primary === "function" ? primary(width) : primary;
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
      await action.scrollIntoViewIfNeeded();
      await expect(action).toBeInViewport({ ratio: 0.9 });
      const box = await action.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      await page.screenshot({
        path: info.outputPath(`${name}-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
  }

  try {
    await signIn(page, user, "/workspace");
    const workspaceId = await createTestWorkspace(
      page,
      "Accessibility rehearsal",
    );
    const workspace = `/w/${workspaceId}`;
    const api = `/api/workspaces/${workspaceId}`;
    const home = workspace + "/workspace";
    const identity = await json<{ identity: { id: string } }>(
      page.request.get("/api/session"),
      200,
    );
    const heading = (name: string | RegExp) =>
      page.getByRole("heading", { name, exact: true });
    const button = (name: string) =>
      page.getByRole("button", { name, exact: true });
    const main = page.getByRole("main");

    await test.step("Inspect empty workspace, search and review", async () => {
      await inspect(
        "home-empty",
        main.getByText("You have no open work assigned to you."),
        (width) =>
          width < 768
            ? button("Open workspace navigation")
            : page.getByRole("link", { name: "Projects", exact: true }),
      );
      await page.goto(workspace + "/search");
      await inspect("search-empty", heading("Search"), button("Search"));
      await page.goto(workspace + "/reviews");
      await inspect(
        "reviews-empty",
        main.getByText("No proposals yet."),
        button("All proposals"),
      );
    });

    const projectId = await id(
      post(api + "/projects", {
        name: "Release accessibility and evidence rehearsal",
        visibility: "restricted",
        timeZone: "Asia/Kolkata",
        workdays: [1, 2, 3, 4, 5],
        nonworkingDates: [],
        description: null,
      }),
      201,
    );
    const project = `${workspace}/projects/${projectId}`;
    const endpoint = `${api}/projects/${projectId}`;
    await test.step("Inspect empty forecast and meeting list", async () => {
      await page.goto(project + "/graph");
      await inspect(
        "forecast-empty",
        main.getByText(
          "Add a task or milestone to start planning dependencies.",
        ),
        page.getByText("Forecast inputs", { exact: true }),
      );
      await page.goto(project + "/meetings");
      await inspect(
        "meetings-empty",
        main.getByText("No meetings have been added."),
        button("New meeting"),
      );
    });

    const workFields = {
      title: taskName,
      description: longText,
      kind: "task",
      status: "ready",
      ownerId: identity.identity.id,
      estimateDays: 2,
      deadline: null,
      commitment: null,
      blockerReason: null,
      blockerOwnerId: null,
      blockerResolution: null,
    };
    const workId = await id(post(endpoint + "/work", workFields), 201);
    const work = `${endpoint}/work/${workId}`;
    const currentWork = async () =>
      workItemSchema.parse(await json(page.request.get(work), 200));
    const getGraph = async () =>
      graphSchema.parse(await json(page.request.get(endpoint + "/graph"), 200));
    const future = new Date((await getGraph()).asOf + "T00:00:00Z");
    future.setUTCDate(future.getUTCDate() + 21);
    const launchId = await id(
      post(endpoint + "/work", {
        ...workFields,
        title: "Launch readiness milestone",
        kind: "milestone",
        estimateDays: null,
        commitment: future.toISOString().slice(0, 10),
      }),
      201,
    );
    const documentId = await id(
      post(endpoint + "/documents", {
        action: "create",
        title: "Readiness lighthouse evidence",
        content: longText,
      }),
      200,
    );
    const meetingId = await id(
      post(endpoint + "/meetings", {
        title: "Release follow-up with transcript",
        agenda: null,
        startsAt: new Date().toISOString(),
        retentionDays: 30,
      }),
      201,
    );
    const meetingApi = `${endpoint}/meetings/${meetingId}`;
    await page.goto(`${project}/meetings/${meetingId}`);
    await inspect(
      "transcript-empty",
      button("Process transcript"),
      page.getByRole("textbox", { name: "Paste transcript" }),
    );
    await json(
      patch(meetingApi, {
        action: "paste",
        expectedVersion: 1,
        content: `Avery: The launch follows the accessibility rehearsal.\n\nMorgan: ${longText}`,
      }),
      202,
    );

    await test.step("Edit with the keyboard, retain the draft after a failed submission, and return to the task row", async () => {
      await page.goto(project + "/work");
      const opening = page.getByRole("link", { name: new RegExp(taskName) });
      await enter(page, opening);
      const dialog = page.getByRole("dialog", { name: "Work item details" });
      await expect(dialog.getByRole("button", { name: "Back" })).toBeFocused();
      await enter(page, dialog.getByRole("button", { name: "Edit task" }));
      const title = dialog.getByRole("textbox", { name: "Title", exact: true });
      await expect(title).toBeFocused();
      await page.keyboard.press("End");
      await page.keyboard.insertText(" with keyboard controls");
      const save = dialog.getByRole("button", { name: "Save changes" });
      await page.route(work, async (route) => {
        if (route.request().method() === "PATCH")
          await route.fulfill({
            status: 503,
            json: { code: "unavailable", message: "Try saving again." },
          });
        else await route.continue();
      });
      await enter(page, save);
      await expect(
        dialog
          .getByRole("alert")
          .filter({ hasText: /Try saving again|The request failed/ }),
      ).toBeVisible();
      await expect(title).toHaveValue(taskName + " with keyboard controls");
      await expect(save).toBeFocused();
      await page.unroute(work);
      await page.keyboard.press("Enter");
      await expect(
        dialog.getByRole("button", { name: "Edit task" }),
      ).toBeFocused();
      await expect(
        dialog.getByRole("status").filter({ hasText: "Work item saved." }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("link", { name: new RegExp(taskName) }),
      ).toBeFocused();
    });

    const graphUrl = project + "/graph";
    await test.step("Create an edge in the ordered list and return from the affected row", async () => {
      await page.goto(graphUrl);
      await enter(page, button("Ordered list"));
      const update = page.getByRole("region", { name: "Edit dependencies" });
      const predecessor = update.getByRole("combobox", { name: "Predecessor" });
      const successor = update.getByRole("combobox", { name: "Successor" });
      for (const [control, value, initial] of [
        [predecessor, workId, "v"],
        [successor, launchId, "l"],
      ] as const) {
        await tabTo(page, control);
        await page.keyboard.press(initial);
        await expect(control).toHaveValue(value);
      }
      await enter(page, button("Add dependency"));
      await expect(update.getByRole("status")).toHaveText("Dependency added.");
      expect((await getGraph()).edges).toContainEqual({
        predecessorId: workId,
        successorId: launchId,
      });

      const { asOf, inputRevision } = await getGraph();
      const scenario = scenarioSchema.parse(
        await json(
          post(endpoint + "/scenarios", {
            asOf,
            inputRevision,
            changes: [{ kind: "remaining", workId, days: 30 }],
          }),
          201,
        ),
      );
      const preview = `${graphUrl}?view=list&scenario=${scenario.id}`;
      await page.goto(preview);
      const impact = page.getByRole("region", { name: "Affected path" });
      const row = impact.getByRole("link", {
        name: "Launch readiness milestone",
      });
      await expect(
        page.getByRole("region", { name: "Milestone forecasts" }),
      ).toContainText(/Committed.*Forecast/);
      await expect(
        page.getByRole("list", { name: "Work in dependency order" }),
      ).toContainText("Affected");
      await enter(page, row);
      const details = page.getByRole("dialog", { name: "Work item details" });
      await expect(
        details.getByRole("heading", { name: "Launch readiness milestone" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(preview);
      await expect(row).toBeFocused();
      await inspect("forecast-impact", heading("Affected path"), row);
      await enter(page, button("Canvas"));
      await inspect(
        "forecast-canvas",
        page.getByRole("region", { name: "Dependency canvas" }),
        button("Ordered list"),
      );
    });

    await test.step("Look up a source with the keyboard and inspect long search and transcript text", async () => {
      await expect
        .poll(async () => {
          const response = await page.request.get(api + "/search?q=lighthouse");
          const result = await response.json();
          return result.items?.some(
            ({ id }: { id: string }) => id === documentId,
          );
        })
        .toBe(true);
      await page.goto(workspace + "/search");
      const search = page.getByRole("searchbox", { name: "Search workspace" });
      await tabTo(page, search);
      await page.keyboard.insertText("lighthouse");
      await page.keyboard.press("Enter");
      const link = page.getByRole("link", {
        name: "Readiness lighthouse evidence",
        exact: true,
      });
      await inspect("search-long-source", heading("Results"), link);
      await expect(
        page.getByRole("status").filter({ hasText: /matching/ }),
      ).toBeVisible();
      await enter(page, link);
      await expect(
        main
          .getByText("Readiness lighthouse confirms this roll-out decision.", {
            exact: false,
          })
          .first(),
      ).toBeVisible();
      await page.goto(
        `${project}/documents/evidence/document/${randomUUID()}?revision=1&start=0&end=12`,
      );
      await inspect(
        "evidence-unavailable",
        main.getByRole("alert").filter({ hasText: "Evidence unavailable." }),
        main.getByRole("link", { name: "All documents" }),
      );
      await expect
        .poll(
          async () =>
            meetingDetailSchema.parse(
              await json(page.request.get(meetingApi), 200),
            ).transcript?.revision,
        )
        .toBe(1);
      await page.goto(`${project}/meetings/${meetingId}`);
      await inspect(
        "meeting-transcript",
        heading("Transcript · Revision 1"),
        button("Reprocess suggestions"),
      );
      await expect(main.getByText(/SyntheticTicket/).first()).toBeVisible();
    });

    await test.step("Distinguish pending approval and recover from a version conflict", async () => {
      const from = await currentWork();
      const proposalId = await id(
        post(endpoint + "/proposals", {
          workId,
          targetVersion: from.version,
          command: {
            kind: "work.edit",
            values: { ...workFields, title: "Proposed accessibility sign-off" },
          },
          evidence: [
            {
              kind: "document",
              projectId,
              id: documentId,
              anchor: { revision: 1, start: 0, end: longText.length },
            },
          ],
        }),
        201,
      );
      const proposalApi = `${api}/proposals/${proposalId}`;
      const { revision, version } = proposalDetailSchema.parse(
        await json(page.request.get(proposalApi), 200),
      );
      await json(
        post(proposalApi + "/submit", { revision, expectedVersion: version }),
        200,
      );
      await page.goto(home);
      await inspect(
        "home-populated",
        heading("Assigned to you"),
        main.getByRole("link", { name: new RegExp(taskName) }).first(),
      );
      await page.goto(`${workspace}/reviews/${proposalId}`);
      const approval = button("Approve change");
      await inspect(
        "pending-review",
        main.getByText("Awaiting review", { exact: true }),
        approval,
      );
      await test.step("Check signed-in routes at real 200% browser zoom", async () => {
        const zoomed = await startChromiumZoom(info, baseURL);
        try {
          await zoomed.context.addCookies(await page.context().cookies());
          await zoomed.page.goto(`${workspace}/reviews/${proposalId}`);
          await zoomed.zoom();
          const targets = [
            [`${workspace}/reviews/${proposalId}`, "Approve change", "review"],
            [graphUrl + "?view=list", "Add dependency", "forecast"],
            [workspace + "/search?q=lighthouse", "Search", "search"],
            [
              `${project}/meetings/${meetingId}`,
              "Reprocess suggestions",
              "transcript",
            ],
          ] as const;
          for (const [url, label, name] of targets) {
            await zoomed.page.goto(url);
            const action = zoomed.page.getByRole("button", {
              name: label,
              exact: true,
            });
            await expect(action).toBeVisible();
            await expect
              .poll(() =>
                zoomed.page.evaluate(() => ({
                  width: innerWidth,
                  content: document.documentElement.scrollWidth,
                })),
              )
              .toEqual({ width: 320, content: 320 });
            await action.scrollIntoViewIfNeeded();
            await expect(action).toBeInViewport();
            if (name === "review") {
              const cdp = await zoomed.context.newCDPSession(zoomed.page);
              const { data } = await cdp.send("Page.captureScreenshot", {
                captureBeyondViewport: false,
              });
              await writeFile(
                info.outputPath("pending-review-200-percent.png"),
                Buffer.from(data, "base64"),
              );
              await cdp.detach();
            }
          }
        } finally {
          await zoomed.context.close();
        }
      });
      await page.route(
        proposalApi + "/approve",
        async (route) => {
          await json(
            patch(work, {
              ...workFields,
              title: "Latest manual handoff",
              action: "edit",
              expectedVersion: from.version,
            }),
            200,
          );
          await route.continue();
        },
        { times: 1 },
      );
      await enter(page, approval);
      const alert = main
        .getByRole("alert")
        .filter({ hasText: /changed|latest|version/i });
      await expect(alert).toBeVisible();
      await expect(alert).toBeFocused();
      await expect(approval).toHaveCount(0);
      await page.keyboard.press("Tab");
      await expect(button("Review latest changes")).toBeFocused();
      await inspect(
        "approval-conflict",
        alert,
        button("Review latest changes"),
      );
    });

    await test.step("Measure token contrast and check reduced motion and transparency", async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-motion", value: "reduce" },
          { name: "prefers-reduced-transparency", value: "reduce" },
        ],
      });
      const measured = await page.evaluate(() => {
        const styles = getComputedStyle(document.documentElement);
        const luminance = (color: string) =>
          color
            .match(/[0-9a-f]{2}/gi)!
            .map((part) => Number.parseInt(part, 16) / 255)
            .map((channel) =>
              channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4,
            )
            .reduce(
              (value, channel, index) =>
                value + channel * [0.2126, 0.7152, 0.0722][index]!,
              0,
            );
        const compare = (foreground: string, backgrounds: string[]) =>
          Math.min(
            ...backgrounds.map((background) => {
              const pair = [foreground, background]
                .map((color) =>
                  luminance(
                    color.startsWith("--")
                      ? styles
                          .getPropertyValue(color)
                          .trim()
                          .replace(/^#fff$/, "#ffffff")
                      : color,
                  ),
                )
                .sort((a, b) => b - a);
              return (pair[0]! + 0.05) / (pair[1]! + 0.05);
            }),
          );
        const surfaces = [
          "--surface",
          "--glass",
          "--inset",
          "--accent-surface",
          "#dcdcff",
          "#dcecf8",
          "#e5def8",
        ];
        const rail = document.querySelector(".workspace-rail")!;
        return {
          body: compare("--secondary", surfaces),
          focus: compare("--focus", surfaces),
          control: compare("--control-outline", [
            "--surface",
            "--glass",
            "--inset",
            "--accent-surface",
          ]),
          primary: compare("--surface", ["--action", "#6755c4"]),
          status: Math.min(
            compare("--risk", ["--risk-surface"]),
            compare("--confirmed", ["--confirmed-surface"]),
            compare("--critical", ["--critical-surface"]),
          ),
          railBlur: getComputedStyle(rail).backdropFilter,
          motion: getComputedStyle(document.querySelector("button")!)
            .transitionDuration,
        };
      });
      expect(measured.body).toBeGreaterThanOrEqual(4.5);
      expect(measured.focus).toBeGreaterThanOrEqual(3);
      expect(measured.control).toBeGreaterThanOrEqual(3);
      expect(measured.primary).toBeGreaterThanOrEqual(4.5);
      expect(measured.status).toBeGreaterThanOrEqual(4.5);
      expect(measured.railBlur).toBe("none");
      expect(
        measured.motion
          .split(", ")
          .every((duration) => parseFloat(duration) <= 0.01),
      ).toBe(true);
      await info.attach("contrast", {
        body: JSON.stringify(measured),
        contentType: "application/json",
      });
    });
  } finally {
    await close();
  }
});
