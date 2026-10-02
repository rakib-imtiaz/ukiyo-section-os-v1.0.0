#!/usr/bin/env node
/* Capture crisp (2x) screenshots of every ThemeBot screen for the client report.
 * Drives a throwaway headless Chrome over CDP against the running dev server (localhost:5173).
 * Wizard state is seeded through localStorage so each screen renders exactly as a user sees it.
 *   node capture.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.join(HERE, 'img');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9339;
const APP = 'http://localhost:5173/';
const SITE = 'https://tq7iktftxpxps.kimi.page/?sharetype=link';
const W = 1440, H = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(os.tmpdir(), 'themebot-capture-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
let ver = null;
for (let i = 0; i < 40; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); } }
if (!ver) { chrome.kill(); throw new Error('Chrome debugging port never came up'); }
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
// Always bounce through about:blank: a hash-only navigation would not remount the app, so
// seeded localStorage state would never be picked up.
const goto = async (url, wait = 2500) => { await send('Page.navigate', { url: 'about:blank' }); await sleep(300); await send('Page.navigate', { url }); await sleep(wait); };
const shot = async (name) => {
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(path.join(OUT, name), Buffer.from(res.result.data, 'base64'));
  console.log('captured', name);
};
const setStore = async (entries) => {
  const code = Object.entries(entries).map(([k, v]) => v === null ? `localStorage.removeItem(${JSON.stringify(k)});` : `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(typeof v === 'string' ? v : JSON.stringify(v))});`).join('');
  await evaluate(code + '1');
};

await fs.mkdir(OUT, { recursive: true });
// Land on the app once so localStorage is on the right origin, then seed state per screen.
await goto(APP + '#home', 3500);
await setStore({ 'factory-theme': 'light', 'factory-tab': 'dashboard', 'factory-wizard-mode': null, 'factory-easy-draft': null, 'factory-wizard-draft': null });
await goto(APP + '#home', 3500);
await shot('s01-home.png');
await goto(APP + '#projects', 3000);
await shot('s02-projects.png');
await goto(APP + '#factory', 3000);
await shot('s03-factory-dashboard.png');

await setStore({ 'factory-tab': 'new' });
await goto(APP + '#factory', 3000);
await shot('s04-choose.png');

const draft = { step: 0, storeName: 'Wild & Sacred', siteUrl: SITE, intakeId: null, reactFilesPath: '', info: null, sourceKind: 'zip', confirmed: false, qaEngine: 'playwright' };
await setStore({ 'factory-wizard-mode': 'easy', 'factory-easy-draft': draft });
await goto(APP + '#factory', 3000);
await shot('s05-easy-step1.png');

await setStore({ 'factory-easy-draft': { ...draft, step: 1 } });
await goto(APP + '#factory', 14000);
await shot('s06-easy-preview.png');

// The app scrolls an inner panel, so a taller viewport is the reliable way to show whole screens.
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 1360, deviceScaleFactor: 2, mobile: false });
await setStore({ 'factory-easy-draft': { ...draft, step: 2, confirmed: true } });
await goto(APP + '#factory', 9000);
await shot('s07-easy-ready.png');

// The "check in my Chrome" branch with its one-time setup card.
await evaluate(`(() => { const b = [...document.querySelectorAll('[role="radio"]')].find((el) => /Check in my Chrome/.test(el.textContent)); b && b.click(); return 1; })()`);
await sleep(2500);
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 1700, deviceScaleFactor: 2, mobile: false });
await sleep(800);
await shot('s08-easy-chrome-setup.png');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });

// The built-in browser, live on the client's website: start it and point it at the site through
// the app's own local MCP endpoint (same tools the autopilot uses), then show the Browser view.
await goto(APP + '#home', 2000);
await evaluate(`fetch('/mcp-local', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: ${JSON.stringify(SITE)} } } }) }).then((r) => r.status)`);
await sleep(4000);
await goto(APP + '#browser', 7000);
await shot('s09-browser.png');

ws.close(); chrome.kill();
await sleep(500);
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
console.log('done');
