#!/usr/bin/env node
// TEST FIXTURE — a stand-in for the Claude Code CLI, used by tests/steps-e2e.test.ts. It never calls
// any AI. The runner launches it (THEMEBOT_FAKE_CLAUDE=1 + FACTORY_CLAUDE_PATH=<this file>) exactly
// like `claude -p --model <m> --no-session-persistence --output-format stream-json --verbose`, with
// the step prompt on stdin. It:
//   - reads the prompt from stdin (and records whether one arrived there, never its text),
//   - finds the signal file the prompt asks for (factory/steps/<id>.done or fix-complete-<n>.md),
//   - writes plausible step outputs (inventory.json, handles.json, sections, templates, final.md …),
//   - prints stream-json lines (init, an assistant turn, a user echo of the prompt, result),
//   - simulates Claude Code's transcript (prompt included!) under $CLAUDE_CONFIG_DIR/projects/<slug>/
//     — only when CLAUDE_CONFIG_DIR is set, so the real ~/.claude is never touched — so the runner's
//     cleanup can be checked,
//   - then writes the signal file and exits.
// Controls (env; the runner passes CLAUDE_* through): CLAUDE_FAKE_LOG (JSON lines about each run),
// CLAUDE_FAKE_STATE (folder for hang/wait markers), CLAUDE_FAKE_HANG=<step file id> (hang the first
// time that step runs), CLAUDE_FAKE_WAIT=<step file id> (wait for <state>/release-<id> before
// finishing), CLAUDE_FAKE_BLOCK=<step file id> (write BLOCKED.md instead), CLAUDE_FAKE_PAGES (JSON
// page list for the inventory), CLAUDE_FAKE_DELAY_MS (how long page/check steps take),
// CLAUDE_FAKE_SAVE_PROMPTS=<folder> (keep a copy of each prompt received there — ONLY for the
// integration test's leak-attribution check; that folder is the test's own temp dir, never a workspace).
import { appendFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
const cwd = process.cwd();
const env = process.env;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const write = (relative, content) => {
  const target = path.join(cwd, ...relative.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
};

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');

const signal = /`(factory\/steps\/[a-z0-9._-]+\.done)`/.exec(prompt)?.[1] ?? /`(qa\/reports\/fix-complete-\d+\.md)`/.exec(prompt)?.[1] ?? null;
const stepFile = signal ? path.basename(signal).replace(/\.(done|md)$/, '') : null;
const sessionId = randomUUID();
const model = args[args.indexOf('--model') + 1] ?? 'unknown';
const log = (entry) => { if (env.CLAUDE_FAKE_LOG) appendFileSync(env.CLAUDE_FAKE_LOG, `${JSON.stringify({ at: Date.now(), pid: process.pid, cwd, ...entry })}\n`); };

log({
  event: 'start', step: stepFile, signal, model, sessionId, argv: args, cwd,
  stdinBytes: Buffer.byteLength(prompt),
  canaries: [...new Set(prompt.match(/tbr-canary-[0-9a-f]{12}/g) ?? [])],
  noPersistence: args.includes('--no-session-persistence'),
  rebuildNote: prompt.includes('THIS IS A REBUILD'),
});

if (env.CLAUDE_FAKE_SAVE_PROMPTS && prompt.trim()) {
  mkdirSync(env.CLAUDE_FAKE_SAVE_PROMPTS, { recursive: true });
  writeFileSync(path.join(env.CLAUDE_FAKE_SAVE_PROMPTS, `${stepFile ?? 'unknown'}.${process.pid}.prompt.txt`), prompt);
}

if (!prompt.trim()) { process.stderr.write('Error: Input must be provided either through stdin or as a prompt argument when using --print\n'); process.exit(1); }
if (!signal) { out({ type: 'result', subtype: 'error', is_error: true, result: 'no signal file in prompt', session_id: sessionId }); process.exit(2); }

// What Claude Code would keep on disk for this session (the runner must delete it).
if (env.CLAUDE_CONFIG_DIR) {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const folder = path.join(env.CLAUDE_CONFIG_DIR, 'projects', slug);
  mkdirSync(path.join(folder, sessionId, 'subagents'), { recursive: true });
  writeFileSync(path.join(folder, `${sessionId}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
  writeFileSync(path.join(folder, sessionId, 'subagents', 'agent-a1.jsonl'), '{"type":"user"}\n');
  log({ event: 'transcript', step: stepFile, file: path.join(folder, `${sessionId}.jsonl`) });
}

out({ type: 'system', subtype: 'init', session_id: sessionId, model, cwd });
// A raw stream can echo the prompt (e.g. --replay-user-messages): the runner must never log raw lines.
out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
out({ type: 'assistant', session_id: sessionId, message: { id: `msg_${sessionId.slice(0, 8)}`, model, usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: `Working on ${stepFile}.` }, { type: 'tool_use', name: 'Write', input: { file_path: path.join(cwd, signal) } }] } });

const state = env.CLAUDE_FAKE_STATE;
if (state && env.CLAUDE_FAKE_HANG === stepFile && !existsSync(path.join(state, `hung-${stepFile}`))) {
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, `hung-${stepFile}`), String(process.pid));
  log({ event: 'hang', step: stepFile });
  setInterval(() => out({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: 'still thinking' }] } }), 1000);
  setTimeout(() => process.exit(9), 120_000); // never outlive an aborted test run
  await new Promise(() => {}); // until killed
}
if (state && env.CLAUDE_FAKE_WAIT === stepFile) {
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, `waiting-${stepFile}`), String(process.pid));
  const giveUp = Date.now() + 120_000;
  while (!existsSync(path.join(state, `release-${stepFile}`))) {
    if (Date.now() > giveUp) process.exit(9);
    await sleep(100);
  }
}
// Page work takes a moment, so concurrent page steps visibly overlap.
if (env.CLAUDE_FAKE_DELAY_MS && /^(page|verify)-/.test(stepFile)) await sleep(Number(env.CLAUDE_FAKE_DELAY_MS));
if (env.CLAUDE_FAKE_BLOCK === stepFile) {
  write('qa/reports/BLOCKED.md', `# BLOCKED\nThe custom app is missing write_online_store_navigation (fake).\n`);
  out({ type: 'result', subtype: 'success', is_error: false, result: 'blocked', session_id: sessionId });
  log({ event: 'blocked', step: stepFile });
  process.exit(0);
}

// --- plausible outputs per step ---------------------------------------------------------------------
let job = {};
try { job = JSON.parse(readFileSync(path.join(cwd, 'job.json'), 'utf8')); } catch { /* none */ }
const prefix = job.prefix ?? 'xx';
const defaultPages = [
  { route: '/', name: 'Home', react_file: 'src/pages/HomePage.tsx', shopify_handle: '', template: 'index.json', band_count: 5, complexity: 'complex', model: 'opus' },
  { route: '/about', name: 'About', react_file: 'src/pages/AboutPage.tsx', shopify_handle: 'about', template: `page.${prefix}_about.json`, band_count: 2, complexity: 'simple', model: 'sonnet' },
  { route: '/contact', name: 'Contact', react_file: 'src/pages/ContactPage.tsx', shopify_handle: 'contact', template: `page.${prefix}_contact.json`, band_count: 2, complexity: 'simple', model: 'sonnet' },
];
const pages = env.CLAUDE_FAKE_PAGES ? JSON.parse(env.CLAUDE_FAKE_PAGES) : defaultPages;
const templateFor = (page) => `templates/${page.template ?? `page.${prefix}_${page.shopify_handle}.json`}`;

if (stepFile === 'preflight') {
  write('qa/reports/preflight.md', 'PREFLIGHT PASSED (fake)\n');
  write('qa/reports/identity.md', 'Verdict: match (fake)\n');
} else if (stepFile === 'inventory') {
  write('qa/state/inventory.json', { pages, header: { nav_items: [] }, footer: { columns: [] }, images: [] });
  write('qa/reports/inventory.md', `${pages.length} pages (fake)\n`);
} else if (stepFile === 'bootstrap') {
  write('qa/state/theme.json', { host: 'fake.myshopify.com', dev_theme_id: 1, live_theme_id: 2, preview_base: 'https://fake.myshopify.com?preview_theme_id=1' });
  write('layout/theme.liquid', "{% sections 'header-group' %}{{ content_for_layout }}{% sections 'footer-group' %}\n");
  write(`sections/${prefix}-header.liquid`, '<header class="full-width"></header>\n');
  write('qa/state/bootstrap.json', { reveal_attribute: `data-${prefix}-reveal` });
} else if (stepFile === 'store-setup') {
  write('qa/state/handles.json', pages.map((page) => ({ route: page.route, handle: page.shopify_handle, shopify_path: page.route === '/' ? '/' : `/pages/${page.shopify_handle}`, template: templateFor(page) })));
  write('qa/state/images.json', {});
} else if (stepFile.startsWith('page-')) {
  const page = pages.find((entry) => (entry.route === '/' ? 'home' : entry.route.slice(1).replace(/[^a-z0-9]+/g, '-')) === stepFile.slice(5));
  if (page) {
    const sections = {};
    for (let band = 1; band <= (page.band_count ?? 1); band += 1) {
      const type = `${prefix}-${stepFile.slice(5)}-band${band}`;
      write(`sections/${type}.liquid`, `<section class="full-width ${type}"></section>\n`);
      sections[`band${band}`] = { type };
    }
    write(templateFor(page), { sections, order: Object.keys(sections) });
  }
} else if (stepFile.startsWith('verify-')) {
  write(`qa/state/progress/${stepFile.slice(7)}.json`, { status: 'passed', iterations: 1 });
} else if (stepFile === 'final') {
  write('qa/reports/final.md', '# Final report (fake)\nAll pages built.\n');
}

write(signal, `${stepFile} done (fake)\n`);
out({ type: 'assistant', session_id: sessionId, message: { id: `msg_${sessionId.slice(0, 8)}_2`, model, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: `Finished ${stepFile}.` }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId, duration_ms: 5, num_turns: 1, modelUsage: {} });
log({ event: 'done', step: stepFile });
