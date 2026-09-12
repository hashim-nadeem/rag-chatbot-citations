/**
 * Captures the README screenshots against a running server.
 *
 *   npm run build && npm start        # in one terminal
 *   npm run shots                     # in another
 *
 * Set PLAYWRIGHT_CHROMIUM_PATH to use a Chromium you already have rather than
 * the one `npx playwright install chromium` downloads.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";

const BASE = process.env.SHOTS_BASE_URL ?? "http://127.0.0.1:3000";
const OUT = path.join(process.cwd(), "public", "shots");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 375, height: 812 };

/** Motion is disabled for capture so nothing is caught mid-transition. */
const STILL = "@media { *, *::before, *::after { transition: none !important; animation: none !important; } }";

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function shot(page: Page, name: string, fullPage = false) {
  await settle(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
  console.log(`  ${name}.png`);
}

/** Ask a question via a suggested chip and wait for the answer to finish. */
async function askFirstSuggestion(page: Page, match: RegExp) {
  const chip = page.getByRole("button", { name: match }).first();
  if (!(await chip.count())) return false;
  await chip.click();
  await page.getByText("Sources", { exact: true }).first().waitFor({ timeout: 30_000 });
  return true;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath });

  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({
      viewport: DESKTOP,
      colorScheme: scheme,
      deviceScaleFactor: 2,
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    await page.addStyleTag({ content: STILL }).catch(() => {});
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await shot(page, `01-empty-${scheme}`);

    if (await askFirstSuggestion(page, /social security wage base/i)) {
      await shot(page, `02-answer-${scheme}`);

      // The citation chip in the inline answer opens the source drawer.
      const cite = page.locator("button[aria-label^='Source 1']").first();
      if (await cite.count()) {
        await cite.click();
        await page.locator("dialog[open]").waitFor({ timeout: 10_000 });
        await shot(page, `03-drawer-${scheme}`);
        await page.keyboard.press("Escape");
      }
    }
    await ctx.close();
  }

  // 375px: the spec's no-horizontal-scroll floor.
  const mobileCtx = await browser.newContext({
    viewport: MOBILE,
    colorScheme: "dark",
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const mobile = await mobileCtx.newPage();
  await mobile.goto(BASE, { waitUntil: "domcontentloaded" });
  await shot(mobile, "04-mobile-empty");

  const overflow = await mobile.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`\n  horizontal overflow at 375px: ${overflow}px ${overflow <= 0 ? "(none)" : "<-- FAIL"}`);

  if (await askFirstSuggestion(mobile, /social security wage base/i)) {
    await shot(mobile, "05-mobile-answer");
    const cite = mobile.locator("button[aria-label^='Source 1']").first();
    if (await cite.count()) {
      await cite.click();
      await mobile.locator("dialog[open]").waitFor({ timeout: 10_000 });
      await shot(mobile, "06-mobile-drawer");
    }
  }

  await mobileCtx.close();
  await browser.close();
  console.log(`\nwrote ${OUT}`);
}

main().catch((err) => {
  console.error(`\nscreenshots failed: ${err.message}`);
  process.exit(1);
});
