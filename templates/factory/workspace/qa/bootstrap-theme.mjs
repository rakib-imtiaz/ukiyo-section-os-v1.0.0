// Create an unpublished dev theme (idempotent: reuse by name if it already exists).
// Dev theme name comes from job.json (dev_theme_name) — never derived here.
import { writeFileSync, mkdirSync } from 'node:fs';
import { mint, client, project, ROOT } from './lib.mjs';

const { dev_theme_name } = project();
const NAME = dev_theme_name || 'Clone (dev)';
const { token, host } = await mint();
const c = client(token, host);

const list = (await (await c.rest('themes.json')).json()).themes;
let dev = list.find((t) => t.name === NAME);
if (dev) {
  console.log(`reusing dev theme [${dev.id}] ${dev.name} (${dev.role})`);
} else {
  const r = await c.rest('themes.json', { method: 'POST', body: JSON.stringify({ theme: { name: NAME, role: 'unpublished' } }) });
  if (!r.ok) { console.log(`FAIL create theme HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); process.exit(1); }
  dev = (await r.json()).theme;
  console.log(`created dev theme [${dev.id}] ${dev.name}`);
}

const live = list.find((t) => t.role === 'main');
mkdirSync(`${ROOT}/qa/state`, { recursive: true });
writeFileSync(`${ROOT}/qa/state/theme.json`, JSON.stringify({
  host, dev_theme_id: dev.id, live_theme_id: live?.id,
  preview_base: `https://${host}?preview_theme_id=${dev.id}`,
}, null, 2));
console.log(`host: ${host}`);
console.log(`dev preview:  https://${host}/?preview_theme_id=${dev.id}`);
console.log(`live theme:   ${live?.id} (${live?.name})`);
console.log('wrote qa/state/theme.json');
