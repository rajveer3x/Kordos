import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";

const populated = {
  path: "/preview/#/projects/checkout",
  title: "Checkout modernization",
  action: "View evidence",
};
const empty = {
  path: "/preview/#/projects/developer-portal",
  title: "Developer portal",
  action: "Add a brief",
};

async function expectVisibleOverview(page: Page, project: typeof populated) {
  await expect(
    page.getByRole("heading", { name: project.title, level: 1 }),
  ).toBeInViewport();
  await expect(
    page
      .locator(".project-heading")
      .getByRole("button", { name: project.action, exact: true }),
  ).toBeInViewport();
  const current = page
    .getByRole("navigation", { name: "Project", exact: true })
    .getByRole("link", { name: "Overview" });
  await expect(current).toHaveAttribute("aria-current", "page");
  await expect(current).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    await page.evaluate(() => window.innerWidth),
  );
}

for (const [state, project] of Object.entries({ populated, empty })) {
  for (const [size, viewport] of Object.entries({
    desktop: { width: 1440, height: 960 },
    mobile: { width: 390, height: 844 },
  })) {
    test(`${state} overview at ${size}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto(project.path);
      await expectVisibleOverview(page, project);

      if (state === "populated") {
        await expect(page.getByText("At risk", { exact: true })).toBeVisible();
        await expect(
          page.getByText("Jan 24, 2027", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText("Jan 28, 2027", { exact: true }),
        ).toBeVisible();
      } else {
        await expect(page.getByText("Not set", { exact: true })).toHaveCount(2);
        await expect(
          page.getByRole("button", { name: "Create task" }),
        ).toBeVisible();
        await expect(page.getByRole("blockquote")).toHaveCount(0);
      }

      await page.evaluate(() => document.fonts.ready);
      const screenshot = testInfo.outputPath(`${state}-${size}.png`);
      await page.screenshot({
        path: screenshot,
        fullPage: true,
        animations: "disabled",
      });
      await testInfo.attach(`${state} overview at ${size}`, {
        path: screenshot,
        contentType: "image/png",
      });
    });
  }
}

test("tablet overview links to the selected signal source", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(populated.path);
  await expectVisibleOverview(page, populated);

  const workspace = page.getByRole("navigation", {
    name: "Workspace",
    exact: true,
  });
  await expect(
    workspace.getByRole("link", { name: "Projects" }),
  ).toHaveAttribute("aria-current", "page");
  const evidence = page.getByRole("button", {
    name: "View evidence for Rollout starts with a regional pilot",
  });
  await evidence.focus();
  await page.keyboard.press("Enter");

  const inspector = page.getByRole("dialog", { name: "Evidence" });
  await expect(inspector.getByRole("button", { name: "Back" })).toBeFocused();
  await expect(inspector.getByText("Checkout rollout review")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    inspector.getByRole("link", { name: "Open source" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(inspector).toHaveCount(0);
  await expect(page.getByRole("main")).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Checkout rollout review", level: 2 }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Project", exact: true })
      .getByRole("link", { name: "Documents" }),
  ).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Checkout rollout review", level: 2 }),
  ).toBeVisible();
});

test("320 px overview reflows with keyboard navigation and reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(populated.path);
  await expectVisibleOverview(page, populated);

  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await expect(page).toHaveURL(/#\/projects\/checkout$/);

  const menu = page.getByRole("button", { name: "Open workspace navigation" });
  await menu.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: "Northstar Studio" });
  await expect(drawer).toHaveCSS("animation-name", "none");
  await expect(
    drawer.getByRole("button", { name: "Close navigation" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(drawer.getByRole("link", { name: "Home" })).toBeFocused();
  await expect(drawer.getByRole("link", { name: "Projects" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();

  const evidence = page.getByRole("button", {
    name: "View evidence",
    exact: true,
  });
  await evidence.focus();
  await page.keyboard.press("Enter");
  const inspector = page.getByRole("dialog", { name: "Evidence" });
  await expect(inspector).toHaveCSS("animation-name", "none");
  await expect(inspector.getByRole("button", { name: "Back" })).toBeFocused();
  expect((await inspector.boundingBox())?.width).toBe(320);
  await page.keyboard.press("Enter");
  await expect(evidence).toBeFocused();
  await expect(inspector).toHaveCount(0);

  await menu.click();
  await drawer.getByRole("link", { name: "Inbox" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("main")).toBeFocused();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});

test("workspace entry and a project deep link require a live session", async ({
  page,
}) => {
  for (const path of ["/", "/projects/checkout/documents/payments-sync"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(
      page.getByRole("heading", { name: "Sign in to Kordos" }),
    ).toBeVisible();
    await expect(page.getByText("Northstar Studio")).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Project", exact: true }),
    ).toHaveCount(0);
  }
});

test("200% Chromium page zoom keeps the overview usable", async ({
  baseURL,
}, testInfo) => {
  const extension = testInfo.outputPath("zoom-extension");
  await mkdir(extension, { recursive: true });
  await writeFile(
    join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Kordos zoom test",
      version: "1.0",
      background: { service_worker: "zoom.js" },
    }),
  );
  await writeFile(
    join(extension, "zoom.js"),
    `
    chrome.runtime.onInstalled.addListener(() => {});
    globalThis.zoomActiveTab = async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.setZoom(tab.id, 2);
      return chrome.tabs.getZoom(tab.id);
    };
  `,
  );

  const browser = await chromium.launchPersistentContext(
    testInfo.outputPath("zoom-profile"),
    {
      baseURL,
      channel: "chromium",
      headless: true,
      viewport: { width: 640, height: 900 },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    },
  );
  try {
    const worker =
      browser.serviceWorkers()[0] ??
      (await browser.waitForEvent("serviceworker", { timeout: 10000 }));
    const page = browser.pages()[0] ?? (await browser.newPage());
    await page.goto(populated.path);
    expect(await worker.evaluate("zoomActiveTab()")).toBe(2);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(320);
    await expectVisibleOverview(page, populated);
    await page
      .getByRole("button", { name: "View evidence", exact: true })
      .click();
    await expect(page.getByRole("button", { name: "Back" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "View evidence", exact: true }),
    ).toBeFocused();
  } finally {
    await browser.close();
  }
});
