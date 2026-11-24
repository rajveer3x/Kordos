import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect, type TestInfo } from "@playwright/test";

export async function startChromiumZoom(testInfo: TestInfo, baseURL?: string) {
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

  const context = await chromium.launchPersistentContext(
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
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    context,
    page,
    async zoom() {
      const worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent("serviceworker", { timeout: 10000 }));
      await page.bringToFront();
      expect(await worker.evaluate("zoomActiveTab()")).toBe(2);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(320);
    },
  };
}
