import { chromium } from 'playwright';
import path from 'node:path';
const dir = 'C:/patrick_workspace/SHOPIFY_APP/ukiyo-section-os-v1.0.0/_deliverables/2026-10-01_monetization-plan';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
await page.goto('file:///' + path.join(dir, 'report.html').replace(/\/g, '/'), { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);
await page.pdf({ path: dir + '/ThemeBot-Monetization-Plan-2026-10-01.pdf', format: 'A4', printBackground: true, preferCSSPageSize: true,
  displayHeaderFooter: true, headerTemplate: '<span></span>',
  footerTemplate: '<div style="width:100%;font-size:7.5pt;color:#6b7690;padding:0 15mm;display:flex;justify-content:space-between;font-family:Segoe UI,Arial"><span>ThemeBot · Monetization plan · 1 Oct 2026</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>' });
await browser.close();
console.log('ok');
