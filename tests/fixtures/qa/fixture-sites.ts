// Two tiny local "sites" for the QA parity test: the React original (truth) and a Shopify clone
// with known defects —
//   * home: the "Loved by many" testimonials band is missing          → missing_section (+ its link → missing_interaction)
//   * home: the hero copy was reworded                                 → text_drift
//   * home: "Open gallery" does nothing on the clone                   → interaction_noop
//   * footer: "About us" points to the wrong page on the clone         → interaction_target
//   * header: an extra "Search" link only on the clone                 → extra_interaction (informational)
//   * "Add to cart" exists on both and must never be clicked           → verified statically
// /about (React) ↔ /pages/about (Shopify) is identical on both.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const css = `
  body{margin:0;font-family:sans-serif} header,footer{padding:16px 24px;background:#f4f1ea}
  header a,footer a{margin-right:16px} main{display:block}
  section{min-height:240px;padding:40px 24px;border-bottom:1px solid #ddd}
  .modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);color:#fff;padding:80px}
  .modal.open{display:block}
`;

const page = (title: string, nav: string, main: string, footer: string, script = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head>
<body>
<header><nav>${nav}</nav></header>
<main>${main}</main>
<footer>${footer}</footer>
<div class="modal" id="gallery" role="dialog"><h2>Gallery</h2><p>Twelve photographs of the studio, the garden and the drying racks.</p></div>
<script>
  document.querySelectorAll('[data-toggle]').forEach(function (button) {
    button.addEventListener('click', function () {
      var open = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!open));
      document.getElementById(button.getAttribute('data-toggle')).hidden = open;
    });
  });
  ${script}
</script>
</body></html>`;

const hero = (copy: string) => `
<section id="hero">
  <h1>Wild &amp; Sacred botanical rituals</h1>
  <p>${copy}</p>
  <button type="button" data-toggle="ingredients" aria-expanded="false">Show ingredients</button>
  <ul id="ingredients" hidden><li>Lavender</li><li>Chamomile</li><li>Rose petals</li><li>Mugwort</li></ul>
</section>`;

const features = (aboutHref: string) => `
<section id="features">
  <h2>Why choose us</h2>
  <p>Small batch organic ingredients, ethically sourced from trusted family farms in the Pacific Northwest. Every harvest is tested for purity before it reaches the studio.</p>
  <a href="${aboutHref}">Learn more</a>
</section>`;

const testimonials = `
<section id="testimonials">
  <h2>Loved by many</h2>
  <p>Customers love the calming evening rituals. Five stars across two thousand verified reviews, with the sleep blend the most reordered tea of the year.</p>
  <a href="https://example.com/reviews">Read all reviews</a>
</section>`;

const collection = `
<section id="collection">
  <h2>See the collection</h2>
  <p>Seasonal tins, loose leaf refills and the ceramic brewing set, photographed in the studio garden at first light.</p>
  <button type="button" id="open-gallery">Open gallery</button>
  <button type="button" class="product-form__add">Add to cart</button>
</section>`;

const about = `
<section id="story">
  <h2>Our story</h2>
  <p>Two sisters started blending teas in a converted barn in 2019. Today a team of nine hand-packs every order and plants a tree for each one shipped.</p>
  <button type="button" data-toggle="timeline" aria-expanded="false">Read more</button>
  <ol id="timeline" hidden><li>2019: the barn</li><li>2021: the first shop</li><li>2024: the garden studio</li></ol>
</section>
<section id="makers">
  <h2>Meet the makers</h2>
  <p>Our blenders, growers and packers share a love of slow mornings, good soil and honest ingredients sourced within two hundred miles.</p>
</section>`;

const galleryScript = `document.getElementById('open-gallery').addEventListener('click', function () { document.getElementById('gallery').classList.add('open'); });`;

const REACT_COPY = 'Handcrafted botanical rituals for modern life. Small batch blends made in Oregon. Every jar is poured by hand and sealed with beeswax.';
const SHOPIFY_COPY = 'Botanical rituals, made for today. Our blends come from Oregon. Each jar arrives sealed and ready to brew.';

const reactPages: Record<string, string> = {
  '/': page('Wild & Sacred', '<a href="/">Home</a><a href="/about">About</a>', hero(REACT_COPY) + features('/about') + testimonials + collection, '<a href="/about">About us</a><a href="https://instagram.com/wildsacred">Instagram</a>', galleryScript),
  '/about': page('About — Wild & Sacred', '<a href="/">Home</a><a href="/about">About</a>', about, '<a href="/about">About us</a><a href="https://instagram.com/wildsacred">Instagram</a>'),
};

const shopifyPages: Record<string, string> = {
  // the clone's "Open gallery" has no handler (no galleryScript) and its footer link is wrong
  '/': page('Wild & Sacred', '<a href="/">Home</a><a href="/pages/about">About</a><a href="/search">Search</a>', hero(SHOPIFY_COPY) + features('/pages/about') + collection, '<a href="/pages/contact">About us</a><a href="https://instagram.com/wildsacred">Instagram</a>'),
  '/pages/about': page('About — Wild & Sacred', '<a href="/">Home</a><a href="/pages/about">About</a><a href="/search">Search</a>', about, '<a href="/pages/about">About us</a><a href="https://instagram.com/wildsacred">Instagram</a>'),
};

function serve(pages: Record<string, string>): Promise<Server> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname.replace(/\/$/, '') || '/';
    const body = pages[pathname];
    response.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(body ?? '<!doctype html><html><body><h1>Not found</h1></body></html>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

export interface FixtureSites { reactBase: string; shopifyBase: string; close(): Promise<void> }

export async function startFixtureSites(): Promise<FixtureSites> {
  const react = await serve(reactPages);
  const shopify = await serve(shopifyPages);
  const url = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    reactBase: url(react),
    shopifyBase: url(shopify),
    async close() {
      for (const server of [react, shopify]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
