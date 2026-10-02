#!/usr/bin/env node
/* Render report.html → report.pdf with headless Chrome over the DevTools protocol.
 * Images are inlined as data URIs so the PDF never depends on the folder layout.
 *   node build-pdf.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const IN = path.join(HERE, process.argv[3] ?? 'report.html');
const OUT = path.join(HERE, process.argv[2] ?? 'report.pdf');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9337;

let body = await fs.readFile(IN, 'utf8');
for (const match of body.matchAll(/src="(img\/[^"]+)"/g)) {
  const file = path.join(HERE, match[1]);
  const data = await fs.readFile(file);
  const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
  body = body.replace(match[0], `src="data:${mime};base64,${data.toString('base64')}"`);
}
const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8">${body}</head><body></body></html>`;
const tmp = path.join(os.tmpdir(), 'themebot-report-' + Date.now() + '.html');
await fs.writeFile(tmp, doc, 'utf8');

const profile = path.join(os.tmpdir(), 'themebot-report-chrome-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver = null;
for (let i = 0; i < 40; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); } }
if (!ver) { chrome.kill(); throw new Error('Chrome debugging port never came up'); }
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?` + encodeURI('file:///' + tmp.replace(/\\/g, '/')), { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
await send('Page.enable');
await sleep(1500);
await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>1)', awaitPromise: true });
await sleep(500);
const footer = `<div style="width:100%;font-family:Arial,sans-serif;font-size:7pt;color:#8A9187;padding:0 13mm;display:flex;justify-content:space-between;"><span>ThemeBot — Challenges &amp; fixes, 24 September 2026</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
const res = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer });
if (!res.result?.data) { chrome.kill(); throw new Error('printToPDF returned nothing: ' + JSON.stringify(res).slice(0, 300)); }
await fs.writeFile(OUT, Buffer.from(res.result.data, 'base64'));
ws.close(); chrome.kill();
await fs.rm(tmp, { force: true });
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
const { size } = await fs.stat(OUT);
console.log('-> ' + OUT + ' (' + Math.round(size / 1024) + ' KB)');
