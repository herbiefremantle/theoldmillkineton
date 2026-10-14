// Server-side rendering of the public pages, so search engines and link previews see the full content
// without running JavaScript. It runs the browser's own public/app.js in a sandbox with a minimal pretend
// browser, then calls the same view functions the page uses, so the HTML always matches what visitors see.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = path.join(__dirname, '..', 'public', 'app.js');
const INDEX = path.join(__dirname, '..', 'public', 'index.html');

function makeContext() {
  const el = () => ({ innerHTML: '', textContent: '', hidden: false, dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute() { return null }, hasAttribute() { return false }, addEventListener() {}, querySelector() { return null }, querySelectorAll() { return [] } });
  const noop = () => {};
  const ctx = {
    console, setTimeout, clearTimeout, URLSearchParams, URL, Intl, structuredClone, encodeURIComponent, decodeURIComponent,
    scrollY: 0, scrollTo: noop, addEventListener: noop, matchMedia: () => ({ matches: false }),
    fetch: () => new Promise(() => {}), // never answers: the page's own data loading is not used here
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { pathname: '/__ssr', hash: '', search: '', href: '' },
    history: { replaceState: noop, pushState: noop },
    navigator: { userAgent: 'ssr', platform: '', maxTouchPoints: 0 },
    document: { addEventListener: noop, querySelector: () => el(), querySelectorAll: () => [], getElementById: () => el(), createElement: () => el() }
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

let cache = null; // { mtime, ctx }
function context() {
  const mtime = fs.statSync(APP_JS).mtimeMs;
  if (cache && cache.mtime === mtime) return cache.ctx;
  const src = fs.readFileSync(APP_JS, 'utf8') + `
;globalThis.__ssr = function (st) {
  S = st.S; loaded = true; mode = 'public'; me = null; priceTier = 'kineton'; tierChosen = false; siteFilter = 'all'; curPhoto = 0;
  view = st.view; curUnit = st.curUnit || null; curCat = st.curCat || 'rooms';
  const html = view === 'unit' ? viewUnit() : view === 'cat' ? viewCategory() : viewSite();
  const u = view === 'unit' ? findUnit(curUnit) : null;
  return { html, meta: pageMeta(), tierbar: priceBar(), unit: u };
};
globalThis.__paths = function (st) {
  S = st.S;
  return { cats: Object.values(CATS).map(c => c.path), units: units().map(u => ({ id: u.id, path: unitPath(u) })) };
};`;
  const ctx = makeContext();
  vm.runInContext(src, ctx, { filename: 'app.js' });
  cache = { mtime, ctx };
  return ctx;
}

const render = state => context().__ssr(state);
const paths = state => context().__paths(state);
const template = () => fs.readFileSync(INDEX, 'utf8');

module.exports = { render, paths, template };
