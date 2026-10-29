// The Old Mill: public website, tenant portal and landlord admin in one small Express app.
const path = require('path');
const fs = require('fs');
const ssr = require('./src/ssr');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { createStore } = require('./src/store');
const seed = require('./src/seed.json');
const mail = require('./src/mail');
const webpush = require('web-push');

const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const store = createStore();
const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
      'upgrade-insecure-requests': PROD ? [] : null
    }
  }
}));
app.use(express.json({ limit: '300kb' }));

/* ---------- helpers ---------- */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL = /^[^\s@]{1,100}@[^\s@]{1,100}\.[^\s@]{2,}$/;
// Documents the landlord can upload for a tenant, e.g. the signed agreement.
const FILE_TYPES = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx' };
const FILE_ID = /^[a-f0-9]{24}$/;
// Lets a document or attachment show inside the site's own viewer (pages from elsewhere still can't frame it).
function allowOwnViewer(res) {
  const csp = res.getHeader('Content-Security-Policy');
  if (csp) res.setHeader('Content-Security-Policy', String(csp).replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
}
function sendStoredFile(res, f, download) {
  allowOwnViewer(res);
  const ext = FILE_TYPES[f.mime] || '';
  const base = String(f.name).replace(/[^\w .()-]+/g, '').trim() || 'document';
  const name = base.toLowerCase().endsWith(ext) ? base : base + ext;
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(f.data);
}
const ADMIN_COLLECTIONS = ['units', 'tenants', 'invoices', 'messages', 'enquiries', 'outbox'];
const newId = () => crypto.randomBytes(9).toString('base64url');
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function property() {
  const p = await store.get('site', 'property');
  if (!p) return {};
  const { id, ...rest } = p;
  return rest;
}
async function wifi() {
  const w = await store.get('admin', 'wifi');
  return { networks: (w && w.networks) || [] };
}

// What the public may see: no prices on let spaces, no bank details.
function publicUnit(u) {
  const { placeholder, ...out } = u;
  if (out.status === 'let') { delete out.rent; delete out.wasRent; delete out.serviceChargeAmount; }
  return out;
}
function publicProperty(p) {
  const { bankDetails, paymentNote, ...out } = p;
  return out;
}
// Distance from The Old Mill (Mill Lane, Kineton) to a UK postcode, via the free postcodes.io lookup.
const MILL = { lat: 52.157053, lng: -1.506842 }; // CV35 0LA
async function milesFromMill(postcode) {
  try {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const { result } = await r.json();
    if (!result || result.latitude == null) return null;
    const rad = d => d * Math.PI / 180, dLat = rad(result.latitude - MILL.lat), dLng = rad(result.longitude - MILL.lng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(MILL.lat)) * Math.cos(rad(result.latitude)) * Math.sin(dLng / 2) ** 2;
    return Math.round(3958.8 * 2 * Math.asin(Math.sqrt(a)) * 10) / 10;
  } catch (e) { return null; }
}
function matchesInterest(interest, u) {
  return interest === 'any' || interest === u.id || (interest === 'unit1' && u.group === 'unit1') || (interest === 'large' && u.group !== 'unit1');
}

/* ---------- sessions & auth ---------- */
function sessionStore() {
  if (!process.env.DATABASE_URL) return undefined; // memory store is fine for local testing
  const PgSession = require('connect-pg-simple')(session);
  return new PgSession({ pool: store.pool, createTableIfMissing: true });
}

async function loadUser(req, res, next) {
  req.user = null;
  if (req.session && req.session.userId) {
    const u = await store.userBy('id', req.session.userId);
    if (u && u.passwordHash) req.user = u;
  }
  next();
}
const needLandlord = (req, res, next) => (req.user && req.user.role === 'landlord' ? next() : res.status(401).json({ error: 'Sign in as the landlord to do that.' }));
const needTenant = (req, res, next) => (req.user && req.user.role === 'tenant' ? next() : res.status(401).json({ error: 'Sign in to your tenant account to see this.' }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' } });
const enquiryLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests from this connection. Try again in an hour, or WhatsApp us.' } });

function startSession(req, user) {
  return new Promise((resolve, reject) => req.session.regenerate(err => {
    if (err) return reject(err);
    req.session.userId = user.id;
    req.session.save(e => (e ? reject(e) : resolve()));
  }));
}
function sessionUser(u) {
  return u ? { email: u.email, role: u.role, tenantId: u.tenantId || null } : null;
}

/* ---------- routes ---------- */
function routes() {
  const api = express.Router();
  api.use(wrap(loadUser));

  api.get('/session', (req, res) => res.json({ user: sessionUser(req.user) }));

  api.post('/login', loginLimiter, wrap(async (req, res) => {
    const email = clean(req.body.email, 200).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const u = email && await store.userBy('email', email);
    const ok = u && u.passwordHash && await bcrypt.compare(password, u.passwordHash);
    if (!ok) return res.status(401).json({ error: 'That email and password don’t match an account.' });
    if (u.role === 'tenant') {
      const t = await store.get('tenants', u.tenantId);
      if (!t || t.status === 'former') return res.status(403).json({ error: 'This tenant account is no longer active.' });
    }
    await startSession(req, u);
    res.json({ user: sessionUser(u) });
  }));

  api.post('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

  api.post('/account/password', wrap(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in first.' });
    const { current, next } = req.body;
    if (!(await bcrypt.compare(String(current || ''), req.user.passwordHash))) return res.status(400).json({ error: 'Your current password is wrong.' });
    if (typeof next !== 'string' || next.length < 10) return res.status(400).json({ error: 'Use at least 10 characters for the new password.' });
    await store.saveUser({ ...req.user, passwordHash: await bcrypt.hash(next, 12) });
    res.json({ ok: true });
  }));

  // Invitation links: a tenant opens /invite?token=… and chooses a password.
  async function inviteUser(token) {
    if (typeof token !== 'string' || token.length < 20) return null;
    const u = await store.userBy('invite', hashToken(token));
    return u && u.inviteExpires && new Date(u.inviteExpires) > new Date() ? u : null;
  }
  api.get('/invite/:token', wrap(async (req, res) => {
    const u = await inviteUser(req.params.token);
    if (!u) return res.status(404).json({ error: 'This link has expired or already been used. Ask your landlord for a new one.' });
    res.json({ email: u.email });
  }));
  api.post('/invite/:token', loginLimiter, wrap(async (req, res) => {
    const u = await inviteUser(req.params.token);
    if (!u) return res.status(404).json({ error: 'This link has expired or already been used. Ask your landlord for a new one.' });
    const pw = req.body.password;
    if (typeof pw !== 'string' || pw.length < 10) return res.status(400).json({ error: 'Use at least 10 characters for your password.' });
    const saved = { ...u, passwordHash: await bcrypt.hash(pw, 12), inviteTokenHash: null, inviteExpires: null };
    await store.saveUser(saved);
    await startSession(req, saved);
    res.json({ user: sessionUser(saved) });
  }));

  /* public */
  api.get('/public', wrap(async (req, res) => {
    res.json({ property: publicProperty(await property()), units: (await store.list('units')).map(publicUnit) });
  }));

  // Unique visitors per space. Stores a salted hash of the visitor's IP, never the IP itself.
  const viewLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, message: { ok: true } });
  const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|curl|wget|python|headless/i;
  api.post('/view/:unitId', viewLimiter, wrap(async (req, res) => {
    res.json({ ok: true });
    const id = req.params.unitId;
    if (!ID.test(id) || BOT.test(req.get('user-agent') || '') || req.user) return; // ignore robots and signed-in landlord/tenants
    if (!(await store.get('units', id))) return;
    const visitor = crypto.createHmac('sha256', VIEW_SALT).update(req.ip || '').digest('hex').slice(0, 20);
    const now = new Date().toISOString();
    const doc = (await store.get('views', id)) || { id, visitors: {}, total: 0 };
    const { id: _i, ...v } = doc;
    v.visitors = v.visitors || {};
    v.visitors[visitor] = { first: (v.visitors[visitor] && v.visitors[visitor].first) || now, last: now };
    v.total = (v.total || 0) + 1;
    await store.put('views', id, v);
  }));

  api.post('/enquiries', enquiryLimiter, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.website) return res.json({ status: 'new' }); // honeypot field: bots fill it, people never see it
    const units = await store.list('units');
    const interest = clean(b.interest, 30);
    const valid = ['any', 'unit1', 'large', ...units.map(u => u.id)];
    const enq = {
      name: clean(b.name, 100), business: clean(b.business, 120), email: clean(b.email, 200).toLowerCase(),
      phone: clean(b.phone, 40), interest: valid.includes(interest) ? interest : 'any',
      start: /^\d{4}-\d{2}-\d{2}$/.test(b.start || '') ? b.start : '', message: clean(b.message, 2000), notify: !!b.notify
    };
    if (['kineton', 'nearby', 'further'].includes(b.based)) enq.based = b.based;
    const pc = clean(b.postcode, 10).toUpperCase().replace(/\s+/g, ' ');
    if (/^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/.test(pc)) {
      enq.postcode = pc;
      const miles = await milesFromMill(pc);
      if (miles != null) {
        const lp = (await property()).localPricing || {};
        enq.distanceMiles = miles;
        enq.suggestedTier = miles <= 1.5 ? 'kineton' : miles <= (Number(lp.nearbyMiles) || 6) ? 'nearby' : 'further';
      }
    }
    if (!enq.name) return res.status(400).json({ error: 'Add your name to continue.' });
    if (!enq.business) return res.status(400).json({ error: 'Add your business name to continue.' });
    if ((enq.phone.match(/\d/g) || []).length < 10) return res.status(400).json({ error: 'Enter a full phone number, including the area code.' });
    if (!enq.start) return res.status(400).json({ error: 'Choose your ideal start date.' });
    if (!enq.message) return res.status(400).json({ error: 'Tell us about your business and how you plan to use the space.' });
    if (!/^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/.test(clean(b.postcode, 10).toUpperCase().replace(/\s+/g, ' '))) return res.status(400).json({ error: 'Enter a full UK postcode, like CV35 0XX.' });
    if (!EMAIL.test(enq.email)) return res.status(400).json({ error: 'Enter a full email address, like name@business.co.uk.' });
    const free = units.some(u => u.status === 'available' && matchesInterest(enq.interest, u));
    enq.status = free ? 'new' : 'waitlist';
    enq.createdAt = new Date().toISOString();
    await store.put('enquiries', newId(), enq);
    res.json({ status: enq.status });
    { const u = units.find(x => x.id === enq.interest);
      notifyLandlord({ title: `${enq.status === 'new' ? 'New request' : 'New waitlist sign-up'}: ${enq.name}`, body: `${enq.business} · ${u ? u.name : enq.interest === 'any' ? 'Any space' : enq.interest}${enq.start ? ` · from ${new Date(enq.start + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}`, url: '/landlord?tab=enquiries' }); }
    // Let the landlord know straight away (doesn't hold up the visitor).
    if (mail.enabled()) {
      const unit = units.find(u => u.id === enq.interest);
      const lines = [
        `New ${enq.status === 'new' ? 'request' : 'waitlist sign-up'} from the website.`, '',
        `Name: ${enq.name}`, `Business: ${enq.business}`, `Email: ${enq.email}`, `Phone: ${enq.phone}`,
        `Space: ${unit ? unit.name : enq.interest}`, `Based: ${enq.based || '-'}${enq.postcode ? ` (${enq.postcode}${enq.distanceMiles != null ? `, ${enq.distanceMiles} miles away` : ''})` : ''}`,
        `Ideal start: ${enq.start}`, '', enq.message, '', 'Reply to this email to answer them, or open Landlord → Enquiries.'
      ];
      mail.sendMail({ to: mail.address(), subject: `Old Mill enquiry: ${enq.name} (${enq.business})`, text: lines.join('\n'), replyTo: enq.email })
        .catch(e => console.warn('Enquiry email not sent:', e.message));
    }
  }));

  /* tenant */
  api.get('/tenant/files/:fid', needTenant, wrap(async (req, res) => {
    const f = FILE_ID.test(req.params.fid) && await store.getFile(req.params.fid);
    if (!f || f.tenantId !== req.user.tenantId) return res.status(404).json({ error: 'That document isn’t available.' });
    sendStoredFile(res, f, req.query.download === '1');
  }));
  // Tenants can turn on notifications for messages the landlord sends them.
  api.get('/tenant/push/key', needTenant, (req, res) => res.json({ key: VAPID.publicKey }));
  api.post('/tenant/push/subscribe', needTenant, wrap(async (req, res) => {
    const sub = req.body && req.body.subscription;
    if (!validSub(sub)) return res.status(400).json({ error: 'That device couldn’t be registered.' });
    await store.put('tenantpush', subId(sub.endpoint), { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, tenantId: req.user.tenantId, device: clean(req.body.device, 200), createdAt: new Date().toISOString() });
    res.json({ ok: true });
  }));
  api.post('/tenant/push/unsubscribe', needTenant, wrap(async (req, res) => {
    const ep = req.body && req.body.endpoint;
    if (typeof ep === 'string') await store.del('tenantpush', subId(ep));
    res.json({ ok: true });
  }));
  api.get('/me', needTenant, wrap(async (req, res) => {
    const t = await store.get('tenants', req.user.tenantId);
    if (!t || t.status === 'former') return res.status(403).json({ error: 'This tenant account is no longer active.' });
    const units = (await store.list('units')).map(u => (u.id === t.unitId ? u : publicUnit(u)));
    const unit = units.find(u => u.id === t.unitId);
    const nets = (await wifi()).networks.filter(n => n.appliesTo === 'all' || (unit && (n.appliesTo === unit.id || (n.appliesTo === 'unit1' && unit.group === 'unit1'))));
    res.json({
      property: await property(),
      units,
      tenant: t,
      invoices: (await store.list('invoices')).filter(i => i.tenantId === t.id),
      messages: (await store.list('messages')).filter(m => m.to === 'all' || m.to === t.id),
      files: (await store.listFiles()).filter(f => f.tenantId === t.id),
      wifi: { networks: nets }
    });
  }));

  /* landlord */
  const admin = express.Router();
  admin.use(needLandlord);

  admin.get('/data', wrap(async (req, res) => {
    const out = { property: await property(), wifi: await wifi() };
    for (const c of ADMIN_COLLECTIONS) out[c] = await store.list(c);
    const week = Date.now() - 7 * 864e5;
    out.views = (await store.list('views')).map(v => {
      const vis = Object.values(v.visitors || {});
      return { unitId: v.id, unique: vis.length, week: vis.filter(x => Date.parse(x.last) > week).length, total: v.total || 0, last: vis.reduce((m, x) => (x.last > m ? x.last : m), '') };
    });
    out.files = await store.listFiles();
    out.access = (await store.listUsers()).filter(u => u.role === 'tenant').map(u => ({
      tenantId: u.tenantId, email: u.email, active: !!u.passwordHash, inviteExpires: u.inviteExpires
    }));
    res.json(out);
  }));

  admin.put('/settings/:key', wrap(async (req, res) => {
    const key = req.params.key;
    if (key === 'property') await store.put('site', 'property', req.body || {});
    else if (key === 'wifi') await store.put('admin', 'wifi', { networks: Array.isArray(req.body.networks) ? req.body.networks : [] });
    else return res.status(404).json({ error: 'Unknown setting.' });
    res.json({ ok: true });
  }));

  admin.put('/:col/:id', wrap(async (req, res) => {
    const { col, id } = req.params;
    if (!ADMIN_COLLECTIONS.includes(col) || !ID.test(id)) return res.status(400).json({ error: 'That record can’t be saved.' });
    const { id: _ignore, ...data } = req.body || {};
    const isNewMessage = col === 'messages' && !(await store.get(col, id));
    await store.put(col, id, data);
    res.json({ ok: true });
    if (isNewMessage) notifyTenants(data.to, { title: data.subject ? `The Old Mill: ${String(data.subject).slice(0, 80)}` : 'New message from The Old Mill', body: String(data.body || '').slice(0, 160), url: '/tenant', tag: `oldmill-msg-${id}` }).catch(e => console.warn('Tenant push failed:', e.message));
  }));

  admin.delete('/:col/:id', wrap(async (req, res) => {
    const { col, id } = req.params;
    if (!ADMIN_COLLECTIONS.includes(col) || !ID.test(id)) return res.status(400).json({ error: 'That record can’t be deleted.' });
    await store.del(col, id);
    if (col === 'tenants') {
      const u = await store.userBy('tenantId', id);
      if (u) await store.deleteUser(u.id);
    }
    res.json({ ok: true });
  }));

  // Create (or refresh) a tenant's sign-in invitation. The landlord sends the link by WhatsApp or email.
  admin.post('/tenants/:id/invite', wrap(async (req, res) => {
    const t = ID.test(req.params.id) && await store.get('tenants', req.params.id);
    if (!t) return res.status(404).json({ error: 'Tenant not found.' });
    const email = clean(t.email, 200).toLowerCase();
    if (!EMAIL.test(email)) return res.status(400).json({ error: 'Add a valid email address to this tenant first.' });
    const clash = await store.userBy('email', email);
    if (clash && clash.tenantId !== t.id) return res.status(409).json({ error: 'Another account already uses this email address.' });
    const existing = await store.userBy('tenantId', t.id);
    const token = crypto.randomBytes(24).toString('base64url');
    const u = { ...(existing || { id: newId(), role: 'tenant', tenantId: t.id }), email, inviteTokenHash: hashToken(token), inviteExpires: new Date(Date.now() + 14 * 864e5).toISOString() };
    await store.saveUser(u);
    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ link: `${base.replace(/\/$/, '')}/invite?token=${token}`, expires: u.inviteExpires, reset: !!(existing && existing.passwordHash) });
  }));

  admin.delete('/tenants/:id/access', wrap(async (req, res) => {
    const u = ID.test(req.params.id) && await store.userBy('tenantId', req.params.id);
    if (u) await store.deleteUser(u.id);
    // Their phones stop getting message notifications too.
    for (const s of await store.list('tenantpush')) if (s.tenantId === req.params.id) await store.del('tenantpush', s.id);
    res.json({ ok: true });
  }));

  /* tenant documents */
  admin.post('/tenants/:id/files', express.raw({ type: () => true, limit: '15mb' }), wrap(async (req, res) => {
    const t = ID.test(req.params.id) && await store.get('tenants', req.params.id);
    if (!t) return res.status(404).json({ error: 'That tenant wasn’t found.' });
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const data = req.body;
    if (!FILE_TYPES[mime]) return res.status(400).json({ error: 'Upload a PDF, Word document (.docx), JPG or PNG.' });
    if (!Buffer.isBuffer(data) || !data.length) return res.status(400).json({ error: 'That file is empty.' });
    if (mime === 'application/pdf' && data.subarray(0, 5).toString() !== '%PDF-') return res.status(400).json({ error: 'That file isn’t a valid PDF.' });
    const f = { id: crypto.randomBytes(12).toString('hex'), tenantId: t.id, name: clean(req.query.name, 120) || 'Document', mime };
    await store.putFile(f, data);
    res.json({ ok: true, files: await store.listFiles() });
  }));
  admin.get('/files/:fid', wrap(async (req, res) => {
    const f = FILE_ID.test(req.params.fid) && await store.getFile(req.params.fid);
    if (!f) return res.status(404).json({ error: 'That document wasn’t found.' });
    sendStoredFile(res, f, req.query.download === '1');
  }));
  admin.delete('/files/:fid', wrap(async (req, res) => {
    if (FILE_ID.test(req.params.fid)) await store.delFile(req.params.fid);
    res.json({ ok: true, files: await store.listFiles() });
  }));

  /* phone notifications (web push to the installed app) */
  admin.get('/push/key', (req, res) => res.json({ key: VAPID.publicKey }));
  admin.post('/push/subscribe', wrap(async (req, res) => {
    const sub = req.body && req.body.subscription;
    if (!validSub(sub)) return res.status(400).json({ error: 'That device couldn’t be registered.' });
    await store.put('pushsubs', subId(sub.endpoint), { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, device: clean(req.body.device, 200), createdAt: new Date().toISOString() });
    res.json({ ok: true, devices: (await store.list('pushsubs')).length });
  }));
  admin.post('/push/unsubscribe', wrap(async (req, res) => {
    const ep = req.body && req.body.endpoint;
    if (typeof ep === 'string') await store.del('pushsubs', subId(ep));
    res.json({ ok: true });
  }));
  admin.get('/push/devices', wrap(async (req, res) => res.json({ devices: (await store.list('pushsubs')).map(d => ({ device: d.device, createdAt: d.createdAt })) })));
  admin.post('/push/test', wrap(async (req, res) => {
    const report = [];
    const sent = await notifyLandlord({ title: 'The Old Mill', body: 'Notifications are working. You’ll get one whenever someone requests a space.', url: '/landlord?tab=enquiries' }, report);
    res.json({ sent, report });
  }));

  /* landlord mailbox */
  const mailLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many emails sent in the last hour. Try again later.' } });
  const notSetUp = res => res.status(503).json({ error: 'Email isn’t connected yet. Add MAIL_USER and MAIL_PASSWORD in Railway → Variables.' });
  // Turn mail errors into something the landlord can act on, with the technical reason in brackets.
  const req_isSend = e => /smtp|ECONNECTION|greeting|CONN/i.test(`${e.code} ${e.command || ''} ${e.message}`);
  const mailError = (res, e) => {
    const why = [e.responseText, e.response, e.code, e.message].filter(Boolean).join(' / ').slice(0, 200);
    console.warn('Mail error:', why);
    let msg;
    if (e.authenticationFailed || e.code === 'EAUTH' || /auth|login|credential|password/i.test(why)) msg = `The mailbox refused to sign in. Check MAIL_USER is ${mail.address()} and MAIL_PASSWORD is the password you set in IONOS (no spaces before or after it).`;
    else if (e.code === 'ERESEND') msg = 'Resend didn’t accept the email. Check RESEND_API_KEY in Railway and that the domain is verified in Resend.';
    else if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|timeout|ESOCKET|ECONNECTION/i.test(why)) msg = req_isSend(e) ? 'Couldn’t connect to the outgoing mail server. Railway’s Hobby plan blocks sending email this way, so connect Resend (see the Email tab) to send.' : 'Couldn’t connect to the mail server. Try again in a moment.';
    else msg = 'The mailbox returned an error.';
    res.status(502).json({ error: `${msg} (${why})` });
  };
  admin.get('/mail/status', (req, res) => res.json({ enabled: mail.enabled(), address: mail.enabled() ? mail.address() : null, sendVia: process.env.RESEND_API_KEY ? 'resend' : 'smtp' }));
  admin.get('/mail/:folder', wrap(async (req, res) => {
    if (!mail.enabled()) return notSetUp(res);
    const folder = req.params.folder === 'sent' ? 'sent' : 'inbox';
    try { res.json({ messages: await mail.listMessages(folder, 60) }); } catch (e) { mailError(res, e); }
  }));
  admin.get('/mail/:folder/:uid', wrap(async (req, res) => {
    if (!mail.enabled()) return notSetUp(res);
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: 'That message can’t be opened.' });
    try {
      const m = await mail.readMessage(req.params.folder === 'sent' ? 'sent' : 'inbox', uid);
      m ? res.json(m) : res.status(404).json({ error: 'That message has gone. It may have been moved or deleted.' });
    } catch (e) { mailError(res, e); }
  }));
  // Attachments: pictures and PDFs open in the browser to preview; anything else downloads.
  admin.get('/mail/:folder/:uid/attachment/:index', wrap(async (req, res) => {
    if (!mail.enabled()) return notSetUp(res);
    const uid = Number(req.params.uid), index = Number(req.params.index);
    if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'That attachment can’t be opened.' });
    try {
      const a = await mail.getAttachment(req.params.folder === 'sent' ? 'sent' : 'inbox', uid, index);
      if (!a) return res.status(404).json({ error: 'That attachment has gone.' });
      const name = a.filename.replace(/[^\w.\- ()]+/g, '_').slice(0, 150) || 'attachment';
      const inline = a.previewable && req.query.download !== '1';
      res.setHeader('Content-Type', inline ? a.contentType : 'application/octet-stream');
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
      res.setHeader('Cache-Control', 'private, no-store');
      allowOwnViewer(res);
      res.send(a.content);
    } catch (e) { mailError(res, e); }
  }));
  admin.post('/mail/send', mailLimiter, wrap(async (req, res) => {
    if (!mail.enabled()) return notSetUp(res);
    const b = req.body || {};
    const to = String(b.to || '').split(/[,;]/).map(x => x.trim().replace(/^.*<([^>]+)>.*$/, '$1')).filter(Boolean);
    if (!to.length || to.length > 20 || !to.every(x => EMAIL.test(x))) return res.status(400).json({ error: 'Check the “To” address. Separate several with commas.' });
    const subject = clean(b.subject, 300), text = typeof b.text === 'string' ? b.text.slice(0, 50000) : '';
    if (!subject) return res.status(400).json({ error: 'Add a subject.' });
    const html = typeof b.html === 'string' ? b.html.slice(0, 300000) : '';
    if (!text.trim() && !html.replace(/<[^>]*>|&nbsp;/g, '').trim()) return res.status(400).json({ error: 'Write a message before sending.' });
    const inReplyTo = clean(b.inReplyTo, 500) || undefined;
    const references = Array.isArray(b.references) ? b.references.map(x => clean(x, 500)).filter(Boolean).slice(0, 20) : undefined;
    try { await mail.sendMail({ to, subject, text, html: html || undefined, inReplyTo, references }); res.json({ ok: true }); } catch (e) { mailError(res, e); }
  }));

  api.use('/admin', admin);
  api.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  return api;
}

/* ---------- start-up ---------- */
async function seedIfEmpty() {
  if ((await store.list('units')).length) return;
  await store.put('site', 'property', seed.property);
  await store.put('admin', 'wifi', seed.wifi);
  for (const u of seed.units) { const { id, ...data } = u; await store.put('units', id, data); }
  console.log(`Seeded ${seed.units.length} spaces and the property details.`);
}

// One-off data updates. Each runs once, and only changes text the landlord hasn't already edited.
const strip = d => { const { id, ...rest } = d; return rest; };
async function migrate() {
  const done = strip((await store.get('admin', 'migrations')) || { id: 'migrations' });
  if (!done['2026-10-local-rates']) {
    for (const id of ['5a', '5b']) {
      const u = await store.get('units', id);
      if (u && u.nearbyExtra == null && u.furtherExtra == null) await store.put('units', id, { ...strip(u), nearbyExtra: 25, furtherExtra: 50 });
    }
    const p = await store.get('site', 'property');
    if (p) {
      const d = strip(p);
      const oldTag = 'Rooms, workshops and storage to let in Kineton, from £250 a month with everything included.';
      const oldFeat = 'Rooms from £250 a month with everything included, for any kind of small business';
      if (d.tagline === oldTag) d.tagline = seed.property.tagline;
      if (Array.isArray(d.features)) d.features = d.features.map(x => (x === oldFeat ? seed.property.features[0] : x));
      await store.put('site', 'property', d);
    }
    done['2026-10-local-rates'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: local rates for Rooms 5A/5B and Kineton wording.');
  }
  if (!done['2026-10-unit5-service-charge']) {
    const u = await store.get('units', '5');
    if (u && u.serviceChargeAmount == null) await store.put('units', '5', { ...strip(u), serviceCharge: 'extra', serviceChargeAmount: 85 });
    done['2026-10-unit5-service-charge'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: Unit 5 service charge £85.');
  }
  if (!done['2026-10-1d-two-floors']) {
    const u = await store.get('units', '1d');
    const want = seed.units.find(x => x.id === '1d');
    if (u && !u.floors && want) await store.put('units', '1d', { ...strip(u), floors: want.floors, info: want.info, description: want.description, type: want.type, widthM: null, depthM: null });
    done['2026-10-1d-two-floors'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: Unit 1D shown as two floors.');
  }
  if (!done['2026-10-1d-low-ceiling']) {
    const u = await store.get('units', '1d');
    const want = seed.units.find(x => x.id === '1d');
    if (u && Array.isArray(u.floors)) {
      const floors = u.floors.map(f => ({ ...f, rooms: f.rooms.map(r => (r.name === 'Storage' && !r.note ? { ...r, note: 'Low ceiling, about 5 ft (1.5 m)' } : r)) }));
      const info = Array.isArray(u.info) && !u.info.some(x => /low ceiling/i.test(x)) ? want.info : u.info;
      await store.put('units', '1d', { ...strip(u), floors, info });
    }
    done['2026-10-1d-low-ceiling'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: 1D storage floor low ceiling note.');
  }
  if (!done['2026-10-percent-rates']) {
    for (const id of ['5a', '5b']) {
      const u = await store.get('units', id);
      if (u && Number(u.nearbyExtra) === 25 && Number(u.furtherExtra) === 50) { const { nearbyExtra, furtherExtra, ...rest } = strip(u); await store.put('units', id, rest); }
    }
    const p = await store.get('site', 'property');
    if (p) { const d = strip(p); d.localPricing = { ...(d.localPricing || {}), mode: 'percent', nearbyPct: 10, furtherPct: 20, roundTo: 5 }; await store.put('site', 'property', d); }
    done['2026-10-percent-rates'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: local rates by percentage (+10% / +20%).');
  }
  if (!done['2026-10-mill-rooms']) {
    for (const id of ['1a', '1b', '1c', '1d']) {
      const u = await store.get('units', id);
      if (!u) continue;
      const d = strip(u);
      if (d.name === `Unit ${d.code}`) d.name = `Mill Room ${d.code}`;
      if (Array.isArray(d.info)) d.info = d.info.map(x => x.replace(/with Unit 1([BC])/, 'with Mill Room 1$1'));
      await store.put('units', id, d);
    }
    const p = await store.get('site', 'property');
    if (p && typeof p.description === 'string') {
      const d = strip(p);
      d.description = d.description.replace('The four rooms in the mill building (Unit 1), Unit 2 and the small rooms 5A and 5B come with everything included', 'The four Mill Rooms (each let on its own), Unit 2 and the small rooms 5A and 5B come with everything included');
      await store.put('site', 'property', d);
    }
    done['2026-10-mill-rooms'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: Unit 1 renamed to the Mill Rooms.');
  }
  if (!done['2026-10-unit2-rates']) {
    const p = await store.get('site', 'property');
    if (p && typeof p.description === 'string') { const d = strip(p); d.description = d.description.replace('The four Mill Rooms (each let on its own), Unit 2', 'The four Mill Rooms, Unit 2'); await store.put('site', 'property', d); }
    const u = await store.get('units', '2');
    if (u && u.ratesIncluded == null) {
      const d = strip(u);
      d.ratesIncluded = false;
      if (Array.isArray(d.info) && !d.info.some(x => /business rates/i.test(x))) d.info.push('Tenant registers for business rates (Small Business Rate Relief may apply)');
      await store.put('units', '2', d);
    }
    done['2026-10-unit2-rates'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: Unit 2 business rates, shorter Mill Rooms wording.');
  }
  if (!done['2026-10-stable-block']) {
    const u = await store.get('units', '7');
    if (u && u.name === 'Unit 7') await store.put('units', '7', { ...strip(u), name: 'The Stable Block', shortName: 'Stable Block' });
    done['2026-10-stable-block'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: Unit 7 renamed The Stable Block.');
  }
  if (!done['2026-10-mr-codes']) {
    const MR = { '1a': ['MR-1', 'Mill Room 1'], '1b': ['MR-2', 'Mill Room 2'], '1c': ['MR-3', 'Mill Room 3'], '1d': ['MR-4', 'Mill Room 4'] };
    for (const [id, [code, name]] of Object.entries(MR)) {
      const u = await store.get('units', id);
      if (!u) continue;
      const d = strip(u);
      if (/^1[a-d]$/i.test(d.code || '')) { d.code = code; if (d.name === `Mill Room ${id.toUpperCase()}` || d.name === `Unit ${id.toUpperCase()}`) d.name = name; }
      if (Array.isArray(d.info)) d.info = d.info.map(x => x.replace('with Mill Room 1B', 'with MR-2').replace('with Mill Room 1C', 'with MR-3'));
      await store.put('units', id, d);
    }
    done['2026-10-mr-codes'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: Mill Rooms numbered MR-1 to MR-4.');
  }
  if (!done['2026-10-mr-letters']) {
    const MR = { '1a': 'A', '1b': 'B', '1c': 'C', '1d': 'D' };
    for (const [id, letter] of Object.entries(MR)) {
      const u = await store.get('units', id);
      if (!u) continue;
      const d = strip(u);
      if (/^MR-\d$/.test(d.code || '')) { if (d.name === `Mill Room ${d.code.slice(3)}`) d.name = `Mill Room ${letter}`; d.code = `MR-${letter}`; }
      if (Array.isArray(d.info)) d.info = d.info.map(x => x.replace('with MR-2', 'with MR-B').replace('with MR-3', 'with MR-C'));
      await store.put('units', id, d);
    }
    done['2026-10-mr-letters'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: Mill Rooms lettered MR-A to MR-D.');
  }
  if (!done['2026-10-mill-room-names']) {
    for (const id of ['1a', '1b', '1c', '1d']) {
      const u = await store.get('units', id), want = seed.units.find(x => x.id === id);
      if (!u || !want) continue;
      const d = strip(u);
      if (/^MR-[A-D]$/.test(d.code || '')) {
        Object.assign(d, { name: want.name, shortName: want.shortName, code: want.code });
        if (typeof d.description === 'string' && /Use it for whatever your business needs/.test(d.description)) d.description = want.description;
      }
      if (Array.isArray(d.info)) {
        d.info = d.info.map(x => x.replace('with MR-B', 'with the Loading Door').replace('with MR-C', 'with the Trapdoor Room'));
        if (id === '1d' && !d.info.some(x => /hoist/i.test(x))) d.info.splice(1, 0, 'Original chain and pulley hoist in the roof');
      }
      await store.put('units', id, d);
    }
    done['2026-10-mill-room-names'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: Mill Rooms named (Miller\'s Room, Loading Door, Trapdoor Room, Hoist Loft).');
  }
  if (!done['2026-10-mill-room-names-2']) {
    const rename = { '1a': ["The Miller's Room", 'Miller'], '1c': ['The Trapdoor Room', 'Hatch'], '1d': ['The Hoist Loft', 'Hoist Loft'] };
    for (const [id, [oldName, name]] of Object.entries(rename)) {
      const u = await store.get('units', id);
      if (!u) continue;
      const d = strip(u);
      if (d.name === oldName) Object.assign(d, { name, shortName: name, code: name });
      if (id === '1a' && typeof d.description === 'string') d.description = d.description.replace("The Miller's Room is the ground floor room", 'Miller is the ground floor room');
      await store.put('units', id, d);
    }
    const b = await store.get('units', '1b');
    if (b && Array.isArray(b.info)) await store.put('units', '1b', { ...strip(b), info: b.info.map(x => x.replace('with the Trapdoor Room', 'with Hatch')) });
    done['2026-10-mill-room-names-2'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: Mill Rooms renamed Miller, Hatch, Hoist Loft.');
  }
  if (!done['2026-10-winch']) {
    const b = await store.get('units', '1b');
    if (b && b.name === 'The Loading Door') await store.put('units', '1b', { ...strip(b), name: 'Winch', shortName: 'Winch', code: 'Winch' });
    const c = await store.get('units', '1c');
    if (c && Array.isArray(c.info)) await store.put('units', '1c', { ...strip(c), info: c.info.map(x => x.replace('with the Loading Door', 'with Winch')) });
    done['2026-10-winch'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: first floor small room named Winch.');
  }
  if (!done['2026-10-fodder-door-room']) {
    const b = await store.get('units', '1b');
    if (b && b.name === 'Winch') await store.put('units', '1b', { ...strip(b), name: 'Fodder', shortName: 'Fodder', code: 'Fodder' });
    const c = await store.get('units', '1c');
    if (c && Array.isArray(c.info)) await store.put('units', '1c', { ...strip(c), info: c.info.map(x => x.replace('with Winch', 'with Fodder')) });
    done['2026-10-fodder-door-room'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: first floor small room named Fodder.');
  }
  if (!done['2026-10-hatch-windows']) {
    const c = await store.get('units', '1c');
    if (c && typeof c.description === 'string') await store.put('units', '1c', { ...strip(c), description: c.description.replace('windows on two sides', 'two windows along one wall') });
    done['2026-10-hatch-windows'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: Hatch window wording.');
  }
  if (!done['2026-10-mill-room-flooring']) {
    const line = 'Flooring is chosen by the tenant: lay your own over the existing underlay, or replace it';
    for (const id of ['1a', '1b', '1c', '1d']) {
      const u = await store.get('units', id);
      if (u && Array.isArray(u.info) && !u.info.some(x => /flooring/i.test(x))) await store.put('units', id, { ...strip(u), info: [line, ...u.info] });
    }
    done['2026-10-mill-room-flooring'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: Mill Rooms flooring note.');
  }
  if (!done['2026-10-mill-room-photos']) {
    // New photos for Fodder, Hatch and Hoist Loft. Only replaces the old/placeholder sets, never ones the landlord has edited.
    for (const id of ['1b', '1c', '1d']) {
      const u = await store.get('units', id), want = seed.units.find(x => x.id === id);
      const old = u && (u.photos || []).map(p => (typeof p === 'string' ? '' : p.src || '')).join(',');
      if (u && want && (!old.replace(/,/g, '') || /1st-floor-(small|large)/.test(old))) await store.put('units', id, { ...strip(u), photos: want.photos });
    }
    done['2026-10-mill-room-photos'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: new Mill Room photos.');
  }
  if (!done['2026-10-local-within-6-miles']) {
    // Kineton and within 6 miles both pay the listed (best) price; only further afield pays more.
    const p = await store.get('site', 'property');
    if (p) { const d = strip(p); d.localPricing = { ...(d.localPricing || {}), nearbyPct: 0, nearbyExtra: 0 }; await store.put('site', 'property', d); }
    done['2026-10-local-within-6-miles'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: within 6 miles gets the local rate.');
  }
  if (!done['2026-10-remove-work-photos']) {
    // Take out photos showing ladders, tools or building work.
    const bad = ["img/hoist-loft-1.jpg", "img/hoist-loft-2.jpg", "img/hoist-loft-4.jpg", "img/hoist-loft-5.jpg", "img/hoist-loft-6.jpg", "img/img-1508.jpg"];
    for (const u of await store.list('units')) {
      if (!Array.isArray(u.photos)) continue;
      const keep = u.photos.filter(p => !(p && typeof p === 'object' && bad.includes(p.src)));
      if (keep.length !== u.photos.length) await store.put('units', u.id, { ...strip(u), photos: keep });
    }
    done['2026-10-remove-work-photos'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: removed photos with ladders and building work.');
  }
  if (!done['2026-10-remove-unit5-corner']) {
    const u = await store.get('units', '5');
    if (u && Array.isArray(u.photos)) await store.put('units', '5', { ...strip(u), photos: u.photos.filter(p => !(p && typeof p === 'object' && p.src === 'img/unit-5-3.jpg')) });
    done['2026-10-remove-unit5-corner'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: removed Unit 5 corner photo.');
  }
  if (!done['2026-10-postcode']) {
    const p = await store.get('site', 'property');
    if (p) { const d = strip(p); if (!d.postcode) d.postcode = 'CV35 0LA'; if (!d.county) d.county = 'Warwickshire'; await store.put('site', 'property', d); }
    done['2026-10-postcode'] = new Date().toISOString();
    await store.put('admin', 'migrations', done);
    console.log('Applied update: postcode CV35 0LA.');
  }
}

async function ensureLandlord() {
  const email = clean(process.env.ADMIN_EMAIL || '', 200).toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!email || !pw) {
    if (!(await store.listUsers()).some(u => u.role === 'landlord')) console.warn('No landlord account yet: set ADMIN_EMAIL and ADMIN_PASSWORD, then restart.');
    return;
  }
  if (pw.length < 10) { console.warn('ADMIN_PASSWORD must be at least 10 characters. Landlord account not created.'); return; }
  const existing = await store.userBy('email', email);
  if (!existing) {
    await store.saveUser({ id: newId(), email, role: 'landlord', passwordHash: await bcrypt.hash(pw, 12) });
    console.log(`Created the landlord account for ${email}.`);
  } else if (process.env.ADMIN_RESET_PASSWORD === 'true') {
    await store.saveUser({ ...existing, role: 'landlord', passwordHash: await bcrypt.hash(pw, 12) });
    console.log(`Reset the landlord password for ${email}. Remove ADMIN_RESET_PASSWORD now.`);
  }
}

// The secret that signs sign-in cookies. Uses SESSION_SECRET if set, otherwise makes one and keeps it in the database.
let VIEW_SALT = 'oldmill-views';
// Keys that let this site send push notifications, made once and kept in the database.
let VAPID = { publicKey: '', privateKey: '' };
async function setupPush() {
  let k = await store.get('admin', 'vapid');
  if (!k || !k.publicKey) { const g = webpush.generateVAPIDKeys(); k = { publicKey: g.publicKey, privateKey: g.privateKey }; await store.put('admin', 'vapid', k); }
  VAPID = { publicKey: k.publicKey, privateKey: k.privateKey };
  webpush.setVapidDetails(`mailto:${process.env.MAIL_USER || process.env.ADMIN_EMAIL || 'hello@theoldmillkineton.co.uk'}`, VAPID.publicKey, VAPID.privateKey);
}
const subId = endpoint => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 32);
const validSub = sub => !!(sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.keys && sub.keys.p256dh && sub.keys.auth);
// Sends to every device the landlord has turned notifications on for; forgets devices that have gone.
const notifyLandlord = (msg, report) => pushTo('pushsubs', () => true, msg, report);
// Sends a message notification to one tenant (or 'all'), skipping anyone whose tenancy has ended.
async function notifyTenants(to, msg) {
  const current = new Set((await store.list('tenants')).filter(t => t.status !== 'former').map(t => t.id));
  return pushTo('tenantpush', s => current.has(s.tenantId) && (to === 'all' || s.tenantId === to), msg);
}
async function pushTo(col, wanted, msg, report) {
  if (!VAPID.publicKey) return 0;
  let sent = 0;
  for (const s of (await store.list(col)).filter(wanted)) {
    const where = (s.endpoint.match(/^https:\/\/([^/]+)/) || [])[1] || '?';
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(msg), { TTL: 86400, urgency: 'high' }); sent++; if (report) report.push({ device: s.device, service: where, ok: true }); }
    catch (e) {
      const why = `${e.statusCode || ''} ${(e.body || e.message || '').toString().slice(0, 200)}`.trim();
      console.warn('Push not sent:', where, why);
      if (report) report.push({ device: s.device, service: where, ok: false, error: why });
      if (e.statusCode === 404 || e.statusCode === 410) await store.del(col, s.id);
    }
  }
  return sent;
}
async function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const saved = await store.get('admin', 'session-secret');
  if (saved && saved.value) return saved.value;
  const value = crypto.randomBytes(48).toString('base64url');
  await store.put('admin', 'session-secret', { value });
  return value;
}

/* ---------- public pages, SEO and crawl files ---------- */
const BASE = (process.env.PUBLIC_URL || 'https://www.theoldmillkineton.co.uk').replace(/\/$/, '');
const BASE_HOST = new URL(BASE).hostname;
const escHtml = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ldJson = obj => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

async function publicState() {
  const units = (await store.list('units')).map(publicUnit);
  return { S: { property: publicProperty(await property()), units, wifi: { networks: [] }, tenants: [], invoices: [], messages: [], enquiries: [], outbox: [], views: [] } };
}

function localBusiness(P, units) {
  const prices = units.filter(u => u.status !== 'let' && u.rent).map(u => Number(u.rent));
  const parts = String(P.address || '').split(',').map(x => x.trim()).filter(Boolean);
  const phone = String(P.phone || '').replace(/\s+/g, '');
  return {
    '@context': 'https://schema.org', '@type': 'LocalBusiness', '@id': `${BASE}/#business`,
    name: P.name || 'The Old Mill', url: `${BASE}/`,
    description: 'Offices, rooms, workshops and storage to let at The Old Mill, Mill Lane, Kineton.',
    image: [`${BASE}/img/the-old-mill.jpg`], logo: `${BASE}/img/logo-440.png`,
    ...(phone ? { telephone: phone.replace(/^0/, '+44') } : {}),
    ...(P.email ? { email: P.email } : {}),
    address: { '@type': 'PostalAddress', streetAddress: parts[0] || 'Mill Lane', addressLocality: parts[1] || 'Kineton', ...(P.county ? { addressRegion: P.county } : {}), ...(P.postcode ? { postalCode: P.postcode } : {}), addressCountry: 'GB' },
    ...(P.postcode ? { geo: { '@type': 'GeoCoordinates', latitude: MILL.lat, longitude: MILL.lng } } : {}),
    areaServed: 'Kineton, Warwickshire',
    ...(prices.length ? { priceRange: `£${Math.min(...prices)}–£${Math.max(...prices)} per month` } : {})
  };
}
const breadcrumbs = crumbs => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: crumbs.map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${BASE}${p}` })) });

function fillTemplate({ title, description, canonical, robots, image, ld = [], body = '', tierbar = '' }) {
  let h = ssr.template()
    .replace(/<title>[^<]*<\/title>/, `<title>${escHtml(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, description ? `<meta name="description" content="${escHtml(description)}">` : '');
  const img = image ? `${BASE}/${String(image).replace(/^\//, '')}` : `${BASE}/img/the-old-mill.jpg`;
  const tags = [
    canonical && `<link rel="canonical" href="${escHtml(canonical)}">`,
    robots && `<meta name="robots" content="${robots}">`,
    `<meta property="og:site_name" content="The Old Mill, Kineton">`, `<meta property="og:locale" content="en_GB">`, `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escHtml(title)}">`, description && `<meta property="og:description" content="${escHtml(description)}">`,
    canonical && `<meta property="og:url" content="${escHtml(canonical)}">`, `<meta property="og:image" content="${escHtml(img)}">`,
    `<meta name="twitter:card" content="summary_large_image">`, `<meta name="twitter:title" content="${escHtml(title)}">`,
    description && `<meta name="twitter:description" content="${escHtml(description)}">`, `<meta name="twitter:image" content="${escHtml(img)}">`,
    ...ld.map(ldJson)
  ].filter(Boolean).join('\n');
  h = h.replace('</head>', `${tags}\n</head>`);
  if (body) h = h.replace('<main id="app"></main>', `<main id="app" data-ssr="1">${body}</main>`);
  if (tierbar) h = h.replace('<div id="tierbar" hidden></div>', `<div id="tierbar">${tierbar}</div>`);
  return h;
}

async function sendPage(req, res, route, status = 200) {
  const state = { ...(await publicState()), ...route };
  const r = ssr.render(state);
  const m = r.meta, notFound = status === 404 || m.notFound;
  if (!notFound && route.view === 'unit' && req.path !== m.path) return res.redirect(301, m.path); // old or id-based link → its proper address
  const offHost = req.hostname !== BASE_HOST; // e.g. the railway.app address: point Google at www instead
  if (offHost || notFound) res.setHeader('X-Robots-Tag', 'noindex');
  const ld = [];
  if (route.view === 'site') ld.push(localBusiness(state.S.property, state.S.units));
  if (m.crumbs) ld.push(breadcrumbs(m.crumbs));
  res.status(notFound ? 404 : 200).type('html').setHeader('Cache-Control', 'no-cache');
  res.send(fillTemplate({ title: notFound && route.view === 'site' ? 'Page not found | The Old Mill' : m.title, description: m.description,
    canonical: notFound ? '' : `${BASE}${m.path}`, robots: notFound ? 'noindex' : '', image: m.image, ld, body: r.html, tierbar: r.tierbar }));
}

function publicPages() {
  const page = route => wrap(async (req, res) => sendPage(req, res, typeof route === 'function' ? route(req) : route));
  app.get('/', page({ view: 'site' }));
  app.get('/rooms', page({ view: 'cat', curCat: 'rooms' }));
  app.get('/workshops', page({ view: 'cat', curCat: 'workshops' }));
  app.get('/storage', page({ view: 'cat', curCat: 'storage' }));
  app.get('/spaces/:slug', page(req => ({ view: 'unit', curUnit: String(req.params.slug).toLowerCase() })));
  // Private areas: the page loads as before but is kept out of search results.
  app.get(['/tenant', '/landlord', '/invite'], (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(fillTemplate({ title: req.path === '/landlord' ? 'Landlord | The Old Mill' : req.path === '/invite' ? 'Set up your account | The Old Mill' : 'Tenant portal | The Old Mill', robots: 'noindex, nofollow' }));
  });
  // Tenant guides linked from the tenant portal: the Rointe heaters and the house rules.
  for (const [route, file] of [['/heaters', 'heaters.html'], ['/house-rules', 'house-rules.html']]) {
    app.get(route, (req, res) => {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(__dirname, 'public', file));
    });
  }
  app.get('/robots.txt', (req, res) => res.type('text/plain').send(['User-agent: *', 'Allow: /', 'Disallow: /tenant', 'Disallow: /landlord', 'Disallow: /invite', 'Disallow: /heaters', 'Disallow: /house-rules', 'Disallow: /api/', '', `Sitemap: ${BASE}/sitemap.xml`, ''].join('\n')));
  app.get('/sitemap.xml', wrap(async (req, res) => {
    const p = ssr.paths(await publicState());
    const urls = ['/', ...p.cats, ...p.units.map(u => u.path)];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${escHtml(BASE + u)}</loc></url>`).join('\n')}\n</urlset>\n`);
  }));
  // WebP photos: if a .webp version hasn't been made for a photo yet, send the original instead.
  app.get(/^\/img\/([\w-]+?)(-600)?\.webp$/, (req, res, next) => {
    if (fs.existsSync(path.join(__dirname, 'public', req.path))) return next();
    const jpg = ['.jpg', '.jpeg'].map(x => `/img/${req.params[0]}${x}`).find(x => fs.existsSync(path.join(__dirname, 'public', x)));
    jpg ? res.redirect(302, jpg) : next();
  });
}

async function main() {
  await store.init();
  await seedIfEmpty();
  await migrate();
  await ensureLandlord();
  VIEW_SALT = 'views:' + (await sessionSecret());
  await setupPush();

  app.use(session({
    name: 'oldmill.sid',
    secret: await sessionSecret(),
    store: sessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 30 * 864e5 }
  }));
  app.use('/api', (req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex'); next(); }, routes());
  publicPages();
  // Pages, scripts and styles are re-checked on every visit so updates show at once; photos can be cached for a day.
  app.use(express.static(path.join(__dirname, 'public'), {
    index: false,
    setHeaders: (res, file) => res.setHeader('Cache-Control', /\/img\//.test(file) && PROD ? 'public, max-age=86400' : 'no-cache')
  }));
  app.use((req, res) => sendPage(req, res, { view: 'site' }, 404));
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too big. The limit is 15 MB.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Try again in a moment.' });
  });
  app.listen(PORT, () => console.log(`The Old Mill is running on port ${PORT}`));
}

main().catch(err => { console.error(err); process.exit(1); });
