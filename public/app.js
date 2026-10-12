/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const gbp = n => (n === null || n === undefined || n === '') ? '—' : '£' + Number(n).toLocaleString('en-GB', {minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2});
const fmtDate = d => { if (!d) return '—'; const x = new Date(d.length === 10 ? d + 'T00:00:00' : d); return isNaN(x) ? d : x.toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'}); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
const monthLabel = (d = new Date()) => d.toLocaleDateString('en-GB', {month:'long', year:'numeric'});
const STATUS = {available:'Available', soon:'Coming soon', let:'Let'};
const ENQ = {new:'New request', contacted:'Contacted', waitlist:'Waitlist', converted:'Now a tenant', declined:'Closed'};
const KIND = {update:'Site update', wifi:'Wi-Fi', notice:'Notice', invoice:'Invoice'};
const INCLUDES = ['Internet & Wi-Fi', 'Electricity', 'Water'];

/* ---------- state ---------- */
// mode: 'public' (visitor), 'tenant' (signed-in tenant) or 'landlord'. me = the signed-in account.
let mode = 'public', me = null, loaded = false, access = [];
let S = {property: null, wifi: {networks: []}, units: [], tenants: [], invoices: [], messages: [], enquiries: [], outbox: []};
let view = 'site', siteFilter = 'all', ltab = 'overview', curTenant = null, enqFilter = 'open', curUnit = null, curPhoto = 0;
const COLS = ['units', 'tenants', 'invoices', 'messages', 'enquiries', 'outbox'];

const prop = () => Object.assign({name:'The Old Mill', tagline:'', address:'', description:'', features:[], email:'', phone:'', paymentNote:''}, S.property || {});
const units = () => [...S.units].sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || String(a.code).localeCompare(String(b.code)));
const unitById = id => S.units.find(u => u.id === id);
const tenantById = id => S.tenants.find(t => t.id === id);
const activeTenants = () => S.tenants.filter(t => t.status !== 'former');
const tenantInUnit = uId => activeTenants().find(t => t.unitId === uId);
const isOverdue = i => i.status === 'due' && i.due && i.due < today();
const invState = i => i.status === 'paid' ? 'paid' : isOverdue(i) ? 'overdue' : 'due';
const interestLabel = v => v === 'any' ? 'Any space' : v === 'unit1' ? 'Any Mill Room' : v === 'large' ? 'Any of Units 2–6 or the Stable Block' : (unitById(v)?.name || v);
const matches = (e, u) => e.interest === 'any' || e.interest === u.id || (e.interest === 'unit1' && u.group === 'unit1') || (e.interest === 'large' && u.group !== 'unit1');
const m2 = sqft => Math.round(sqft * 0.092903 * 10) / 10;
const sizeText = u => u.size ? `${Number(u.size).toLocaleString('en-GB')} sq ft (${m2(u.size)} m²)` : (u.widthM && u.depthM ? `${Math.round(u.widthM * u.depthM * 10) / 10} m²` : 'On request');
const scText = (u, pub) => u.serviceCharge === 'included' ? 'Included in rent' : u.serviceCharge === 'extra' ? (u.serviceChargeAmount && !(pub && u.status === 'let') ? `${gbp(u.serviceChargeAmount)} / month on top of rent (Total ${gbp(totalRent(u))})` : (pub && u.status === 'let') ? 'Payable on top of rent' : 'Payable on top of rent, amount to be confirmed') : 'None';
const billsText = u => u.inclusive ? 'Internet, electricity & water included' : 'Electricity paid by tenant';
// Local business rates: the listed rent is the Kineton rate; businesses further away pay a set amount more.
const LP_DEFAULT = {enabled: true, mode: 'percent', nearbyPct: 10, furtherPct: 20, roundTo: 5, nearbyExtra: 50, furtherExtra: 100, nearbyMiles: 6, nearbyPlaces: 'Tysoe, Wellesbourne and other villages within 6 miles', furtherPlaces: 'Leamington, Stratford, Coventry and beyond'};
const localPricing = () => Object.assign({}, LP_DEFAULT, prop().localPricing || {});
const TIERS = {kineton: 'Kineton businesses', nearby: 'Within 6 miles', further: 'Further afield'};
// Which area's prices visitors are looking at (remembered on their device).
let priceTier = 'kineton', tierChosen = false;
try { const t = localStorage.getItem('oldmill.priceTier'); if (['kineton', 'nearby', 'further'].includes(t)) { priceTier = t; tierChosen = true; } } catch (e) {}
const RATE_LABEL = {kineton: 'Kineton business rate', nearby: 'Within 6 miles rate', further: 'Standard rate'};
function priceBar() {
  if (!localPricing().enabled) return '';
  const L = localPricing(), opts = [['kineton', 'Kineton'], ['nearby', `Within ${esc(L.nearbyMiles)} miles`], ['further', 'Further afield']];
  // Once chosen: a slim line with a dropdown to change it.
  if (tierChosen) return `<div class="wrap tierbar chosen"><label class="tier-pick" for="tier-select"><span class="muted">Prices for a business based in:</span>
    <select id="tier-select" data-act="tier-select">${opts.map(([k, l]) => `<option value="${k}"${priceTier === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label></div>`;
  // First visit: ask the question, with buttons.
  const b = (k, l) => `<button type="button" data-act="tier" data-t="${k}" aria-pressed="false">${l}</button>`;
  return `<div class="wrap tierbar unchosen"><span class="tier-label"><b class="tier-q"><span class="tier-long">Where is your business based?</span><span class="tier-short">Where are you based?</span></b> <span class="muted tier-note">Choose one to see your prices. Kineton businesses get our best rates</span></span>
    <div class="filters" role="group" aria-label="Where is your business based?">${opts.map(([k, l]) => b(k, l)).join('')}</div></div>`;
}
const usesLocal = u => localPricing().enabled && u.localPricing !== false && u.rent;
// A space can set its own step-ups (e.g. the small rooms); otherwise the site-wide amounts apply.
const tierExtra = (tier, u) => {
  if (tier !== 'nearby' && tier !== 'further') return 0;
  const L = localPricing(), own = u && (tier === 'nearby' ? u.nearbyExtra : u.furtherExtra);
  if (own != null && own !== '') return Number(own) || 0;
  if (L.mode === 'percent') return Number(u && u.rent || 0) * (Number(tier === 'nearby' ? L.nearbyPct : L.furtherPct) || 0) / 100;
  return Number(tier === 'nearby' ? L.nearbyExtra : L.furtherExtra) || 0;
};
const roundPrice = n => { const r = Number(localPricing().roundTo) || 0; return r > 0 ? Math.round(n / r) * r : Math.round(n * 100) / 100; };
const priceFor = (u, tier) => !u || !u.rent ? null : !usesLocal(u) || tier === 'kineton' || !tier ? Number(u.rent) : roundPrice(Number(u.rent) + tierExtra(tier, u));
// Deposit and terms. All-inclusive rooms are on a licence; other units are on a lease with a 12-month minimum.
const TERMS = {
  licence: {short: '3-month minimum, then monthly', long: "Licence agreement: monthly rolling after a 3-month minimum, with 1 month's notice either side."},
  lease: {short: '12-month minimum', long: "Lease with a 12-month minimum term (1 to 3 years available). After the first 12 months either side can end it with 3 months' notice. Rent is reviewed each year."}
};
const termOf = u => (u.termType === 'licence' || u.termType === 'lease') ? u.termType : (u.inclusive ? 'licence' : 'lease');
const depositMonths = u => u.depositMonths != null && u.depositMonths !== '' ? Number(u.depositMonths) : (u.id === '1d' ? 2 : u.inclusive ? 1 : 2);
const isMillRoom = u => !!u && u.group === 'unit1';
// All-inclusive spaces (Mill Rooms, Unit 2, 5A, 5B) are priced per month, never called "rent".
const onePrice = u => !!u && !!u.inclusive;
const ratesIncluded = u => u.ratesIncluded != null ? !!u.ratesIncluded : !!u.inclusive;
const depositText = u => onePrice(u) ? `${depositMonths(u)} month${depositMonths(u) === 1 ? '' : 's'}` :
  `${depositMonths(u)} month${depositMonths(u) === 1 ? '' : 's'}' rent`;
const reduced = u => u.status !== 'let' && u.wasRent && u.rent && Number(u.wasRent) > Number(u.rent);
const scLine = u => u.serviceCharge === 'included' ? 'Service charge included'
  : u.serviceCharge === 'extra' ? (u.serviceChargeAmount ? `+ ${gbp(u.serviceChargeAmount)} service charge (Total ${gbp(totalRent(u))})` : '+ service charge (to be confirmed)')
  : 'No service charge';
const totalRent = u => u.rent ? Number(priceFor(u, priceTier)) + (u.serviceCharge === 'extra' && u.serviceChargeAmount ? Number(u.serviceChargeAmount) : 0) : null;
const PAY = {dd: 'Direct Debit', bank: 'Bank transfer'};
const payText = () => { const m = (prop().paymentMethods || ['dd', 'bank']).map(k => PAY[k]).filter(Boolean); return m.length ? 'Monthly by ' + m.join(' or ').replace('Bank transfer', 'bank transfer') : 'Monthly'; };
const photoList = u => (u.photos && u.photos.length ? u.photos : ['Photo']).map(p => typeof p === 'string' ? {caption: p, src: ''} : {caption: p.caption || '', src: p.src || ''});
const ph = (p, cls = '', sub = 'Photo coming soon') => {
  if (typeof p === 'string') p = {caption: p, src: ''};
  return p.src
    ? `<div class="ph has-img ${cls}"><img src="${esc(p.src)}" alt="${esc(p.caption)}" loading="lazy"></div>`
    : `<div class="ph ${cls}" role="img" aria-label="Placeholder for photo: ${esc(p.caption)}"><span><b>${esc(p.caption)}</b>${sub ? esc(sub) : ''}</span></div>`;
};
const exampleChip = r =>r && r.example ? ' <span class="chip">Example</span>' : '';

/* ---------- server ---------- */
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {method, headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin'});
  } catch (e) { throw {code: 'network', message: 'Could not reach the server. Check your connection and try again.'}; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw {code: res.status, message: data.error || 'Something went wrong. Try again.'};
  return data;
}
function dbErr(e) {
  if (e && e.code === 'form') return 'Add a rent amount or an extra line to the invoice.';
  if (e && e.code === 401) { setTimeout(() => location.reload(), 1500); return 'You have been signed out. Sign in again to save changes.'; }
  return (e && e.message) || 'Could not save. Check your connection and try again.';
}
const plain = o => JSON.parse(JSON.stringify(o));
async function put(col, obj) {
  const {id, ...data} = obj;
  try { await api('PUT', `/api/admin/${col}/${encodeURIComponent(id)}`, plain(data)); }
  catch (e) { toast(dbErr(e)); throw e; }
  const arr = S[col], i = arr.findIndex(x => x.id === obj.id);
  if (i >= 0) arr[i] = obj; else arr.push(obj);
  render();
}
async function del(col, id) {
  try { await api('DELETE', `/api/admin/${col}/${encodeURIComponent(id)}`); }
  catch (e) { toast(dbErr(e)); throw e; }
  S[col] = S[col].filter(x => x.id !== id);
  if (col === 'tenants') access = access.filter(a => a.tenantId !== id);
  render();
}
async function putDoc(key, data) {
  try { await api('PUT', `/api/admin/settings/${key}`, plain(data)); }
  catch (e) { toast(dbErr(e)); throw e; }
  S[key] = data; render();
}

/* ---------- toast & modal ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3600); }
function openSheet(html) { $('#sheet').innerHTML = html; $('#modal').hidden = false; const f = $('#sheet').querySelector('input,select,textarea,button.primary'); if (f) f.focus(); }
function closeModal() { $('#modal').hidden = true; $('#sheet').innerHTML = ''; $('#sheet').classList.remove('wide'); }
function fieldHTML(f) {
  const id = 'f-' + f.id, v = f.value ?? '';
  if (f.type === 'checkbox') return `<label class="check ${f.full ? 'full' : ''}"><input type="checkbox" id="${id}"${v ? ' checked' : ''}><span>${esc(f.label)}</span></label>`;
  let ctl;
  if (f.type === 'textarea') ctl = `<textarea id="${id}" rows="${f.rows || 4}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}>${esc(v)}</textarea>`;
  else if (f.type === 'select') ctl = `<select id="${id}">${f.options.map(o => `<option value="${esc(o[0])}"${String(o[0]) === String(v) ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
  else ctl = `<input id="${id}" type="${f.type || 'text'}" value="${esc(v)}"${f.step ? ` step="${f.step}"` : ''}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}>`;
  return `<label class="field ${f.full ? 'full' : ''}"><span>${esc(f.label)}${f.required ? ' *' : ''}</span>${ctl}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`;
}
function openForm({title, intro, fields, submit, onSubmit}) {
  openSheet(`<form id="mform" novalidate>
    <header><h2>${esc(title)}</h2><button type="button" class="x" data-act="close" aria-label="Close">×</button></header>
    ${intro ? `<p class="muted">${intro}</p>` : ''}
    <div class="fields">${fields.map(fieldHTML).join('')}</div>
    <p class="form-err" id="form-err" hidden></p>
    <footer><button type="button" class="btn ghost" data-act="close">Cancel</button><button type="submit" class="btn primary">${esc(submit)}</button></footer>
  </form>`);
  $('#mform').addEventListener('submit', async e => {
    e.preventDefault();
    const v = {}, err = $('#form-err');
    for (const f of fields) {
      const el = document.getElementById('f-' + f.id);
      v[f.id] = f.type === 'checkbox' ? el.checked : f.type === 'number' ? (el.value === '' ? null : Number(el.value)) : f.type === 'password' ? el.value : el.value.trim();
      if (f.required && (v[f.id] === '' || v[f.id] === null)) { err.textContent = `Add ${f.label.toLowerCase()} to continue.`; err.hidden = false; el.focus(); return; }
      if (f.type === 'email' && v[f.id] && !/^\S+@\S+\.\S+$/.test(v[f.id])) { err.textContent = 'Enter a full email address, like name@business.co.uk.'; err.hidden = false; el.focus(); return; }
    }
    const btn = e.submitter || $('#mform button[type=submit]'); btn.disabled = true;
    try { const keep = await onSubmit(v); if (!keep) closeModal(); }
    catch (x) { btn.disabled = false; err.textContent = dbErr(x); err.hidden = false; }
  });
}
let pendingConfirm = null;
function confirmBox(title, text, label, fn) {
  pendingConfirm = fn;
  openSheet(`<header><h2>${esc(title)}</h2><button type="button" class="x" data-act="close" aria-label="Close">×</button></header>
    <p>${text}</p>
    <footer><button type="button" class="btn ghost" data-act="close">Cancel</button><button type="button" class="btn primary" data-act="confirm-yes">${esc(label)}</button></footer>`);
}
function copyText(text) {
  const done = () => toast('Copied');
  try {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text));
  } catch (e) { fallbackCopy(text); }
}
function fallbackCopy(text) {
  openSheet(`<header><h2>Copy</h2><button type="button" class="x" data-act="close" aria-label="Close">×</button></header>
    <p class="muted">Select the text below and copy it.</p><textarea id="copy-area" rows="8" style="width:100%;font:13px var(--f-mono);padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--surface)">${esc(text)}</textarea>`);
  const a = $('#copy-area'); a.focus(); a.select();
}

/* ---------- site plan ---------- */
/* Ground floor drawn from "TheOldMill Unit Layout": Mill Lane runs down the left and along the front. */
const PLAN = {
  '4': {pts:'32,40 282,40 282,177 90,177', lx:150, ly:100},
  '3': {pts:'90,177 268,177 268,283 135,283', lx:168, ly:228},
  '1a': {pts:'135,283 232,283 232,399 178,399', lx:160, ly:330, small:true},
  '2': {pts:'313,330 400,330 400,399 313,399', lx:326, ly:362, small:true},
  '5': {pts:'292,95 468,95 468,283 414,283 414,215 292,215', lx:350, ly:160},
  '6': {pts:'400,330 588,330 588,399 400,399', lx:470, ly:362, small:true},
  '7': {pts:'594,90 760,90 760,390 695,390 695,180 594,180', lx:612, ly:128},
  '5a': {pts:'295,218 351,218 351,281 295,281', lx:305, ly:256, tiny:true},
  '5b': {pts:'355,218 411,218 411,281 355,281', lx:365, ly:256, tiny:true},
  'g1': {pts:'469,93 527,93 527,177 469,177', lx:480, ly:142, tiny:true},
  'g2': {pts:'531,93 590,93 590,177 531,177', lx:542, ly:142, tiny:true},
  '1b': {pts:'815,150 893,150 893,220 815,220', lx:822, ly:178, small:true},
  '1c': {pts:'897,150 980,150 980,220 897,220', lx:904, ly:178, small:true},
  '1d': {pts:'815,50 980,50 980,120 815,120', lx:826, ly:80, small:true}
};
function planSVG(list) {
  const fill = s => s === 'available' ? 'var(--accent)' : s === 'soon' ? 'var(--brass)' : 'var(--let)';
  const ink = s => s === 'let' ? 'var(--ink)' : 'var(--accent-ink)';
  const blocks = list.filter(u => PLAN[u.id]).map(u => {
    const p = PLAN[u.id];
    return `<g class="blk" data-act="unit" data-id="${esc(u.id)}" tabindex="0" role="button" aria-label="${esc(u.name)}, ${STATUS[u.status] || ''}">
      <polygon points="${p.pts}" fill="${fill(u.status)}"></polygon>
      ${(() => {
        const words = u.shortName ? u.shortName.split(' ') : [u.code];
        const fs = u.shortName ? (p.small ? 15 : 20) : (p.tiny ? 19 : p.small ? 22 : 30), lh = fs + 2;
        const top = p.ly - (words.length - 1) * lh / 2;
        const name = words.map((w, i) => `<text x="${p.lx}" y="${top + i * lh}" font-size="${fs}" font-weight="800" fill="${ink(u.status)}">${esc(w)}</text>`).join('');
        const statusY = top + (words.length - 1) * lh + (p.small ? 18 : 22);
        return name + (p.tiny ? '' : `<text x="${p.lx}" y="${statusY}" font-size="${p.small ? 10 : 13}" font-weight="700" fill="${ink(u.status)}" letter-spacing=".5">${esc((STATUS[u.status] || '').toUpperCase())}</text>`);
      })()}
    </g>`;
  }).join('');
  const arrow = (x, y1, y2) => `<path d="M${x} ${y1} L${x} ${y2} M${x - 7} ${y2 + 9} L${x} ${y2} L${x + 7} ${y2 + 9}" stroke="var(--ink)" stroke-width="2.5" fill="none" stroke-linecap="round"></path>`;
  return `<svg class="plan" viewBox="0 0 1000 480" role="img" aria-label="Site plan of The Old Mill on Mill Lane, showing each unit, how it is reached and whether it is available">
    <rect x="232" y="283" width="168" height="47" fill="var(--let-soft)"></rect>
    <rect x="232" y="330" width="81" height="69" fill="var(--let-soft)"></rect>
    <text x="242" y="302" font-size="12" fill="var(--muted)" font-weight="800" letter-spacing=".5">ENTRANCE HALL</text>
    <text x="242" y="318" font-size="11" fill="var(--muted)" font-weight="600">Kitchen · toilets</text>
    <rect x="598" y="186" width="91" height="196" rx="6" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="5 4"></rect>
    <text x="643" y="300" font-size="13" fill="var(--muted)" font-weight="700" text-anchor="middle">YARD</text>
    ${blocks}
    <line x1="53" y1="88" x2="72" y2="131" stroke="var(--brass)" stroke-width="7" stroke-linecap="round"></line>
    <line x1="104" y1="210" x2="121" y2="250" stroke="var(--brass)" stroke-width="7" stroke-linecap="round"></line>
    <line x1="592" y1="392" x2="692" y2="392" stroke="var(--ink)" stroke-width="3" stroke-dasharray="2 5" stroke-linecap="round"></line>
    <path d="M14 30 L160 410 Q172 438 210 438 L770 438" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="7 6"></path>
    <text x="34" y="300" font-size="15" fill="var(--muted)" font-weight="800" letter-spacing="4" transform="rotate(68 34 300)">MILL LANE</text>
    <text x="470" y="466" font-size="15" fill="var(--muted)" font-weight="800" letter-spacing="4" text-anchor="middle">MILL LANE</text>
    ${arrow(272, 432, 404)}<text x="282" y="428" font-size="12" fill="var(--ink)" font-weight="700">Main entrance</text>
    ${arrow(494, 432, 404)}<text x="504" y="428" font-size="12" fill="var(--ink)" font-weight="700">Unit 6</text>
    ${arrow(643, 432, 400)}<text x="653" y="428" font-size="12" fill="var(--ink)" font-weight="700">Yard gates</text>
    ${arrow(643, 236, 186)}<text x="643" y="254" font-size="11" fill="var(--ink)" font-weight="700" text-anchor="middle">Way in</text>
    <text x="815" y="22" font-size="13" fill="var(--muted)" font-weight="800" letter-spacing="1">MILL ROOMS · UPSTAIRS</text>
    <text x="815" y="44" font-size="12" fill="var(--muted)" font-weight="600">Second floor (with storage)</text>
    <text x="815" y="144" font-size="12" fill="var(--muted)" font-weight="600">First floor</text>
    <text x="815" y="244" font-size="12" fill="var(--muted)" font-weight="600">Ground floor: on the main plan</text>
    <line x1="815" y1="286" x2="840" y2="286" stroke="var(--brass)" stroke-width="7" stroke-linecap="round"></line>
    <text x="850" y="290" font-size="12" fill="var(--ink)" font-weight="600">Loading doors to Mill Lane</text>
    <path d="M827 324 L827 304 M820 313 L827 304 L834 313" stroke="var(--ink)" stroke-width="2.5" fill="none" stroke-linecap="round"></path>
    <text x="850" y="318" font-size="12" fill="var(--ink)" font-weight="600">Way in</text>
    <line x1="815" y1="344" x2="840" y2="344" stroke="var(--ink)" stroke-width="3" stroke-dasharray="2 5" stroke-linecap="round"></line>
    <text x="850" y="348" font-size="12" fill="var(--ink)" font-weight="600">Metal gates to the yard</text>
    <text x="815" y="380" font-size="12" fill="var(--muted)" font-weight="600">G1, G2: Garages 1 and 2</text>
    <text x="815" y="400" font-size="12" fill="var(--muted)" font-weight="600">5A, 5B: small rooms</text>
  </svg>`;
}

const ZOOMS = [1, 1.5, 2, 3];
let mapZoom = 1;
function openMap() {
  openSheet(`<header><h2>Site plan</h2><div class="row" style="gap:6px">
      <button type="button" class="btn sm" data-act="map-zoom" data-d="-1" aria-label="Zoom out">−</button>
      <span id="zoom-label" class="num" style="min-width:44px;text-align:center;font-weight:700">Fit</span>
      <button type="button" class="btn sm" data-act="map-zoom" data-d="1" aria-label="Zoom in">+</button>
      <button type="button" class="x" data-act="close" aria-label="Close">×</button></div></header>
    <div class="mapzoom" id="mapzoom">${planSVG(units())}</div>
    <div class="row" style="justify-content:space-between"><span class="row" style="gap:14px;font-size:13px;color:var(--muted)"><span class="key"><i style="background:var(--accent)"></i>Available</span><span class="key"><i style="background:var(--brass)"></i>Coming soon</span><span class="key"><i style="background:var(--let)"></i>Let</span></span><span class="muted" style="font-size:13px">Zoom in and scroll to look around. Select a unit to open its page.</span></div>`);
  $('#sheet').classList.add('wide');
  setMapZoom(0);
}
function setMapZoom(i) {
  mapZoom = Math.max(0, Math.min(ZOOMS.length - 1, i));
  const svg = document.querySelector('#mapzoom svg'), z = ZOOMS[mapZoom];
  if (!svg) return;
  svg.style.width = (z * 100) + '%';
  $('#zoom-label').textContent = z === 1 ? 'Fit' : Math.round(z * 100) + '%';
}

/* ---------- website ---------- */
function unitCard(u) {
  const btn = u.status === 'available'
    ? `<button class="btn primary" data-act="enquire" data-unit="${esc(u.id)}">Request this space</button>`
    : `<button class="btn" data-act="enquire" data-unit="${esc(u.id)}" data-wait="1">Notify me when available</button>`;
  const priceHTML = u.status === 'let' ? '<span class="muted">Currently let</span>' : `<span><b>${u.rent ? gbp(priceFor(u, priceTier)) : 'Rent on request'}</b>${u.rent ? ' / month' : ''}${usesLocal(u) ? ` <span class="pill s-${priceTier === 'kineton' ? 'paid' : 'let'}" style="margin-left:4px">${RATE_LABEL[priceTier]}</span>` : ''}</span>`;
  const tiersHTML = '';
  return `<article class="ucard">
    ${ph(photoList(u)[0], '', '')}
    <div class="ucard-top"><div><div class="ucode"${u.shortName ? ' style="font-size:30px;line-height:1"' : ''}>${esc(u.shortName || u.code)}</div><div class="utype">${esc(u.type)}</div></div><span class="pill s-${esc(u.status)}">${STATUS[u.status] || esc(u.status)}</span></div>
    <div class="facts num"><span><b>${u.size ? Number(u.size).toLocaleString('en-GB') + ' sq ft' : 'Size on request'}</b></span>${priceHTML}</div>
    ${tiersHTML}
    ${reduced(u) ? `<div class="row" style="gap:8px;font-size:13.5px"><span class="pill s-soon">Reduced</span><span>Was <s>${gbp(priceFor({...u, rent: u.wasRent}, priceTier))}</s>, now <b>${gbp(priceFor(u, priceTier))}</b></span></div>` : ''}
    <div class="muted num" style="font-size:13.5px">${u.status === 'let' ? (u.serviceCharge === 'included' ? 'Service charge included' : u.serviceCharge === 'extra' ? 'Service charge extra' : 'No service charge') : esc(scLine(u))} · ${u.inclusive ? 'Bills included' : 'Bills paid by tenant'}</div>
    <div class="muted" style="font-size:13px">Deposit ${depositText(u)} · ${TERMS[termOf(u)].short}</div>
    ${u.status === 'soon' && u.availableFrom ? `<div style="font-size:13.5px">Available from <b>${fmtDate(u.availableFrom)}</b></div>` : ''}
    <div class="row"><button class="btn ghost sm" data-act="unit" data-id="${esc(u.id)}">View details</button>${btn}</div>
  </article>`;
}
function floorPlan(u) {
  const W = Number(u.widthM), D = Number(u.depthM);
  if (!W || !D) return '<div class="empty">Layout and measurements to follow.</div>';
  const VB = 540, padL = 60, padR = 24, top = 44, maxH = 300;
  const s = Math.min((VB - padL - padR) / W, maxH / D), w = W * s, h = D * s;
  const x0 = padL + ((VB - padL - padR) - w) / 2, y0 = top, vbH = top + h + 72;
  const roller = /roller|shutter/i.test(u.doorType || '');
  const dw = Math.min((Number(u.doorWidthM) || 0.9) * s, w - 20), dx = x0 + (w - dw) / 2, yb = y0 + h;
  const f1 = n => (Math.round(n * 100) / 100).toString();
  const door = roller
    ? `<rect x="${dx}" y="${yb - 5}" width="${dw}" height="10" fill="var(--surface)"></rect><line x1="${dx}" y1="${yb}" x2="${dx + dw}" y2="${yb}" stroke="var(--brass)" stroke-width="3" stroke-dasharray="6 4"></line>`
    : `<rect x="${dx}" y="${yb - 5}" width="${dw}" height="10" fill="var(--surface)"></rect><path d="M${dx} ${yb} L${dx} ${yb - dw} A${dw} ${dw} 0 0 1 ${dx + dw} ${yb}" fill="none" stroke="var(--brass)" stroke-width="1.5"></path>`;
  const tick = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--muted)" stroke-width="1.2"></line>`;
  return `<div class="fp"><svg viewBox="0 0 ${VB} ${vbH}" role="img" aria-label="Floor plan of ${esc(u.name)}: ${f1(W)} metres wide by ${f1(D)} metres deep">
    ${tick(x0, y0 - 22, x0 + w, y0 - 22)}${tick(x0, y0 - 28, x0, y0 - 16)}${tick(x0 + w, y0 - 28, x0 + w, y0 - 16)}
    <rect x="${x0 + w / 2 - 34}" y="${y0 - 33}" width="68" height="20" fill="var(--surface)"></rect>
    <text x="${x0 + w / 2}" y="${y0 - 18}" font-size="14" text-anchor="middle" fill="var(--ink)">${f1(W)} m</text>
    ${tick(x0 - 24, y0, x0 - 24, yb)}${tick(x0 - 30, y0, x0 - 18, y0)}${tick(x0 - 30, yb, x0 - 18, yb)}
    <g transform="translate(${x0 - 24} ${y0 + h / 2}) rotate(-90)"><rect x="-34" y="-10" width="68" height="20" fill="var(--surface)"></rect><text x="0" y="5" font-size="14" text-anchor="middle" fill="var(--ink)">${f1(D)} m</text></g>
    <rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="var(--accent-soft)" stroke="var(--ink)" stroke-width="6"></rect>
    ${door}
    <text x="${x0 + w / 2}" y="${y0 + h / 2 - 4}" font-size="${Math.max(13, Math.min(22, w / 9))}" text-anchor="middle" fill="var(--ink)" font-weight="500">${f1(W * D)} m²</text>
    <text x="${x0 + w / 2}" y="${y0 + h / 2 + 16}" font-size="12" text-anchor="middle" fill="var(--muted)">${Math.round(W * D / 0.092903).toLocaleString('en-GB')} sq ft</text>
    <text x="${x0 + w / 2}" y="${yb + 30}" font-size="12.5" text-anchor="middle" fill="var(--muted)">${esc(u.doorType || 'Door')}${u.doorWidthM ? ' ' + f1(u.doorWidthM) + ' m wide' : ''}${u.doorHeightM ? ' × ' + f1(u.doorHeightM) + ' m high' : ''}</text>
    <text x="${VB - padR}" y="${vbH - 10}" font-size="11" text-anchor="end" fill="var(--muted)">Internal measurements · not to scale</text>
  </svg></div>`;
}
// Spaces over more than one floor: one plan per floor, rooms side by side, all at the same scale.
const roomArea = r => Math.round(Number(r.w) * Number(r.d) * 10) / 10;
const floorsOf = u => (Array.isArray(u.floors) ? u.floors.filter(f => f.rooms && f.rooms.length) : []);
function floorsPlan(u) {
  const F = floorsOf(u), VB = 540, gap = 6, pad = 12;
  const widest = Math.max(...F.map(f => f.rooms.reduce((s, r) => s + Number(r.w), 0) + (f.rooms.length - 1) * 0.3));
  const deepest = Math.max(...F.flatMap(f => f.rooms.map(r => Number(r.d))));
  const sc = Math.min((VB - pad * 2) / widest, 220 / deepest);
  const f1 = n => (Math.round(n * 100) / 100).toString();
  return F.map(f => {
    let x = pad; const h = Math.max(...f.rooms.map(r => Number(r.d))) * sc;
    const rects = f.rooms.map(r => {
      const w = Number(r.w) * sc, d = Number(r.d) * sc, out = `<rect x="${x}" y="${pad}" width="${w}" height="${d}" fill="var(--accent-soft)" stroke="var(--ink)" stroke-width="4"></rect>
        <text x="${x + w / 2}" y="${pad + d / 2 - 6}" font-size="${Math.max(11, Math.min(15, w / 6))}" text-anchor="middle" fill="var(--ink)" font-weight="600">${esc(r.name)}</text>
        <text x="${x + w / 2}" y="${pad + d / 2 + 12}" font-size="${Math.max(10, Math.min(13, w / 7))}" text-anchor="middle" fill="var(--muted)">${f1(r.w)} × ${f1(r.d)} m · ${roomArea(r)} m²</text>${r.note ? `
        <text x="${x + w / 2}" y="${pad + d / 2 + 32}" font-size="${Math.max(10, Math.min(13, w / 7))}" text-anchor="middle" fill="var(--brass)" font-weight="700">${esc(r.note)}</text>` : ''}`;
      x += w + gap; return out;
    }).join('');
    return `<div class="fp"><p class="eyebrow" style="margin:4px 4px 6px">${esc(f.label)}</p><svg viewBox="0 0 ${VB} ${h + pad * 2}" role="img" aria-label="${esc(f.label)} plan: ${f.rooms.map(r => `${esc(r.name)} ${f1(r.w)} by ${f1(r.d)} metres`).join(', ')}">${rects}</svg></div>`;
  }).join('') + '<p class="muted" style="font-size:11px;text-align:right">Internal measurements · not to scale</p>';
}
const floorsToText = u => floorsOf(u).flatMap(f => f.rooms.map(r => `${f.label} | ${r.name} | ${r.w} | ${r.d}${r.note ? ' | ' + r.note : ''}`)).join('\n');
function textToFloors(t) {
  const floors = [];
  t.split('\n').map(l => l.split('|').map(x => x.trim())).filter(p => p.length >= 4 && Number(p[2]) > 0 && Number(p[3]) > 0).forEach(([label, name, w, d, note]) => {
    let f = floors.find(x => x.label === label); if (!f) floors.push(f = {label, rooms: []});
    f.rooms.push(note ? {name, w: Number(w), d: Number(d), note} : {name, w: Number(w), d: Number(d)});
  });
  return floors;
}

function viewUnit() {
  const u = unitById(curUnit);
  if (!u) return `<div class="upage wrap"><button class="back" data-act="go-site">← All spaces</button><div class="empty">${!loaded ? 'Loading this space…' : 'That space could not be found.'}</div></div>`;
  const P = prop(), photos = photoList(u), let_ = u.status === 'let';
  if (curPhoto >= photos.length) curPhoto = 0;
  const others = units().filter(x => x.id !== u.id && x.status !== 'let').slice(0, 3);
  const cta = let_ || u.status === 'soon'
    ? `<button class="btn primary" style="justify-content:center" data-act="enquire" data-unit="${esc(u.id)}" data-wait="1">Notify me when available</button>`
    : `<button class="btn primary" style="justify-content:center" data-act="enquire" data-unit="${esc(u.id)}">Request this space</button>`;
  return `<div class="upage wrap">
    <button class="back" data-act="go-site">← All spaces</button>
    <div class="uhead"><div><p class="eyebrow">${esc(u.type)} · ${esc(P.name)}</p><h1 class="sign" style="font-size:clamp(48px,7vw,84px)">${esc(u.name)}</h1></div>
      <span class="pill s-${esc(u.status)}" style="font-size:14px">${STATUS[u.status]}${u.status === 'soon' && u.availableFrom ? ' · from ' + fmtDate(u.availableFrom) : ''}</span></div>
    <div class="ulayout">
      <div class="umain">
        <div class="gallery">
          ${ph(photos[curPhoto], 'main')}
          ${photos[curPhoto].src ? `<span class="muted" style="font-size:13px">${esc(photos[curPhoto].caption)} · ${curPhoto + 1} of ${photos.length}</span>` : ''}
          ${photos.length > 1 ? `<div class="thumbs">${photos.map((p, i) => `<button type="button" data-act="photo" data-i="${i}" aria-pressed="${i === curPhoto}" aria-label="Show photo ${i + 1}: ${esc(p.caption)}">${ph(p, '', '')}</button>`).join('')}</div>` : ''}
        </div>
        ${u.description ? `<section class="usec"><h2>About this space</h2><p style="max-width:62ch">${esc(u.description)}</p></section>` : ''}
        <section class="usec"><h2>Layout &amp; measurements</h2>
          <div class="fpwrap"${floorsOf(u).length ? ' style="grid-template-columns:1fr"' : ''}>${floorsOf(u).length ? `<div style="display:grid;gap:10px;min-width:0">${floorsPlan(u)}</div>` : floorPlan(u)}
            <table class="spec num"><tbody>
              ${floorsOf(u).length ? `${floorsOf(u).map(f => f.rooms.map(r => `<tr><td class="muted">${esc(r.name)} <span style="font-size:12.5px">(${esc(f.label.toLowerCase())})</span></td><td>${r.w} × ${r.d} m (${roomArea(r)} m²)${r.note ? `<br><span style="color:var(--brass);font-size:13px">${esc(r.note)}</span>` : ''}</td></tr>`).join('')).join('')}
              <tr><td class="muted">Total floor area</td><td>${Math.round(floorsOf(u).flatMap(f => f.rooms).reduce((s, r) => s + roomArea(r), 0) * 10) / 10} m²</td></tr>` : `<tr><td class="muted">Floor area</td><td>${sizeText(u)}</td></tr>
              <tr><td class="muted">Width × depth</td><td>${u.widthM && u.depthM ? `${u.widthM} m × ${u.depthM} m` : 'To follow'}</td></tr>`}
              <tr><td class="muted">Ceiling height</td><td>${u.ceilingM ? u.ceilingM + ' m' : 'To follow'}</td></tr>
              <tr><td class="muted">Entrance</td><td>${esc(u.access || 'To follow')}</td></tr>
              <tr><td class="muted">Doors</td><td>${esc(u.doorType || 'Door')}${u.doorWidthM ? ` ${u.doorWidthM} × ${u.doorHeightM || '?'} m` : ''}</td></tr>
              <tr><td class="muted">Building</td><td>${u.group === 'unit1' ? 'One of the Mill Rooms, in the mill building' : 'Self-contained'}</td></tr>
            </tbody></table></div>
        </section>
        <section class="usec"><h2>What's included</h2>
          <table class="spec"><tbody>
            <tr><td class="muted">Bills</td><td>${billsText(u)}</td></tr>
            <tr><td class="muted">Service charge</td><td>${scText(u, true)}</td></tr>
            <tr><td class="muted">Business rates</td><td>${ratesIncluded(u) ? 'No need to register' : 'Tenant registers with the council. Up to 100% Small Business Rate Relief if you qualify'}</td></tr>
            <tr><td class="muted">Deposit</td><td>${depositText(u)}${u.rent && u.status !== 'let' ? ` <span class="muted" style="font-size:13px">(${gbp(depositMonths(u) * Number(priceFor(u, priceTier)))}${usesLocal(u) ? ' at the ' + RATE_LABEL[priceTier].toLowerCase().replace('kineton', 'Kineton') : ''})</span>` : ''}</td></tr>
            <tr><td class="muted">Terms</td><td>${esc(TERMS[termOf(u)].long)}</td></tr>
            <tr><td class="muted">Payment</td><td>${esc(payText())}</td></tr>
          </tbody></table></section>
        ${u.info && u.info.length ? `<section class="usec"><h2>Additional information</h2><ul class="ticks">${u.info.map(x => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
      </div>
      <aside class="panel aside">
        <span class="eyebrow">${let_ ? 'Availability' : onePrice(u) ? 'Price' : 'Rent'}</span>
        ${let_ ? `<div class="price">Let</div><p class="muted">This space is let at the moment. Join the waitlist and we'll message you when it becomes available.</p>`
          : `${reduced(u) ? `<div class="row" style="gap:8px"><span class="pill s-soon">Reduced</span><span class="muted">Was <s>${gbp(priceFor({...u, rent: u.wasRent}, priceTier))}</s></span></div>` : ''}<div><span class="price">${u.rent ? gbp(priceFor(u, priceTier)) : 'On request'}</span>${u.rent ? `<span class="muted"> / month${onePrice(u) ? '' : ' rent'}</span>` : ''}</div>${usesLocal(u) ? `<div class="row" style="gap:8px"><span class="pill s-${priceTier === 'kineton' ? 'paid' : 'let'}">${RATE_LABEL[priceTier]}</span></div><p class="muted" style="font-size:12.5px">Prices depend on where your business is based. Change it at the top of the page. <button type="button" class="linkish" data-act="scroll-local">How local rates work</button></p>` : ''}<p class="muted num" style="font-size:13.5px">${u.inclusive ? (onePrice(u) ? 'Everything included: bills and service charge' : 'Everything included: rent, service charge and bills') : esc(scLine(u))}</p>`}
        <div class="list" style="font-size:14px">
          <div><span class="muted">Size</span><b>${u.size ? Number(u.size).toLocaleString('en-GB') + ' sq ft' : '—'}</b></div>
          <div><span class="muted">Service charge</span><b>${u.serviceCharge === 'included' ? 'Included' : u.serviceCharge === 'extra' ? (u.serviceChargeAmount && !let_ ? gbp(u.serviceChargeAmount) + ' (Total ' + gbp(totalRent(u)) + ')' : let_ ? 'Extra' : 'To be confirmed') : 'None'}</b></div>
          <div><span class="muted">Bills</span><b>${u.inclusive ? 'Included' : 'Tenant pays'}</b></div>
          <div><span class="muted">Deposit</span><b>${depositText(u)}</b></div>
          <div><span class="muted">Term</span><b>${TERMS[termOf(u)].short}</b></div>
          <div><span class="muted">Pay by</span><b>${esc((prop().paymentMethods || ['dd', 'bank']).map(k => PAY[k]).join(' or '))}</b></div>
        </div>
        ${cta}
        ${others.length ? `<div style="display:grid;gap:6px;margin-top:6px"><span class="eyebrow">Other spaces</span>${others.map(o => `<button class="btn ghost sm" style="justify-content:space-between" data-act="unit" data-id="${esc(o.id)}"><span>${esc(o.name)}</span><span class="muted">${STATUS[o.status]}</span></button>`).join('')}</div>` : ''}
      </aside>
    </div>
  </div>`;
}
function viewSite() {
  if (!loaded) return '<div class="dash wrap"><div class="empty">Loading…</div></div>';
  const P = prop(), U = units(), avail = U.filter(u => u.status === 'available');
  const buildings = new Set(U.map(u => u.group === 'unit1' ? 'unit1' : u.id)).size;
  const shown = U.filter(u => siteFilter === 'all' || (siteFilter === 'available' && u.status !== 'let') || (siteFilter === 'unit1' && u.group === 'unit1') || (siteFilter === 'main' && u.group !== 'unit1'));
  const f = (k, l) => `<button type="button" data-act="filter" data-f="${k}" aria-pressed="${siteFilter === k}">${l}</button>`;
  return `
  <section class="hero wrap">
    <div class="hero-copy">
      <p class="eyebrow">Rooms, workshops &amp; storage to let${P.address ? ' · ' + esc(P.address) : ''}</p>
      <h1 class="sign">${esc(P.name)}</h1>
      ${P.tagline ? `<p class="lede">${esc(P.tagline)}</p>` : ''}
      <div class="stats">
        <div><b>${avail.length}</b><span>available now</span></div>
        <div><b>${U.length}</b><span>spaces to let</span></div>
        <div><b>${U.filter(u => u.inclusive).length}</b><span>with all bills included</span></div>
      </div>
      <div class="row"><button class="btn primary" data-act="enquire">Request a space</button><button class="btn ghost" data-act="scroll" data-target="spaces">See all spaces</button></div>
    </div>
    <figure class="hero-photo"><img src="img/the-old-mill.jpg" alt="The Old Mill, a three-storey red-brick mill building with green window frames"><figcaption>The mill building${P.address ? ', ' + esc(P.address) : ''}</figcaption></figure>
  </section>

  <section class="section wrap" id="about">
    <div class="two">
      <div class="prose">
        <p class="eyebrow">Welcome</p>
        <h2 class="h2">Welcome to ${esc(P.name)}</h2>
        ${P.description.split(/\n\s*\n/).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('')}
        <div class="filters" style="margin-top:6px"><span class="muted" style="font-size:13.5px;align-self:center">Jump to</span>
          <button type="button" data-act="scroll" data-target="spaces">The spaces</button>
          <button type="button" data-act="scroll" data-target="siteplan">Site plan</button>
          <button type="button" data-act="scroll" data-target="included">Prices &amp; what's included</button>
          <button type="button" data-act="scroll" data-target="how-renting-works">How renting works</button>
        </div>
      </div>
      ${P.features.length ? `<section class="panel" style="align-self:start"><h3>At a glance</h3><ul class="ticks">${P.features.map(x => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
    </div>
  </section>

  <section class="section wrap" id="siteplan">
    <div class="two" style="align-items:center">
      <div class="prose"><p class="eyebrow">Site plan</p><h2 class="h2">Find your space</h2>
        <p>The Mill Rooms and Units 2 to 5 are reached through the main entrance on Mill Lane, into a shared entrance hall with a small kitchen and toilets. The Mill Rooms are four separate rooms over three floors, up the stairs from the hall, and each one is let on its own. Unit 6 has its own entrance at the front. The Stable Block is reached through the metal gates into the yard. Units 3 and 4 also have loading doors onto Mill Lane.</p><p>There are also two small rooms, 5A and 5B, off the hall, which work for storage or anything else your business needs, and two garages, G1 and G2.</p><p>Select any unit to see photos, measurements and prices.</p></div>
      <figure class="plan-card">${U.length ? planSVG(U) : '<div class="empty">No spaces listed yet.</div>'}
        <figcaption><span class="key"><i style="background:var(--accent)"></i>Available</span><span class="key"><i style="background:var(--brass)"></i>Coming soon</span><span class="key"><i style="background:var(--let)"></i>Let</span><span>Not to scale.</span><button type="button" class="btn sm" style="margin-left:auto" data-act="map-open">Enlarge map</button></figcaption>
      </figure>
    </div>
  </section>

  ${localPricing().enabled ? `<section class="section wrap" id="local-rates">
    <div class="two" style="align-items:center">
    <div class="prose">
      <p class="eyebrow">Local business rates</p>
      <h2 class="h2">Kineton businesses get our best rates</h2>
      <p>The prices shown on each space are our Kineton rates. We'd love The Old Mill to be full of village businesses, with people who can walk or cycle to work and keep trade local.</p>
      <p>Businesses from nearby villages and further afield are just as welcome. Each space shows their price too.</p>
    </div>
    <figure class="hero-photo"><img src="img/1st-floor-large-1.jpg" alt="A bright first floor room in the mill building, with timber beams and two windows" loading="lazy" style="aspect-ratio:3/2;object-position:50% 50%"><figcaption>Hatch, first floor</figcaption></figure>
    </div>
  </section>` : ''}

  <section class="section wrap" id="spaces">
    <div class="section-head"><h2 class="h2">The spaces</h2>
      <div class="filters">${f('all', 'All')}${f('available', 'Available or soon')}${f('unit1', 'Mill rooms')}${f('main', 'Units 2–6, Stable Block, rooms & garages')}</div></div>
    ${shown.length ? `<div class="cards">${shown.map(unitCard).join('')}</div>` : '<div class="empty">Nothing matches that filter right now. Join the waitlist and we will tell you when something frees up.</div>'}
  </section>

  <section class="section wrap" id="included">
    <div class="section-head"><h2 class="h2">What's included</h2></div>
    <div class="grid2">
      <section class="panel">
        <p class="eyebrow">Mill Rooms, Unit 2, 5A and 5B</p>
        <h3>One price, everything on</h3>
        <p>The four Mill Rooms, Unit 2 and the two small rooms 5A and 5B are let on one monthly price covering internet, electricity, water and the service charge. There are no business rates to register for in the Mill Rooms or Rooms 5A and 5B. Unit 2 tenants register for business rates themselves. Use them for whatever your business needs, from treatment rooms and therapies to crafts, studios or desk work.</p>
        <div class="incl">${INCLUDES.map(i => `<div style="background:var(--raise)"><b>${esc(i)}</b><span class="muted">Included</span></div>`).join('')}</div>
      </section>
      <section class="panel">
        <p class="eyebrow">Units 3 to 6 and the Stable Block</p>
        <h3>Priced separately</h3>
        <p>Each unit shows its rent and monthly service charge. Electricity is on your own account.</p>
        <p>You register for business rates with the local council. Small businesses can get up to 100% off through <a href="https://www.gov.uk/apply-for-business-rate-relief/small-business-rate-relief" target="_blank" rel="noopener">Small Business Rate Relief</a> if they meet the requirements.</p>
      </section>
    </div>
  </section>

  <section class="section wrap" id="how-renting-works">
    <div class="section-head"><h2 class="h2">How renting works</h2></div>
    <div class="grid2">
      <section class="panel"><h3>All-inclusive rooms</h3>
        <p class="muted" style="font-size:13.5px">Mill Rooms, Unit 2, Rooms 5A and 5B</p>
        <ul class="ticks"><li>Simple licence agreement: 3-month minimum, then monthly</li><li>1 month's notice either side</li><li>Deposit of 1 month (2 months for Hoist Loft)</li><li>One monthly payment covers bills and service charge</li></ul></section>
      <section class="panel"><h3>Workshops, warehouse and units</h3>
        <p class="muted" style="font-size:13.5px">Units 3 to 6, the Stable Block and the garages</p>
        <ul class="ticks"><li>Lease with a 12-month minimum term (1 to 3 years available)</li><li>3 months' notice after the first 12 months</li><li>Deposit of 2 months' rent</li><li>Rent plus a monthly service charge. You pay your own electricity and business rates</li></ul></section>
    </div>
    <p class="muted" style="font-size:14px;margin-top:14px">Rent is paid monthly in advance by Direct Debit or bank transfer. Viewings are by appointment. Deposits are held separately and returned within a month of leaving, once the space has been checked.</p>
  </section>

  <section class="section wrap">
    <div class="cta">
      <div class="row" style="gap:20px;flex-wrap:nowrap;min-width:0"><img class="logo" src="img/logo-440.png" alt="The Old Mill, Kineton logo">
      <div style="display:grid;gap:8px;min-width:0"><h2 class="h2">Looking for space?</h2>
        <p>Viewings by appointment. Request a space that's free now, or join the waitlist and get a message as soon as one comes up.</p>
        ${P.phone ? `<p style="opacity:1"><span style="color:var(--gold);font-weight:600">WhatsApp or call</span> <span class="mono" style="font-size:18px;user-select:all">${esc(P.phone)}</span></p>` : ''}
        ${P.email ? `<p>Email <span class="mono" style="user-select:all">${esc(P.email)}</span></p>` : ''}</div></div>
      <button class="btn gold" data-act="enquire">Request a space</button>
    </div>
  </section>
  <footer class="foot wrap">${esc(P.name)}${P.address ? ' · ' + esc(P.address) : ''} · <button type="button" class="linkish" data-view="tenant">Tenant sign in</button> · <button type="button" class="linkish" data-view="landlord">Landlord sign in</button>${isInstalled() ? '' : ' · <button type="button" class="linkish" data-act="get-app">Get the app</button>'}</footer>`;
}
function interestOptions() {
  return [['any', 'Any space'], ['unit1', 'Any Mill Room (all inclusive)'], ['large', 'Any of Units 2–6 or the Stable Block'], ...units().map(u => [u.id, `${u.name} · ${STATUS[u.status]}`])];
}
function enquireForm(unitId, wait) {
  const u = unitId ? unitById(unitId) : null;
  openForm({
    title: wait ? 'Join the waitlist' : 'Request a space',
    intro: u ? (u.status === 'available' ? `${esc(u.name)} is available now. Send a request and we'll be in touch to arrange a viewing.` : `${esc(u.name)} is ${u.status === 'soon' ? 'coming soon' : 'let at the moment'}. We'll message you as soon as it's available.`) : 'Tell us what you need. If nothing suits right now we will add you to the waitlist and message you when a space comes up.',
    fields: [
      {id:'name', label:'Your name', required:true}, {id:'business', label:'Business name'},
      {id:'email', label:'Email', type:'email', required:true}, {id:'phone', label:'Phone', type:'tel'},
      {id:'interest', label:'Space', type:'select', options: interestOptions(), value: unitId || 'any'},
      ...(localPricing().enabled ? [
        {id:'based', label:'Where is your business based?', type:'select', options: [['kineton', 'Kineton'], ['nearby', `Within ${localPricing().nearbyMiles} miles (e.g. Tysoe, Wellesbourne)`], ['further', 'Further afield (e.g. Leamington, Stratford)']], value: priceTier},
        {id:'postcode', label:'Business postcode', placeholder:'e.g. CV35 0XX'}] : []),
      {id:'start', label:'Ideal start date', type:'date'},
      {id:'message', label:'Please tell us about your business and how you plan to use the space', type:'textarea', full:true, rows:4, placeholder:'e.g. what your business does, what you would use the space for, how many people, opening hours, any access or storage needs'},
      {id:'notify', label:'Message me when a matching space becomes available', type:'checkbox', value:true, full:true}
    ],
    submit: wait ? 'Join waitlist' : 'Send request',
    onSubmit: async v => {
      const r = await api('POST', '/api/enquiries', v);
      const free = r.status === 'new';
      if (mode === 'landlord') refreshAdmin();
      openSheet(`<header><h2>${free ? 'Request sent' : "You're on the list"}</h2><button type="button" class="x" data-act="close" aria-label="Close">×</button></header>
        <p>Thanks ${esc(v.name.split(' ')[0])}. ${free ? "We'll be in touch about " + esc(interestLabel(v.interest).toLowerCase() === 'any space' ? 'available spaces' : interestLabel(v.interest)) + ' shortly.' : "Nothing that matches is free right now. We'll message " + esc(v.email) + ' as soon as it is.'}</p>
        <footer><button class="btn primary" data-act="close">Done</button></footer>`);
      return true;
    }
  });
}

/* ---------- tenant portal ---------- */
function wifiFor(u) { return (S.wifi?.networks || []).filter(n => n.appliesTo === 'all' || (u && (n.appliesTo === u.id || (n.appliesTo === 'unit1' && u.group === 'unit1')))); }
function viewTenant() {
  if (mode !== 'tenant' && mode !== 'landlord') return loginView('tenant');
  if (mode === 'tenant') curTenant = me.tenantId;
  const T = activeTenants();
  if (!T.length) return `<div class="dash wrap"><div class="empty">No tenants yet. Add one in the Landlord view and their portal will appear here.</div></div>`;
  if (!T.find(t => t.id === curTenant)) curTenant = T[0].id;
  const t = tenantById(curTenant), u = unitById(t.unitId);
  const inv = S.invoices.filter(i => i.tenantId === t.id).sort((a, b) => (b.issued || '').localeCompare(a.issued || ''));
  const msgs = S.messages.filter(m => m.to === 'all' || m.to === t.id).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const owed = inv.filter(i => i.status !== 'paid').reduce((s, i) => s + Number(i.total || 0), 0);
  const nets = wifiFor(u);
  return `<div class="dash wrap">
    ${mode === 'landlord' ? `<div class="panel" style="background:var(--brass-soft);border-color:transparent">
      <div class="row" style="justify-content:space-between">
        <p style="max-width:60ch">You're previewing the tenant portal as the landlord. Each tenant signs in and sees only their own space.</p>
        <label class="row" style="gap:8px"><span class="muted">Preview as</span>
          <select id="pick-tenant" data-act="pick-tenant" style="padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--raise)">${T.map(x => `<option value="${esc(x.id)}"${x.id === t.id ? ' selected' : ''}>${esc(x.business || x.name)} (${esc(unitById(x.unitId)?.code || '?')})</option>`).join('')}</select></label>
      </div>
    </div>` : ''}
    <div class="dash-head"><div><p class="eyebrow">${esc(prop().name)} · Tenant portal</p><h1 class="h2" style="font-size:48px">Hello, ${esc(t.name.split(' ')[0])}</h1><p class="muted">${esc(t.business)}${exampleChip(t)}</p></div>${mode === 'tenant' ? `<div class="row">${isInstalled() ? '' : '<button class="btn primary" data-act="get-app">Get the app</button>'}<button class="btn" data-act="password">Change password</button><button class="btn" data-act="logout">Sign out</button></div>` : ''}</div>
    <div class="grid2">
      <section class="panel"><h3>Your space</h3>
        <div class="list num">
          <div><span class="muted">Unit</span><b>${esc(u?.name || 'Not assigned')}</b></div>
          <div><span class="muted">${onePrice(u) ? 'Monthly price' : 'Monthly rent'}</span><b>${gbp(t.rent)}</b></div>
          <div><span class="muted">Bills</span><b>${u?.inclusive ? 'Internet, electricity & water included' : 'Paid by you'}</b></div>
          ${u ? `<div><span class="muted">Service charge</span><b>${scText(u, false)}</b></div>` : ''}
          <div><span class="muted">You pay by</span><b>${PAY[t.paymentMethod] || 'Bank transfer'}</b></div>
          <div><span class="muted">Tenancy started</span><b>${fmtDate(t.leaseStart)}</b></div>
          ${t.deposit ? `<div><span class="muted">Deposit</span><b>${gbp(t.deposit)}${t.depositReturned ? ' · returned' : t.depositReceived ? ' · held' : ''}</b></div>` : ''}
          ${u ? `<div><span class="muted">Agreement</span><b>${TERMS[termOf(u)].short}</b></div>` : ''}
        </div></section>
      <section class="panel"><h3>Wi-Fi</h3>
        ${nets.length ? nets.map(n => `<div class="wifi"><span class="eyebrow">Network</span><span class="mono">${esc(n.ssid)}</span><span class="eyebrow" style="margin-top:6px">Password</span><div class="row" style="justify-content:space-between"><span class="mono">${esc(n.password)}</span><button class="btn sm" data-act="copy-wifi" data-id="${esc(n.id)}">Copy password</button></div></div>`).join('') : '<p class="muted">No Wi-Fi details have been shared for your unit yet.</p>'}
      </section>
      <section class="panel"><div class="row" style="justify-content:space-between"><h3>Invoices</h3><span class="num">${owed ? `<b>${gbp(owed)}</b> <span class="muted">to pay</span>` : '<span class="pill s-paid">All paid</span>'}</span></div>
        ${inv.length ? `<div class="list">${inv.map(i => `<div><span><b class="mono">${esc(i.number)}</b><br><span class="muted">${esc(i.period)} · due ${fmtDate(i.due)}</span></span><span class="row num"><b>${gbp(i.total)}</b><span class="pill s-${invState(i)}">${invState(i) === 'paid' ? 'Paid' : invState(i) === 'overdue' ? 'Overdue' : 'Due'}</span><button class="btn sm" data-act="view-invoice" data-id="${esc(i.id)}">View</button></span></div>`).join('')}</div>` : '<p class="muted">No invoices yet.</p>'}
      </section>
      <section class="panel"><h3>Messages &amp; updates</h3>
        ${msgs.length ? `<div>${msgs.map(m => `<article class="msg"><header><span class="pill s-${m.kind === 'wifi' || m.kind === 'invoice' ? 'due' : m.to === 'all' ? 'contacted' : 'pending'}">${KIND[m.kind] || 'Message'}</span><span class="muted" style="font-size:13px">${fmtDate(m.createdAt)}${m.to === 'all' ? ' · to all tenants' : ''}</span></header><b>${esc(m.subject)}</b><p class="muted">${esc(m.body)}</p></article>`).join('')}</div>` : '<p class="muted">No messages yet.</p>'}
      </section>
    </div>
  </div>`;
}
function invoiceSheet(id) {
  const i = S.invoices.find(x => x.id === id); if (!i) return;
  const t = tenantById(i.tenantId), P = prop(), st = invState(i);
  openSheet(`<header><h2>Invoice</h2><button type="button" class="x" data-act="close" aria-label="Close">×</button></header>
    <div class="invoice num">
      <div class="row" style="justify-content:space-between;align-items:start">
        <div><b style="font:800 24px/1 var(--f-display);letter-spacing:-.02em">${esc(P.name)}</b><br><span class="muted">${esc(P.address)}</span></div>
        <div style="text-align:right"><span class="mono">${esc(i.number)}</span><br><span class="pill s-${st}">${st === 'paid' ? 'Paid ' + fmtDate(i.paidOn) : st === 'overdue' ? 'Overdue' : 'Due ' + fmtDate(i.due)}</span></div>
      </div>
      <div class="row" style="justify-content:space-between;align-items:start">
        <div><span class="eyebrow">Billed to</span><br>${esc(t?.business || '')}<br>${esc(t?.name || '')}</div>
        <div style="text-align:right"><span class="eyebrow">Issued</span><br>${fmtDate(i.issued)}<br><span class="muted">${esc(i.period)}</span></div>
      </div>
      <table>${(i.lines || []).map(l => `<tr><td>${esc(l.desc)}</td><td>${gbp(l.amount)}</td></tr>`).join('')}<tr class="total"><td>Total</td><td>${gbp(i.total)}</td></tr></table>
      ${i.note ? `<p>${esc(i.note)}</p>` : ''}
      ${st === 'paid' ? '' : t?.paymentMethod === 'dd'
        ? `<p><b>Paid by Direct Debit.</b> ${gbp(i.total)} will be collected on or just after ${fmtDate(i.due)}. You don't need to do anything.</p>`
        : `<p><b>Pay by bank transfer</b> by ${fmtDate(i.due)}, quoting <span class="mono">${esc(i.number)}</span> as the reference.</p>${P.bankDetails ? `<pre class="draft">${esc(P.bankDetails)}</pre>` : ''}`}
      ${P.paymentNote ? `<p class="muted">${esc(P.paymentNote)}</p>` : ''}
    </div>
    <footer><button class="btn primary" data-act="close">Close</button></footer>`);
}

/* ---------- landlord ---------- */
function viewLandlord() {
  if (mode !== 'landlord') return loginView('landlord');
  const pend = S.outbox.filter(o => o.status === 'pending').length;
  const newEnq = S.enquiries.filter(e => e.status === 'new').length;
  const tab = (k, l, n) => `<button type="button" role="tab" data-act="ltab" data-tab="${k}" aria-selected="${ltab === k}">${l}${n ? `<span class="count">${n}</span>` : ''}</button>`;
  const body = {overview: lOverview, spaces: lSpaces, enquiries: lEnquiries, tenants: lTenants, messages: lMessages, invoices: lInvoices, settings: lSettings, notify: lNotify}[ltab]();
  return `<div class="dash wrap">
    <div class="dash-head"><div><p class="eyebrow">Landlord</p><h1 class="h2" style="font-size:48px">${esc(prop().name)}</h1></div>
      <div class="row"><button class="btn" data-act="msg-new">Message tenants</button><button class="btn primary" data-act="inv-new">New invoice</button>${isInstalled() ? '' : '<button class="btn ghost" data-act="get-app">Get the app</button>'}<button class="btn ghost" data-act="password">Change password</button><button class="btn ghost" data-act="logout">Sign out</button></div></div>
    <div class="tabs" role="tablist">${tab('overview', 'Overview')}${tab('spaces', 'Spaces')}${tab('enquiries', 'Enquiries', newEnq)}${tab('tenants', 'Tenants')}${tab('invoices', 'Invoices')}${tab('messages', 'Messages')}${tab('notify', 'Waitlist alerts', pend)}${tab('settings', 'Wi-Fi & details')}</div>
    ${body}
  </div>`;
}
function lOverview() {
  const U = units(), letN = U.filter(u => u.status === 'let').length;
  const roll = activeTenants().reduce((s, t) => s + Number(t.rent || 0), 0);
  const open = S.invoices.filter(i => i.status !== 'paid'), overdue = open.filter(isOverdue);
  const wait = S.enquiries.filter(e => e.status === 'waitlist').length;
  const attention = [];
  overdue.forEach(i => attention.push([`<span class="pill s-overdue">Overdue</span> <b class="mono">${esc(i.number)}</b> · ${esc(tenantById(i.tenantId)?.business || '')} · ${gbp(i.total)}`, `<button class="btn sm" data-act="inv-paid" data-id="${esc(i.id)}">Mark paid</button>`]));
  S.enquiries.filter(e => e.status === 'new').forEach(e => attention.push([`<span class="pill s-new">New request</span> ${esc(e.name)} · ${esc(interestLabel(e.interest))}`, `<button class="btn sm" data-act="ltab" data-tab="enquiries">Review</button>`]));
  const pend = S.outbox.filter(o => o.status === 'pending').length;
  if (pend) attention.push([`<span class="pill s-pending">Waitlist</span> ${pend} availability alert${pend > 1 ? 's' : ''} ready to send`, `<button class="btn sm" data-act="ltab" data-tab="notify">Open</button>`]);
  const ph = U.filter(u => u.placeholder).length;
  if (ph) attention.push([`<span class="pill s-soon">Set up</span> ${ph} space${ph > 1 ? 's still show' : ' still shows'} example sizes and rents`, `<button class="btn sm" data-act="ltab" data-tab="spaces">Edit spaces</button>`]);
  return `<div class="kpis num">
      <div class="kpi"><small>Occupancy</small><b>${letN} / ${U.length}</b><small>spaces let</small><div class="meter"><i style="width:${U.length ? Math.round(letN / U.length * 100) : 0}%"></i></div></div>
      <div class="kpi"><small>Monthly rent roll</small><b>${gbp(roll)}</b><small>${activeTenants().length} tenants</small></div>
      <div class="kpi"><small>Unpaid invoices</small><b>${gbp(open.reduce((s, i) => s + Number(i.total || 0), 0))}</b><small>${overdue.length ? `<span style="color:var(--danger)">${overdue.length} overdue</span>` : 'none overdue'}</small></div>
      <div class="kpi"><small>Waitlist</small><b>${wait}</b><small>people waiting for a space</small></div>
    </div>
    <div class="grid2">
      <section class="panel"><h3>Needs attention</h3>${attention.length ? `<div class="list">${attention.map(a => `<div><span>${a[0]}</span>${a[1]}</div>`).join('')}</div>` : '<p class="muted">Nothing waiting on you.</p>'}</section>
      <section class="panel"><div class="row" style="justify-content:space-between"><h3>Spaces at a glance</h3><button type="button" class="btn sm" data-act="map-open">Enlarge map</button></div><div style="margin:-4px">${planSVG(U)}</div></section>
    </div>`;
}
function lSpaces() {
  const U = units();
  return `<div class="row" style="justify-content:space-between"><p class="muted" style="max-width:62ch">Change a space's status here. When you set a space to <b>Available</b>, everyone on the waitlist who wants it gets an alert ready to send.</p><button class="btn" data-act="unit-add">Add a space</button></div>
    ${U.length ? `<div class="scroll"><table class="t num"><thead><tr><th>Space</th><th>Type</th><th>Size</th><th>Rent / month</th><th>Status</th><th>Tenant</th><th></th></tr></thead><tbody>
    ${U.map(u => { const t = tenantInUnit(u.id); return `<tr>
      <td><b>${esc(u.name)}</b>${u.placeholder ? ' <span class="chip">Example figures</span>' : ''}</td>
      <td>${esc(u.type)}${u.inclusive ? '<br><span class="muted" style="font-size:12.5px">All inclusive</span>' : ''}</td>
      <td>${u.size ? Number(u.size).toLocaleString('en-GB') + ' sq ft' : '—'}</td><td>${gbp(u.rent)}</td>
      <td><select data-act="unit-status" data-id="${esc(u.id)}" aria-label="Status of ${esc(u.name)}">${Object.entries(STATUS).map(([k, l]) => `<option value="${k}"${u.status === k ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
      <td>${t ? esc(t.business || t.name) : '<span class="muted">—</span>'}</td>
      <td><div class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn sm" data-act="unit-edit" data-id="${esc(u.id)}">Edit</button><button class="btn sm ghost" data-act="unit" data-id="${esc(u.id)}">View page</button></div></td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="empty">No spaces yet. Add your first one.</div>'}`;
}
function lEnquiries() {
  const list = S.enquiries.filter(e => enqFilter === 'all' || (enqFilter === 'open' ? !['converted', 'declined'].includes(e.status) : e.status === enqFilter)).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const f = (k, l) => `<button type="button" data-act="enq-filter" data-f="${k}" aria-pressed="${enqFilter === k}">${l}</button>`;
  return `<div class="filters">${f('open', 'Open')}${f('new', 'New requests')}${f('waitlist', 'Waitlist')}${f('all', 'All')}</div>
    ${list.length ? `<div class="scroll"><table class="t"><thead><tr><th>Received</th><th>Who</th><th>Wants</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(e => `<tr>
      <td class="num">${fmtDate(e.createdAt)}</td>
      <td><b>${esc(e.name)}</b>${exampleChip(e)}<br><span class="muted" style="font-size:13px">${esc(e.business)}${e.business ? ' · ' : ''}<span class="mono">${esc(e.email)}</span>${e.phone ? ' · ' + esc(e.phone) : ''}</span>${e.message ? `<br><span style="font-size:13px">“${esc(e.message)}”</span>` : ''}</td>
      <td>${esc(interestLabel(e.interest))}${e.based ? `<br><span class="pill s-${e.based === 'kineton' ? 'paid' : e.based === 'nearby' ? 'due' : 'let'}" style="margin-top:4px">${TIERS[e.based] || esc(e.based)}</span>${e.postcode ? ` <span class="mono" style="font-size:12.5px">${esc(e.postcode)}</span>` : ''}${e.distanceMiles != null ? ` <span class="muted" style="font-size:12.5px">${esc(e.distanceMiles)} mi away</span>` : ''}${e.suggestedTier && e.suggestedTier !== e.based ? `<br><span style="font-size:12.5px;color:var(--danger)">Postcode suggests ${esc(TIERS[e.suggestedTier] || '')}</span>` : ''}` : ''}${e.start ? `<br><span class="muted" style="font-size:13px">from ${fmtDate(e.start)}</span>` : ''}${e.notify ? '<br><span class="muted" style="font-size:12.5px">Wants alerts</span>' : ''}</td>
      <td><span class="pill s-${esc(e.status)}">${ENQ[e.status] || esc(e.status)}</span></td>
      <td><div class="row" style="gap:6px;flex-wrap:nowrap">
        ${!['converted'].includes(e.status) ? `<button class="btn sm primary" data-act="enq-convert" data-id="${esc(e.id)}">Make tenant</button>` : ''}
        <select data-act="enq-status" data-id="${esc(e.id)}" aria-label="Status">${Object.entries(ENQ).map(([k, l]) => `<option value="${k}"${e.status === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn sm danger" data-act="enq-del" data-id="${esc(e.id)}" aria-label="Delete enquiry">Delete</button></div></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No enquiries here. New requests from the website will appear in this list.</div>'}`;
}
function lTenants() {
  const T = activeTenants(), past = S.tenants.filter(t => t.status === 'former');
  return `<div class="row" style="justify-content:space-between"><p class="muted">${T.length} current tenant${T.length === 1 ? '' : 's'}.</p><button class="btn primary" data-act="tenant-add">Add tenant</button></div>
    ${T.length ? `<div class="scroll"><table class="t num"><thead><tr><th>Tenant</th><th>Space</th><th>Rent</th><th>Deposit</th><th>Since</th><th>Balance</th><th>Portal</th><th></th></tr></thead><tbody>
    ${T.map(t => { const owed = S.invoices.filter(i => i.tenantId === t.id && i.status !== 'paid').reduce((s, i) => s + Number(i.total || 0), 0); const od = S.invoices.some(i => i.tenantId === t.id && isOverdue(i)); return `<tr>
      <td><b>${esc(t.business || t.name)}</b>${exampleChip(t)}<br><span class="muted" style="font-size:13px">${esc(t.name)} · <span class="mono">${esc(t.email)}</span></span></td>
      <td>${esc(unitById(t.unitId)?.name || '—')}</td><td>${gbp(t.rent)}<br><span class="muted" style="font-size:12.5px">${PAY[t.paymentMethod] || 'Bank transfer'}</span></td><td>${t.deposit ? gbp(t.deposit) : '—'}<br><span class="muted" style="font-size:12.5px">${t.depositReturned ? 'Returned ' + fmtDate(t.depositReturned) : t.depositReceived ? 'Held since ' + fmtDate(t.depositReceived) : t.deposit ? 'Not received yet' : ''}</span></td><td>${fmtDate(t.leaseStart)}</td>
      <td>${owed ? `<span class="pill s-${od ? 'overdue' : 'due'}">${gbp(owed)} ${od ? 'overdue' : 'due'}</span>` : '<span class="pill s-paid">Paid up</span>'}</td>
      <td>${portalCell(t)}</td>
      <td><div class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn sm" data-act="msg-new" data-to="${esc(t.id)}">Message</button><button class="btn sm" data-act="inv-new" data-tenant="${esc(t.id)}">Invoice</button><button class="btn sm" data-act="tenant-edit" data-id="${esc(t.id)}">Edit</button><button class="btn sm danger" data-act="tenant-end" data-id="${esc(t.id)}">End tenancy</button></div></td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="empty">No tenants yet. Add one, or turn an enquiry into a tenant.</div>'}
    ${past.length ? `<details><summary class="muted" style="cursor:pointer">Former tenants (${past.length})</summary><div class="list" style="margin-top:8px">${past.map(t => `<div><span>${esc(t.business || t.name)} · ${esc(unitById(t.unitId)?.name || '')}</span><button class="btn sm danger" data-act="tenant-del" data-id="${esc(t.id)}">Delete record</button></div>`).join('')}</div></details>` : ''}`;
}
function lInvoices() {
  const list = [...S.invoices].sort((a, b) => (b.issued || '').localeCompare(a.issued || '') || (b.number || '').localeCompare(a.number || ''));
  return `<div class="row" style="justify-content:space-between"><p class="muted" style="max-width:60ch">Invoices appear in each tenant's portal as soon as you create them.</p><div class="row"><button class="btn" data-act="inv-run">Raise ${esc(monthLabel())} rent for everyone</button><button class="btn primary" data-act="inv-new">New invoice</button></div></div>
    ${list.length ? `<div class="scroll"><table class="t num"><thead><tr><th>Number</th><th>Tenant</th><th>Period</th><th>Total</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(i => { const st = invState(i); return `<tr><td class="mono">${esc(i.number)}${exampleChip(i)}</td><td>${esc(tenantById(i.tenantId)?.business || 'Unknown tenant')}</td><td>${esc(i.period)}</td><td><b>${gbp(i.total)}</b></td><td>${fmtDate(i.due)}</td>
      <td><span class="pill s-${st}">${st === 'paid' ? 'Paid' : st === 'overdue' ? 'Overdue' : 'Due'}</span></td>
      <td><div class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn sm" data-act="view-invoice" data-id="${esc(i.id)}">View</button>${st !== 'paid' ? `<button class="btn sm primary" data-act="inv-paid" data-id="${esc(i.id)}">Mark paid</button>` : `<button class="btn sm" data-act="inv-unpaid" data-id="${esc(i.id)}">Mark unpaid</button>`}<button class="btn sm danger" data-act="inv-del" data-id="${esc(i.id)}">Delete</button></div></td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="empty">No invoices yet.</div>'}`;
}
function lMessages() {
  const list = [...S.messages].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return `<div class="row" style="justify-content:space-between"><p class="muted" style="max-width:60ch">Messages appear in tenants' portals. Send one to everyone, or to a single tenant.</p><button class="btn primary" data-act="msg-new">New message</button></div>
    <section class="panel">${list.length ? list.map(m => `<article class="msg"><header><span class="pill s-${m.to === 'all' ? 'contacted' : 'pending'}">${m.to === 'all' ? 'All tenants' : esc(tenantById(m.to)?.business || 'Tenant')}</span><span class="muted" style="font-size:13px">${KIND[m.kind] || 'Message'} · ${fmtDate(m.createdAt)}</span>${exampleChip(m)}<button class="btn sm danger" style="margin-left:auto" data-act="msg-del" data-id="${esc(m.id)}">Delete</button></header><b>${esc(m.subject)}</b><p class="muted">${esc(m.body)}</p></article>`).join('') : '<p class="muted">No messages sent yet.</p>'}</section>`;
}
function lNotify() {
  const list = [...S.outbox].sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  return `<p class="muted" style="max-width:68ch">When a space becomes available, an email is drafted here for everyone on the waitlist who asked about it. In this version, copy each one into your email and mark it sent. The full version would send them automatically.</p>
    ${list.length ? `<div class="grid2">${list.map(o => `<section class="panel"><div class="row" style="justify-content:space-between"><span><b>${esc(o.name)}</b><br><span class="mono muted">${esc(o.to)}</span></span><span class="pill s-${o.status}">${o.status === 'pending' ? 'Ready to send' : 'Sent'}</span></div>
      <pre class="draft">Subject: ${esc(o.subject)}\n\n${esc(o.body)}</pre>
      <div class="row"><button class="btn sm" data-act="out-copy" data-id="${esc(o.id)}">Copy email</button>${o.status === 'pending' ? `<button class="btn sm primary" data-act="out-sent" data-id="${esc(o.id)}">Mark sent</button>` : ''}<button class="btn sm danger" data-act="out-del" data-id="${esc(o.id)}">Delete</button></div></section>`).join('')}</div>` : '<div class="empty">No alerts yet. Set a space to Available on the Spaces tab and alerts for matching waitlist entries will appear here.</div>'}`;
}
function lSettings() {
  const P = prop(), nets = S.wifi?.networks || [];
  const applies = a => a === 'all' ? 'Everyone' : a === 'unit1' ? 'Mill Rooms' : (unitById(a)?.name || a);
  return `<div class="grid2">
    <section class="panel"><div class="row" style="justify-content:space-between"><h3>Wi-Fi networks</h3><button class="btn sm" data-act="wifi-add">Add network</button></div>
      <p class="muted" style="font-size:13.5px">Tenants see the networks for their space in their portal. Update a password here and it changes for them straight away.</p>
      ${nets.length ? `<div class="list">${nets.map(n => `<div><span><b class="mono">${esc(n.ssid)}</b><br><span class="muted" style="font-size:13px">${esc(applies(n.appliesTo))} · <span class="mono">${esc(n.password)}</span></span></span><span class="row" style="gap:6px"><button class="btn sm" data-act="wifi-edit" data-id="${esc(n.id)}">Edit</button><button class="btn sm danger" data-act="wifi-del" data-id="${esc(n.id)}">Remove</button></span></div>`).join('')}</div>` : '<p class="muted">No networks yet.</p>'}
      ${nets.length ? '<button class="btn" data-act="wifi-send">Tell tenants the Wi-Fi has changed</button>' : ''}
    </section>
    <section class="panel"><div class="row" style="justify-content:space-between"><h3>Property details</h3><button class="btn sm" data-act="prop-edit">Edit</button></div>
      <div class="list">
        <div><span class="muted">Name</span><b>${esc(P.name)}</b></div>
        <div><span class="muted">Address</span><span>${P.address ? esc(P.address) : '<span class="chip">Not set</span>'}</span></div>
        <div><span class="muted">Contact email</span><span class="mono">${P.email ? esc(P.email) : '<span class="chip">Not set</span>'}</span></div>
        <div><span class="muted">Phone</span><span>${P.phone ? esc(P.phone) : '<span class="chip">Not set</span>'}</span></div>
        <div><span class="muted">Extra note on invoices</span><span style="max-width:36ch;text-align:right">${esc(P.paymentNote) || '—'}</span></div>
      </div></section>
    <section class="panel"><div class="row" style="justify-content:space-between"><h3>Local business rates</h3><button class="btn sm" data-act="lp-edit">Edit</button></div>
      ${(() => { const L = localPricing(); return `<div class="list num">
        <div><span class="muted">Status</span><b>${L.enabled ? 'On' : 'Off'}</b></div>
        <div><span class="muted">Kineton businesses</span><b>Listed rent</b></div>
        <div><span class="muted">Within ${esc(L.nearbyMiles)} miles</span><b>${L.mode === 'percent' ? '+' + esc(L.nearbyPct) + '%' : '+' + gbp(L.nearbyExtra)}</b></div>
        <div><span class="muted">Further afield</span><b>${L.mode === 'percent' ? '+' + esc(L.furtherPct) + '%' : '+' + gbp(L.furtherExtra)}</b></div>
        ${L.mode === 'percent' && Number(L.roundTo) ? `<div><span class="muted">Prices rounded to</span><b>nearest ${gbp(L.roundTo)}</b></div>` : ''}
      </div><p class="muted" style="font-size:13.5px">Each space's listed rent is its Kineton rate. Switch it off for a single space in Spaces → Edit.</p>`; })()}
    </section>
    <section class="panel"><div class="row" style="justify-content:space-between"><h3>Payment options</h3><button class="btn sm" data-act="prop-edit">Edit</button></div>
      <div class="list">
        <div><span class="muted">Offered to tenants</span><b>${esc((P.paymentMethods || []).map(k => PAY[k]).join(' and ') || 'None set')}</b></div>
        <div><span class="muted">Tenants on Direct Debit</span><b class="num">${activeTenants().filter(t => t.paymentMethod === 'dd').length} of ${activeTenants().length}</b></div>
        <div style="align-items:start"><span class="muted">Bank details on invoices</span><span class="mono" style="white-space:pre-line;text-align:right">${P.bankDetails ? esc(P.bankDetails) : '<span class="chip">Not set</span>'}</span></div>
      </div>
      <p class="muted" style="font-size:13.5px">Direct Debit invoices tell the tenant the money will be collected. Bank transfer invoices show your bank details. Collecting Direct Debits automatically needs a provider such as GoCardless, which comes with the full version.</p>
    </section>
  </div>`;
}

/* ---------- landlord actions ---------- */
function unitForm(u) {
  const isNew = !u; u = u || {id:'', code:'', group:'main', type:'Commercial unit', inclusive:false, status:'available', order: S.units.length + 1};
  openForm({
    title: isNew ? 'Add a space' : 'Edit ' + u.name,
    fields: [
      {id:'code', label:'Short code (as on the plan)', value:u.code, required:true, placeholder:'e.g. 3'},
      {id:'group', label:'Building', type:'select', options:[['unit1', 'Mill Rooms'], ['main', 'Units 2–6, Stable Block, rooms and garages']], value:u.group},
      {id:'type', label:'Type', value:u.type, required:true},
      {id:'size', label:'Size (sq ft)', type:'number', value:u.size},
      {id:'rent', label:'Rent per month (£)', type:'number', step:'0.01', value:u.rent},
      {id:'wasRent', label:'Previous rent, if reduced (£)', type:'number', step:'0.01', value:u.wasRent, hint:'Shows a Reduced label. Leave blank to remove it'},
      {id:'status', label:'Status', type:'select', options:Object.entries(STATUS), value:u.status},
      {id:'availableFrom', label:'Available from (if coming soon)', type:'date', value:u.availableFrom},
      {id:'inclusive', label:'Rent includes internet, electricity and water', type:'checkbox', value:u.inclusive},
      {id:'ratesIncluded', label:'No business rates to register for (covered by the landlord)', type:'checkbox', value:ratesIncluded(u), full:true},
      {id:'localPricing', label:'Use local business rates (the rent above is the Kineton rate)', type:'checkbox', value:u.localPricing !== false},
      {id:'nearbyExtra', label:'This space only: fixed extra within 6 miles (£)', type:'number', step:'0.01', value:u.nearbyExtra, hint:'Blank uses the site-wide amount'},
      {id:'furtherExtra', label:'This space only: extra further afield (£)', type:'number', step:'0.01', value:u.furtherExtra, hint:'Blank uses the site-wide amount'},
      {id:'termType', label:'Agreement', type:'select', options:[['licence', 'Licence: 3-month minimum, then monthly'], ['lease', 'Lease: 12-month minimum']], value: termOf(u)},
      {id:'depositMonths', label:'Deposit (months of rent)', type:'number', step:'0.5', value: depositMonths(u)},
      {id:'serviceCharge', label:'Service charge', type:'select', options:[['included', 'Included in rent'], ['extra', 'Charged on top of rent'], ['none', 'No service charge']], value:u.serviceCharge || 'none'},
      {id:'serviceChargeAmount', label:'Service charge per month (£)', type:'number', step:'0.01', value:u.serviceChargeAmount, hint:'Only if charged on top'},
      {id:'widthM', label:'Width (m)', type:'number', step:'0.01', value:u.widthM},
      {id:'depthM', label:'Depth (m)', type:'number', step:'0.01', value:u.depthM},
      {id:'ceilingM', label:'Ceiling height (m)', type:'number', step:'0.01', value:u.ceilingM},
      {id:'access', label:'Entrance', value:u.access, full:true, placeholder:'e.g. Through the main building entrance on Mill Lane'},
      {id:'doorType', label:'Doors', value:u.doorType || 'Door', placeholder:'e.g. Metal shutters to Mill Lane'},
      {id:'doorWidthM', label:'Door width (m)', type:'number', step:'0.01', value:u.doorWidthM},
      {id:'doorHeightM', label:'Door height (m)', type:'number', step:'0.01', value:u.doorHeightM},
      {id:'description', label:'Description', type:'textarea', full:true, rows:3, value:u.description},
      {id:'info', label:'Additional information (one per line)', type:'textarea', full:true, rows:3, value:(u.info || []).join('\n'), placeholder:'e.g. Three-phase power\nParking for one van'},
      {id:'floorsText', label:'Floors and rooms (one per line: floor | room | width m | depth m | optional note)', type:'textarea', full:true, rows:4, value:floorsToText(u), placeholder:'Ground floor | Workshop | 6 | 5\nFirst floor | Office | 4 | 3', hint:'For spaces over more than one floor. Leave empty to use the single width and depth above'},
      {id:'photos', label:'Photos (one per line: caption | image file)', type:'textarea', full:true, rows:4, value:photoList(u).map(p => p.src ? `${p.caption} | ${p.src}` : p.caption).join('\n'), hint:'A line with only a caption shows a placeholder until a photo is added'}
    ],
    submit: 'Save',
    onSubmit: async v => {
      const id = u.id || v.code.toLowerCase().replace(/[^a-z0-9]/g, '') || uid();
      const was = u.status;
      const lines = x => x.split('\n').map(s => s.trim()).filter(Boolean);
      const floors = textToFloors(v.floorsText || ''); delete v.floorsText;
      v.floors = floors;
      const nu = {...u, ...v, id, name: u.name && u.code === v.code ? u.name : 'Unit ' + v.code, placeholder: false, info: lines(v.info), photos: lines(v.photos).map(l => { const [c, src] = l.split('|').map(x => x.trim()); return src ? {caption: c, src} : {caption: c, src: ''}; })};
      await put('units', nu);
      if (v.status === 'available' && was !== 'available') await queueAlerts(nu);
    }
  });
}
async function setUnitStatus(id, status) {
  const u = unitById(id); if (!u || u.status === status) return;
  const nu = {...u, status};
  await put('units', nu);
  if (status === 'available') await queueAlerts(nu); else toast(`${u.name} set to ${STATUS[status]}`);
}
async function queueAlerts(u) {
  const P = prop();
  const who = S.enquiries.filter(e => e.notify && !['converted', 'declined'].includes(e.status) && matches(e, u)
    && !S.outbox.some(o => o.enquiryId === e.id && o.unitId === u.id && o.status === 'pending'));
  for (const e of who) {
    const body = `Hi ${e.name.split(' ')[0]},\n\nGood news: ${u.name} at ${P.name} is now available${u.size ? ` (${Number(u.size).toLocaleString('en-GB')} sq ft` : ''}${u.rent ? `${u.size ? ', ' : ' ('}${gbp(u.rent)} a month${u.inclusive ? ' including internet, electricity and water' : ''})` : u.size ? ')' : ''}.\n\nReply to this email to arrange a viewing or to take the space.\n\nThanks,\n${P.name}`;
    await put('outbox', {id: uid(), enquiryId: e.id, unitId: u.id, name: e.name, to: e.email, subject: `${u.name} at ${P.name} is now available`, body, status: 'pending', createdAt: new Date().toISOString()});
  }
  toast(who.length ? `${u.name} is available. ${who.length} waitlist alert${who.length > 1 ? 's' : ''} ready to send.` : `${u.name} is available. Nobody on the waitlist matches it.`);
}
function tenantForm(t, fromEnq) {
  const isNew = !t; t = t || {};
  const freeOrMine = units().filter(u => u.status !== 'let' || u.id === t.unitId || !tenantInUnit(u.id));
  const pre = fromEnq && unitById(fromEnq.interest) ? fromEnq.interest : (freeOrMine[0]?.id || '');
  openForm({
    title: isNew ? 'Add tenant' : 'Edit tenant',
    intro: fromEnq ? `Turning ${esc(fromEnq.name)}'s enquiry into a tenancy. The space will be marked as let.` : '',
    fields: [
      {id:'name', label:'Contact name', value: t.name || fromEnq?.name || '', required:true},
      {id:'business', label:'Business', value: t.business || fromEnq?.business || ''},
      {id:'email', label:'Email', type:'email', value: t.email || fromEnq?.email || '', required:true},
      {id:'phone', label:'Phone', type:'tel', value: t.phone || fromEnq?.phone || ''},
      {id:'unitId', label:'Space', type:'select', options: freeOrMine.map(u => [u.id, `${u.name}${u.status === 'let' && u.id !== t.unitId ? ' (let)' : ''}`]), value: t.unitId || pre},
      ...(localPricing().enabled ? [{id:'rateTier', label:'Rate', type:'select', options: Object.entries(TIERS), value: t.rateTier || fromEnq?.suggestedTier || fromEnq?.based || 'kineton'}] : []),
      {id:'rent', label:'Monthly rent (£)', type:'number', step:'0.01', value: t.rent ?? '', hint: 'Leave blank to use the space’s price for the chosen rate'},
      {id:'leaseStart', label:'Tenancy start', type:'date', value: t.leaseStart || fromEnq?.start || today()},
      {id:'deposit', label:'Deposit (£)', type:'number', step:'0.01', value: t.deposit ?? '', hint: 'Leave blank to use the space’s deposit (months × rent)'},
      {id:'depositReceived', label:'Deposit received on', type:'date', value: t.depositReceived || ''},
      {id:'depositReturned', label:'Deposit returned on', type:'date', value: t.depositReturned || ''},
      ...(isNew ? [{id:'firstInvoice', label:'Raise the first invoice now: deposit plus first month', type:'checkbox', value: true, full: true}] : []),
      {id:'paymentMethod', label:'Pays by', type:'select', options: (prop().paymentMethods && prop().paymentMethods.length ? prop().paymentMethods : ['dd', 'bank']).map(k => [k, PAY[k]]), value: t.paymentMethod || 'dd'}
    ],
    submit: isNew ? 'Add tenant' : 'Save',
    onSubmit: async v => {
      const u = unitById(v.unitId);
      const firstInvoice = v.firstInvoice; delete v.firstInvoice;
      const nt = {...t, ...v, id: t.id || uid(), rent: v.rent ?? priceFor(u, v.rateTier || 'kineton') ?? null, status: 'active', example: isNew ? false : t.example};
      if (nt.deposit == null && nt.rent && u) nt.deposit = Math.round(depositMonths(u) * Number(nt.rent) * 100) / 100;
      if (isNew) delete nt.example;
      await put('tenants', nt);
      if (isNew && firstInvoice && nt.rent) {
        const period = monthLabel(new Date((nt.leaseStart || today()) + 'T00:00:00'));
        const lines = [...(nt.deposit ? [{desc: `Deposit, ${u?.name || 'unit'} (${depositText(u || {})})`, amount: Number(nt.deposit)}] : []), ...rentLines(nt, period)];
        await createInvoice(nt, period, lines, nt.leaseStart && nt.leaseStart > today() ? nt.leaseStart : addDays(today(), 7), 'Deposit and first month. Please pay before your start date.');
      }
      if (t.unitId && t.unitId !== v.unitId) { const old = unitById(t.unitId); if (old) await put('units', {...old, status: 'available'}).then(() => queueAlerts({...old, status:'available'})); }
      if (u && u.status !== 'let') await put('units', {...u, status: 'let'});
      if (fromEnq) await put('enquiries', {...fromEnq, status: 'converted'});
      toast(isNew ? `${nt.business || nt.name} added. Use Invite in the Portal column to give them a sign-in.` : 'Tenant saved');
    }
  });
}
function nextInvoiceNumber(offset = 0) {
  const y = new Date().getFullYear();
  const max = S.invoices.reduce((m, i) => { const r = /^OM-(\d{4})-(\d+)$/.exec(i.number || ''); return r && +r[1] === y ? Math.max(m, +r[2]) : m; }, 0);
  return `OM-${y}-${String(max + 1 + offset).padStart(4, '0')}`;
}
function rentLine(t, period) { const u = unitById(t.unitId); return `${onePrice(u) ? '' : 'Rent, '}${u?.name || 'unit'}, ${period}${u?.inclusive ? ' (internet, electricity and water included)' : ''}`; }
function scAmount(t) { const u = unitById(t.unitId); return u && u.serviceCharge === 'extra' && u.serviceChargeAmount ? Number(u.serviceChargeAmount) : null; }
function rentLines(t, period) { const L = [{desc: rentLine(t, period), amount: Number(t.rent)}], sc = scAmount(t); if (sc) L.push({desc: `Service charge, ${unitById(t.unitId).name}, ${period}`, amount: sc}); return L; }
function invoiceForm(tenantId) {
  const T = activeTenants();
  if (!T.length) { toast('Add a tenant before raising an invoice.'); return; }
  const t0 = tenantById(tenantId) || T[0], period = monthLabel();
  openForm({
    title: 'New invoice',
    intro: 'The invoice appears in the tenant’s portal straight away, with a message letting them know.',
    fields: [
      {id:'tenantId', label:'Tenant', type:'select', options: T.map(t => [t.id, `${t.business || t.name} · ${unitById(t.unitId)?.code || ''}`]), value: t0.id, full:true},
      {id:'period', label:'Period', value: period, required:true},
      {id:'due', label:'Due date', type:'date', value: addDays(today(), 14), required:true},
      {id:'rentAmount', label:'Rent (£)', type:'number', step:'0.01', value: t0.rent, hint:'Updates to the chosen tenant’s rent'},
      {id:'scAmount', label:'Service charge (£)', type:'number', step:'0.01', value: scAmount(t0), hint:'Blank if included or none'},
      {id:'extraDesc', label:'Extra line (optional)', placeholder:'e.g. Replacement key'},
      {id:'extraAmount', label:'Extra amount (£)', type:'number', step:'0.01'},
      {id:'note', label:'Note to tenant', type:'textarea', rows:2, full:true}
    ],
    submit: 'Create invoice',
    onSubmit: async v => {
      const t = tenantById(v.tenantId);
      const lines = [];
      if (v.rentAmount) lines.push({desc: rentLine(t, v.period), amount: v.rentAmount});
      if (v.scAmount) lines.push({desc: `Service charge, ${unitById(t.unitId)?.name || 'unit'}, ${v.period}`, amount: v.scAmount});
      if (v.extraDesc && v.extraAmount) lines.push({desc: v.extraDesc, amount: v.extraAmount});
      if (!lines.length) throw {code: 'form', message: 'empty'};
      await createInvoice(t, v.period, lines, v.due, v.note);
      toast('Invoice created');
    }
  });
  const sel = $('#f-tenantId');
  sel.addEventListener('change', () => { const t = tenantById(sel.value); if (t) { $('#f-rentAmount').value = t.rent ?? ''; $('#f-scAmount').value = scAmount(t) ?? ''; } });
}
async function createInvoice(t, period, lines, due, note, offset = 0) {
  const inv = {id: uid(), number: nextInvoiceNumber(offset), tenantId: t.id, period, issued: today(), due, lines, total: Math.round(lines.reduce((s, l) => s + Number(l.amount || 0), 0) * 100) / 100, status: 'due'};
  if (note) inv.note = note;
  await put('invoices', inv);
  await put('messages', {id: uid(), to: t.id, kind: 'invoice', subject: `Invoice ${inv.number} for ${period}`, body: `Your invoice for ${period} is ready: ${gbp(inv.total)}, due ${fmtDate(due)}. You can view it in the Invoices section.`, createdAt: new Date().toISOString()});
}
async function runMonthly() {
  const period = monthLabel();
  const todo = activeTenants().filter(t => t.rent && !S.invoices.some(i => i.tenantId === t.id && i.period === period));
  if (!todo.length) { toast(`Everyone already has a ${period} invoice.`); return; }
  confirmBox(`Raise ${period} rent`, `Create ${todo.length} rent invoice${todo.length > 1 ? 's' : ''} (${gbp(todo.reduce((s, t) => s + Number(t.rent) + (scAmount(t) || 0), 0))} in total, including service charges), due in 14 days. Each tenant gets a message in their portal.`, 'Create invoices', async () => {
    let n = 0;
    for (const t of todo) { await createInvoice(t, period, rentLines(t, period), addDays(today(), 14), '', n); n++; }
    toast(`${n} invoice${n > 1 ? 's' : ''} created`);
  });
}
function messageForm(to) {
  openForm({
    title: 'Message tenants',
    intro: 'Your message appears in the tenant portal.',
    fields: [
      {id:'to', label:'Send to', type:'select', options: [['all', 'All current tenants'], ...activeTenants().map(t => [t.id, t.business || t.name])], value: to || 'all'},
      {id:'kind', label:'Type', type:'select', options: [['update', 'Site update'], ['notice', 'Notice'], ['wifi', 'Wi-Fi']], value: 'update'},
      {id:'subject', label:'Subject', full:true, required:true},
      {id:'body', label:'Message', type:'textarea', full:true, rows:5, required:true}
    ],
    submit: 'Send message',
    onSubmit: async v => { await put('messages', {id: uid(), ...v, createdAt: new Date().toISOString()}); toast(v.to === 'all' ? 'Sent to all tenants' : 'Message sent'); }
  });
}
function wifiForm(n) {
  const isNew = !n; n = n || {appliesTo: 'all'};
  openForm({
    title: isNew ? 'Add Wi-Fi network' : 'Edit Wi-Fi network',
    fields: [
      {id:'ssid', label:'Network name', value: n.ssid, required:true},
      {id:'password', label:'Password', value: n.password, required:true},
      {id:'appliesTo', label:'Who can see it', type:'select', full:true, options: [['all', 'All tenants'], ['unit1', 'Mill Rooms'], ...units().map(u => [u.id, u.name])], value: n.appliesTo}
    ],
    submit: 'Save',
    onSubmit: async v => {
      const nets = [...(S.wifi?.networks || [])], nn = {...n, ...v, id: n.id || uid()}, i = nets.findIndex(x => x.id === nn.id);
      if (i >= 0) nets[i] = nn; else nets.push(nn);
      await putDoc('wifi', {networks: nets}); toast('Wi-Fi saved');
    }
  });
}
function lpForm() {
  const L = localPricing();
  openForm({
    title: 'Local business rates',
    intro: 'The rent listed on each space is the Kineton price. Businesses based further away pay the percentage or amount set here on top.',
    fields: [
      {id:'enabled', label:'Use local business rates', type:'checkbox', value:L.enabled, full:true},
      {id:'mode', label:'How prices go up', type:'select', options:[['percent', 'By percentage'], ['fixed', 'By a fixed £ amount']], value:L.mode},
      {id:'nearbyMiles', label:'Nearby radius (miles)', type:'number', value:L.nearbyMiles},
      {id:'nearbyPct', label:'Nearby (%)', type:'number', step:'0.1', value:L.nearbyPct},
      {id:'furtherPct', label:'Further afield (%)', type:'number', step:'0.1', value:L.furtherPct},
      {id:'nearbyExtra', label:'Nearby, fixed amount (£)', type:'number', step:'0.01', value:L.nearbyExtra},
      {id:'furtherExtra', label:'Further afield, fixed amount (£)', type:'number', step:'0.01', value:L.furtherExtra},
      {id:'roundTo', label:'Round percentage prices to the nearest (£)', type:'number', value:L.roundTo, hint:'e.g. 5 turns £286 into £285. 0 for exact prices'},
      {id:'nearbyPlaces', label:'Nearby examples', value:L.nearbyPlaces, full:true},
      {id:'furtherPlaces', label:'Further afield examples', value:L.furtherPlaces, full:true}
    ],
    submit: 'Save',
    onSubmit: async v => { await putDoc('property', {...prop(), localPricing: {...v, nearbyPct: v.nearbyPct ?? 0, furtherPct: v.furtherPct ?? 0, nearbyExtra: v.nearbyExtra ?? 0, furtherExtra: v.furtherExtra ?? 0, roundTo: v.roundTo ?? 0, nearbyMiles: v.nearbyMiles ?? 6}}); toast('Local business rates saved'); }
  });
}
function propForm() {
  const P = prop();
  openForm({
    title: 'Property details',
    fields: [
      {id:'name', label:'Property name', value:P.name, required:true}, {id:'address', label:'Address', value:P.address},
      {id:'email', label:'Contact email', type:'email', value:P.email}, {id:'phone', label:'Phone', type:'tel', value:P.phone},
      {id:'tagline', label:'Tagline', value:P.tagline, full:true},
      {id:'description', label:'About the property', type:'textarea', rows:5, full:true, value:P.description, hint:'Leave a blank line between paragraphs'},
      {id:'features', label:'Highlights (one per line)', type:'textarea', rows:4, full:true, value:(P.features || []).join('\n')},
      {id:'offerDD', label:'Offer Direct Debit', type:'checkbox', value:(P.paymentMethods || []).includes('dd')},
      {id:'offerBank', label:'Offer bank transfer', type:'checkbox', value:(P.paymentMethods || []).includes('bank')},
      {id:'bankDetails', label:'Bank details shown on bank-transfer invoices', type:'textarea', rows:3, full:true, value:P.bankDetails, placeholder:'Account name\nSort code\nAccount number'},
      {id:'paymentNote', label:'Extra note on every invoice', type:'textarea', rows:2, full:true, value:P.paymentNote}
    ],
    submit: 'Save',
    onSubmit: async v => {
      const {offerDD, offerBank, ...rest} = v;
      await putDoc('property', {...prop(), ...rest, features: v.features.split('\n').map(s => s.trim()).filter(Boolean), paymentMethods: [offerDD && 'dd', offerBank && 'bank'].filter(Boolean)});
      toast('Property details saved');
    }
  });
}

/* ---------- accounts ---------- */
function portalCell(t) {
  const a = access.find(x => x.tenantId === t.id);
  const state = !a ? '<span class="pill s-let">No account</span>' : a.active ? '<span class="pill s-paid">Active</span>' : '<span class="pill s-pending">Invited</span>';
  return `<div class="row" style="gap:6px;flex-wrap:nowrap">${state}<button class="btn sm" data-act="tenant-invite" data-id="${esc(t.id)}">${!a ? 'Invite' : a.active ? 'Reset link' : 'New link'}</button>${a ? `<button class="btn sm danger" data-act="tenant-revoke" data-id="${esc(t.id)}">Remove</button>` : ''}</div>`;
}
let lastInvite = null;
async function inviteTenant(id) {
  const t = tenantById(id);
  try {
    const r = await api('POST', `/api/admin/tenants/${encodeURIComponent(id)}/invite`);
    const first = (t.name || '').split(' ')[0] || 'there';
    lastInvite = {link: r.link, message: `Hi ${first}, here's your link to ${r.reset ? 'reset your password for' : 'set up'} your tenant account at ${prop().name}: ${r.link}\nThe link works for 14 days. In the portal you'll find your invoices, Wi-Fi details and updates.`};
    openSheet(`<header><h2>${r.reset ? 'Password reset link' : 'Invitation link'}</h2><button type="button" class="x" data-act="close" aria-label="Close">×</button></header>
      <p>Send this link to ${esc(t.name)} (<span class="mono">${esc(t.email)}</span>) by WhatsApp or email. They open it, choose a password, and their portal is ready. It works once and expires on ${fmtDate(r.expires)}.</p>
      <pre class="draft" style="user-select:all">${esc(r.link)}</pre>
      <footer><button class="btn" data-act="copy-invite" data-what="link">Copy link</button><button class="btn primary" data-act="copy-invite" data-what="message">Copy message with link</button></footer>`);
    refreshAdmin();
  } catch (e) { toast(dbErr(e)); }
}
function loginView(kind) {
  if (!loaded) return '<div class="dash wrap"><div class="empty">Loading…</div></div>';
  const tenantInLandlord = kind === 'landlord' && me && me.role === 'tenant';
  return `<div class="dash wrap" style="max-width:520px">
    <section class="panel" style="padding:28px">
      <p class="eyebrow">${esc(prop().name)}</p>
      <h1 class="h2">${kind === 'landlord' ? 'Landlord sign in' : 'Tenant sign in'}</h1>
      ${tenantInLandlord ? '<p>You are signed in with a tenant account. <button class="btn sm" data-act="logout">Sign out</button></p>' : ''}
      <form id="login-form" novalidate style="display:grid;gap:12px">
        <label class="field"><span>Email</span><input id="login-email" type="email" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input id="login-password" type="password" autocomplete="current-password" required></label>
        <p class="form-err" id="login-err" hidden></p>
        <button class="btn primary" type="submit" style="justify-content:center">Sign in</button>
      </form>
      ${kind === 'tenant' ? '<p class="muted" style="font-size:14px">New tenant? We will send you a link to set up your account. Forgotten your password? Ask us for a new link.</p>' : ''}
    </section></div>`;
}
let inviteState = null;
function viewInvite() {
  if (!inviteState) return '<div class="dash wrap"><div class="empty">Checking your link…</div></div>';
  if (inviteState.error) return `<div class="dash wrap" style="max-width:520px"><section class="panel" style="padding:28px"><h1 class="h2">Link not valid</h1><p>${esc(inviteState.error)}</p><button class="btn" data-view="tenant">Go to tenant sign in</button></section></div>`;
  return `<div class="dash wrap" style="max-width:520px">
    <section class="panel" style="padding:28px">
      <p class="eyebrow">${esc(prop().name)} · Tenant portal</p>
      <h1 class="h2">Choose your password</h1>
      <p>You'll sign in with <b class="mono">${esc(inviteState.email)}</b>.</p>
      <form id="invite-form" novalidate style="display:grid;gap:12px">
        <input type="email" autocomplete="username" value="${esc(inviteState.email)}" hidden>
        <label class="field"><span>New password</span><input id="invite-password" type="password" autocomplete="new-password" minlength="10" required><small>At least 10 characters.</small></label>
        <label class="field"><span>Type it again</span><input id="invite-password2" type="password" autocomplete="new-password" required></label>
        <p class="form-err" id="invite-err" hidden></p>
        <button class="btn primary" type="submit" style="justify-content:center">Save and open my portal</button>
      </form>
    </section></div>`;
}
function passwordForm() {
  openForm({
    title: 'Change password',
    fields: [{id:'current', label:'Current password', type:'password', required:true, full:true}, {id:'next', label:'New password (at least 10 characters)', type:'password', required:true, full:true}],
    submit: 'Change password',
    onSubmit: async v => { await api('POST', '/api/account/password', v); toast('Password changed'); }
  });
}
async function refreshAdmin() {
  const d = await api('GET', '/api/admin/data');
  Object.assign(S, {property: d.property, wifi: d.wifi, units: d.units, tenants: d.tenants, invoices: d.invoices, messages: d.messages, enquiries: d.enquiries, outbox: d.outbox});
  access = d.access || [];
  render();
}
async function loadAll() {
  try {
    const [sess, pub] = await Promise.all([api('GET', '/api/session'), api('GET', '/api/public')]);
    me = sess.user; S.property = pub.property; S.units = pub.units;
    if (me && me.role === 'landlord') { mode = 'landlord'; await refreshAdmin(); }
    else if (me && me.role === 'tenant') {
      try {
        const d = await api('GET', '/api/me');
        Object.assign(S, {property: d.property, units: d.units, tenants: [d.tenant], invoices: d.invoices, messages: d.messages, wifi: d.wifi});
        mode = 'tenant'; curTenant = d.tenant.id;
      } catch (e) { me = null; mode = 'public'; }
    } else mode = 'public';
  } catch (e) {
    $('#app').innerHTML = `<div class="dash wrap"><div class="empty">${esc(e.message || 'Could not load the page.')} <button class="btn sm" data-act="reload">Try again</button></div></div>`;
    return;
  }
  loaded = true;
  render();
}
document.addEventListener('submit', async e => {
  if (e.target.id === 'login-form') {
    e.preventDefault();
    const err = $('#login-err'), btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; err.hidden = true;
    try {
      await api('POST', '/api/login', {email: $('#login-email').value, password: $('#login-password').value});
      location.reload();
    } catch (x) { err.textContent = x.message; err.hidden = false; btn.disabled = false; }
  }
  if (e.target.id === 'invite-form') {
    e.preventDefault();
    const err = $('#invite-err'), p1 = $('#invite-password').value, p2 = $('#invite-password2').value;
    err.hidden = true;
    if (p1.length < 10) { err.textContent = 'Use at least 10 characters.'; err.hidden = false; return; }
    if (p1 !== p2) { err.textContent = 'The two passwords don’t match. Type them again.'; err.hidden = false; return; }
    try {
      await api('POST', `/api/invite/${encodeURIComponent(inviteState.token)}`, {password: p1});
      location.href = '/#tenant';
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  }
});

/* ---------- render & events ---------- */
function render() {
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.view === (view === 'unit' ? 'site' : view)));
  $('#brand-name').textContent = prop().name;
  const tb = $('#tierbar'); if (tb) { const show = loaded && (view === 'site' || view === 'unit'); tb.innerHTML = show ? priceBar() : ''; tb.hidden = !show || !tb.innerHTML; }
  const y = scrollY;
  const lb = document.querySelector('.seg button[data-view="landlord"]'); if (lb) lb.hidden = mode !== 'landlord' && view !== 'landlord';
  $('#app').innerHTML = view === 'invite' ? viewInvite() : view === 'tenant' ? viewTenant() : view === 'landlord' ? viewLandlord() : view === 'unit' ? viewUnit() : viewSite();
  scrollTo(0, y);
}
function setView(v) {
  view = v; try { history.replaceState(null, '', '/#' + (v === 'unit' ? 'unit-' + curUnit : v)); } catch (e) {}
  render(); scrollTo(0, 0);
}
const ACT = {
  enquire: d => enquireForm(d.unit, d.wait),
  unit: d => { closeModal(); curUnit = d.id; curPhoto = 0; setView('unit'); },
  'go-site': () => { setView('site'); document.getElementById('spaces')?.scrollIntoView(); },
  photo: d => { curPhoto = Number(d.i); render(); },
  scroll: d => document.getElementById(d.target)?.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'}),
  filter: d => { siteFilter = d.f; render(); },
  close: () => closeModal(),
  'confirm-yes': async () => { const fn = pendingConfirm; pendingConfirm = null; closeModal(); if (fn) await fn(); },
  'view-invoice': d => invoiceSheet(d.id),
  'copy-wifi': d => { const n = (S.wifi?.networks || []).find(x => x.id === d.id); if (n) copyText(n.password); },
  ltab: d => { ltab = d.tab; render(); },
  'enq-filter': d => { enqFilter = d.f; render(); },
  'unit-add': () => unitForm(null),
  'unit-edit': d => unitForm(unitById(d.id)),
  'enq-convert': d => tenantForm(null, S.enquiries.find(e => e.id === d.id)),
  'enq-del': d => { const e = S.enquiries.find(x => x.id === d.id); confirmBox('Delete enquiry', `Delete ${esc(e?.name)}'s enquiry? This can't be undone.`, 'Delete', () => del('enquiries', d.id)); },
  'tenant-add': () => tenantForm(null),
  'tenant-edit': d => tenantForm(tenantById(d.id)),
  'tenant-end': d => { const t = tenantById(d.id), u = unitById(t?.unitId); confirmBox('End tenancy', `End ${esc(t.business || t.name)}'s tenancy of ${esc(u?.name || 'their space')}? The space will be set to Available and matching waitlist alerts will be drafted. Their invoices are kept.`, 'End tenancy', async () => { await put('tenants', {...t, status: 'former'}); if (u) await setUnitStatus(u.id, 'available'); }); },
  'tenant-del': d => confirmBox('Delete record', 'Delete this former tenant record? Their invoices stay in the Invoices list.', 'Delete', () => del('tenants', d.id)),
  'msg-new': d => messageForm(d.to),
  'msg-del': d => confirmBox('Delete message', 'Remove this message from tenant portals?', 'Delete', () => del('messages', d.id)),
  'inv-new': d => invoiceForm(d.tenant),
  'inv-run': () => runMonthly(),
  'inv-paid': async d => { const i = S.invoices.find(x => x.id === d.id); await put('invoices', {...i, status: 'paid', paidOn: today()}); toast(`${i.number} marked paid`); },
  'inv-unpaid': async d => { const i = S.invoices.find(x => x.id === d.id); const {paidOn, ...rest} = i; await put('invoices', {...rest, status: 'due'}); },
  'inv-del': d => { const i = S.invoices.find(x => x.id === d.id); confirmBox('Delete invoice', `Delete invoice ${esc(i?.number)}? It will disappear from the tenant's portal.`, 'Delete', () => del('invoices', d.id)); },
  'wifi-add': () => wifiForm(null),
  'wifi-edit': d => wifiForm((S.wifi?.networks || []).find(x => x.id === d.id)),
  'wifi-del': d => confirmBox('Remove network', 'Tenants will no longer see this network in their portal.', 'Remove', () => putDoc('wifi', {networks: (S.wifi?.networks || []).filter(x => x.id !== d.id)})),
  'wifi-send': () => messageForm(),
  'prop-edit': () => propForm(),
  'lp-edit': () => lpForm(),
  tier: d => { priceTier = d.t; tierChosen = true; try { localStorage.setItem('oldmill.priceTier', priceTier); } catch (e) {} render(); },
  'scroll-local': () => { setView('site'); setTimeout(() => document.getElementById('local-rates')?.scrollIntoView(), 50); },
  'out-copy': d => { const o = S.outbox.find(x => x.id === d.id); if (o) copyText(`To: ${o.to}\nSubject: ${o.subject}\n\n${o.body}`); },
  'out-sent': async d => { const o = S.outbox.find(x => x.id === d.id); await put('outbox', {...o, status: 'sent', sentAt: new Date().toISOString()}); const e = S.enquiries.find(x => x.id === o.enquiryId); if (e && e.status === 'waitlist') await put('enquiries', {...e, status: 'contacted'}); },
  'out-del': d => del('outbox', d.id),
  'map-open': () => openMap(),
  'map-zoom': d => setMapZoom(mapZoom + Number(d.d)),
  'tenant-invite': d => inviteTenant(d.id),
  'tenant-revoke': d => { const t = tenantById(d.id); confirmBox('Remove portal access', `${esc(t?.name || 'This tenant')} will no longer be able to sign in. Their records are kept, and you can invite them again later.`, 'Remove access', async () => { try { await api('DELETE', `/api/admin/tenants/${encodeURIComponent(d.id)}/access`); await refreshAdmin(); toast('Access removed'); } catch (e) { toast(dbErr(e)); } }); },
  'copy-invite': d => { if (lastInvite) copyText(d.what === 'link' ? lastInvite.link : lastInvite.message); },
  reload: () => location.reload(),
  logout: async () => { try { await api('POST', '/api/logout'); } catch (e) {} location.href = '/'; },
  password: () => passwordForm()
};
document.addEventListener('click', e => {
  const nav = e.target.closest('[data-view]'); if (nav) { setView(nav.dataset.view); return; }
  if (e.target === $('#modal')) { closeModal(); return; }
  const el = e.target.closest('[data-act]'); if (!el || el.tagName === 'SELECT') return;
  const fn = ACT[el.dataset.act]; if (fn) { e.preventDefault(); Promise.resolve(fn(el.dataset)).catch(() => {}); }
});
document.addEventListener('change', e => {
  const el = e.target; if (!el.dataset || !el.dataset.act) return;
  if (el.dataset.act === 'tier-select') { ACT.tier({t: el.value}); return; }
  if (el.dataset.act === 'pick-tenant') { curTenant = el.value; render(); }
  if (el.dataset.act === 'unit-status') setUnitStatus(el.dataset.id, el.value).catch(() => {});
  if (el.dataset.act === 'enq-status') { const x = S.enquiries.find(q => q.id === el.dataset.id); if (x) put('enquiries', {...x, status: el.value}).catch(() => {}); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('g[data-act]')) { e.preventDefault(); ACT[e.target.dataset.act]?.(e.target.dataset); }
});

/* ---------- boot ---------- */
(function boot() {
  const h = (location.hash || '').slice(1);
  if (location.pathname === '/invite') {
    view = 'invite';
    const token = new URLSearchParams(location.search).get('token') || '';
    api('GET', `/api/invite/${encodeURIComponent(token)}`)
      .then(r => { inviteState = {token, email: r.email}; render(); })
      .catch(e => { inviteState = {error: e.message}; render(); });
  }
  else if (['site', 'tenant', 'landlord'].includes(h)) view = h;
  else if (/^unit-[a-z0-9]+$/.test(h)) { view = 'unit'; curUnit = h.slice(5); }
  render();
  loadAll();
})();

// Lets phones and computers install the site as an app (the worker itself caches nothing).
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
function isInstalled() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
function installSheet() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(navigator.userAgent);
  const steps = ios
    ? '<ol><li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button (the square with an arrow pointing up).</li><li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>'
    : android
      ? '<ol><li>Open this page in <b>Chrome</b>.</li><li>Tap the <b>⋮</b> menu at the top right.</li><li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li></ol>'
      : '<ol><li>In <b>Chrome</b> or <b>Edge</b>: click the install icon at the right of the address bar, or open the <b>⋮</b> menu and choose <b>Install The Old Mill</b>.</li><li>In <b>Safari</b> on a Mac: choose <b>File → Add to Dock</b>.</li></ol>';
  openSheet(`<header><h2>Get the app</h2><button type="button" class="x" data-act="close" aria-label="Close">×</button></header>
    <p>Add The Old Mill to your home screen or desktop. It opens in its own window, like an app, and you stay signed in.</p>
    ${installPrompt ? '<footer style="justify-content:flex-start"><button class="btn primary" data-act="install-now">Install now</button></footer><p class="muted">Or do it yourself:</p>' : ''}
    ${steps}
    <footer><button class="btn" data-act="close">Close</button></footer>`);
}
// One click installs where the browser allows it (Chrome, Edge, Android); elsewhere it shows the steps.
ACT['get-app'] = async () => {
  if (!installPrompt) return installSheet();
  installPrompt.prompt();
  const r = await installPrompt.userChoice;
  installPrompt = null;
  if (r.outcome === 'accepted') { toast('Installed. Find The Old Mill on your home screen or desktop.'); const b = $('#install-btn'); if (b) b.hidden = true; }
};
{ const b = $('#install-btn'); if (b) b.hidden = isInstalled(); }
window.addEventListener('appinstalled', () => { const b = $('#install-btn'); if (b) b.hidden = true; });
ACT['install-now'] = async () => { if (!installPrompt) return; installPrompt.prompt(); const r = await installPrompt.userChoice; installPrompt = null; closeModal(); if (r.outcome === 'accepted') toast('Installed. Find The Old Mill on your home screen or desktop.'); };
