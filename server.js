// The Old Mill: public website, tenant portal and landlord admin in one small Express app.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { createStore } = require('./src/store');
const seed = require('./src/seed.json');

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
    if (!enq.name) return res.status(400).json({ error: 'Add your name to continue.' });
    if (!EMAIL.test(enq.email)) return res.status(400).json({ error: 'Enter a full email address, like name@business.co.uk.' });
    const free = units.some(u => u.status === 'available' && matchesInterest(enq.interest, u));
    enq.status = free ? 'new' : 'waitlist';
    enq.createdAt = new Date().toISOString();
    await store.put('enquiries', newId(), enq);
    res.json({ status: enq.status });
  }));

  /* tenant */
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
      wifi: { networks: nets }
    });
  }));

  /* landlord */
  const admin = express.Router();
  admin.use(needLandlord);

  admin.get('/data', wrap(async (req, res) => {
    const out = { property: await property(), wifi: await wifi() };
    for (const c of ADMIN_COLLECTIONS) out[c] = await store.list(c);
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
    await store.put(col, id, data);
    res.json({ ok: true });
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
    res.json({ ok: true });
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
async function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const saved = await store.get('admin', 'session-secret');
  if (saved && saved.value) return saved.value;
  const value = crypto.randomBytes(48).toString('base64url');
  await store.put('admin', 'session-secret', { value });
  return value;
}

async function main() {
  await store.init();
  await seedIfEmpty();
  await ensureLandlord();

  app.use(session({
    name: 'oldmill.sid',
    secret: await sessionSecret(),
    store: sessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 30 * 864e5 }
  }));
  app.use('/api', routes());
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '1h' : 0, index: 'index.html' }));
  app.get(['/invite', '/'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. Try again in a moment.' });
  });
  app.listen(PORT, () => console.log(`The Old Mill is running on port ${PORT}`));
}

main().catch(err => { console.error(err); process.exit(1); });
