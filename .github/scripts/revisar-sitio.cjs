// Abre las páginas publicadas en un navegador y muestra qué se ve y qué errores hay.
const { chromium } = require("playwright");
const BASE = process.env.SITE_URL || "https://tacos-josue.web.app";
const PAGES = ["/", "/mesa?m=1", "/llevar", "/casa", "/panel"];
(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  for (const path of PAGES) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const problems = [];
    page.on("pageerror", (e) => problems.push("ERROR JS: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") problems.push(`consola ${m.type()}: ${m.text()}`); });
    page.on("requestfailed", (r) => problems.push(`falló ${r.url()} (${r.failure()?.errorText})`));
    page.on("response", (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
    try {
      await page.goto(BASE + path, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(8000);
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 400);
      console.log(`\n=== ${path} ===\nTexto: ${text}`);
    } catch (e) {
      console.log(`\n=== ${path} ===\nNo abrió: ${e.message}`);
    }
    console.log(problems.length ? problems.map((p) => "  - " + p).join("\n") : "  (sin errores)");
    await page.close();
  }
  await browser.close();
})();
