import { chromium } from "playwright";

export async function runDefaultSmokeTest(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];

  page.on("console", msg => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", err => {
    errors.push(err.message);
  });

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector("body", { timeout: 10000 });
    const text = await page.locator("body").innerText({ timeout: 10000 });
    if (!text || text.trim().length < 20) {
      throw new Error("Page body too short.");
    }
    if (errors.length > 0) {
      throw new Error(`Console errors: ${errors.join(" | ")}`);
    }
    return { passed: true, bodyPreview: text.slice(0, 500), errors };
  } finally {
    await browser.close();
  }
}
