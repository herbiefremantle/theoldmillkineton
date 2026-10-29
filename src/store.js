// Storage for The Old Mill.
// In production (DATABASE_URL set, e.g. on Railway) everything lives in Postgres.
// Locally, without a database, it falls back to a JSON file in ./data so the app still runs.

const fs = require('fs');
const path = require('path');

// Records are stored as JSON documents grouped by collection, the same shape the front end uses.
// "site/property" holds the property details and "admin/wifi" the Wi-Fi networks.
const COLLECTIONS = ['units', 'tenants', 'invoices', 'messages', 'enquiries', 'outbox', 'site', 'admin', 'views', 'pushsubs', 'tenantpush'];

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    const local = /localhost|127\.0\.0\.1/.test(url);
    this.pool = new Pool({ connectionString: url, ssl: local || /\.railway\.internal/.test(url) ? false : { rejectUnauthorized: false } });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS docs (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, id)
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        role TEXT NOT NULL CHECK (role IN ('landlord', 'tenant')),
        tenant_id TEXT,
        invite_token_hash TEXT,
        invite_expires TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );`);
  }

  // Documents uploaded for a tenant (e.g. the signed agreement). Listing never loads the file contents.
  async listFiles() {
    const r = await this.pool.query('SELECT id, tenant_id, name, mime, size, created_at FROM files ORDER BY created_at DESC');
    return r.rows.map(fileRow);
  }
  async getFile(id) {
    const r = await this.pool.query('SELECT * FROM files WHERE id = $1', [id]);
    return r.rows[0] ? { ...fileRow(r.rows[0]), data: r.rows[0].data } : null;
  }
  async putFile(f, data) {
    await this.pool.query('INSERT INTO files (id, tenant_id, name, mime, size, data) VALUES ($1, $2, $3, $4, $5, $6)', [f.id, f.tenantId, f.name, f.mime, data.length, data]);
  }
  async delFile(id) {
    await this.pool.query('DELETE FROM files WHERE id = $1', [id]);
  }

  async list(collection) {
    const r = await this.pool.query('SELECT id, data FROM docs WHERE collection = $1 ORDER BY id', [collection]);
    return r.rows.map(row => ({ id: row.id, ...row.data }));
  }
  async get(collection, id) {
    const r = await this.pool.query('SELECT data FROM docs WHERE collection = $1 AND id = $2', [collection, id]);
    return r.rows[0] ? { id, ...r.rows[0].data } : null;
  }
  async put(collection, id, data) {
    await this.pool.query(
      `INSERT INTO docs (collection, id, data) VALUES ($1, $2, $3)
       ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [collection, id, JSON.stringify(data)]);
  }
  async del(collection, id) {
    await this.pool.query('DELETE FROM docs WHERE collection = $1 AND id = $2', [collection, id]);
  }

  async userBy(field, value) {
    const col = { id: 'id', email: 'email', tenantId: 'tenant_id', invite: 'invite_token_hash' }[field];
    const r = await this.pool.query(`SELECT * FROM users WHERE ${col} = $1 LIMIT 1`, [value]);
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }
  async listUsers() {
    const r = await this.pool.query('SELECT * FROM users ORDER BY created_at');
    return r.rows.map(fromRow);
  }
  async saveUser(u) {
    await this.pool.query(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, invite_token_hash, invite_expires)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET email = $2, password_hash = $3, role = $4, tenant_id = $5,
         invite_token_hash = $6, invite_expires = $7`,
      [u.id, u.email, u.passwordHash || null, u.role, u.tenantId || null, u.inviteTokenHash || null, u.inviteExpires || null]);
  }
  async deleteUser(id) {
    await this.pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
}

function fileRow(r) {
  return { id: r.id, tenantId: r.tenant_id, name: r.name, mime: r.mime, size: r.size, createdAt: new Date(r.created_at).toISOString() };
}
function fromRow(r) {
  return {
    id: r.id, email: r.email, passwordHash: r.password_hash, role: r.role, tenantId: r.tenant_id,
    inviteTokenHash: r.invite_token_hash, inviteExpires: r.invite_expires ? new Date(r.invite_expires).toISOString() : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null
  };
}

class FileStore {
  constructor(file) {
    this.file = file;
  }
  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { docs: {}, users: [] };
    this.db.files = this.db.files || [];
    this.dir = path.join(path.dirname(this.file), 'files');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  async listFiles() {
    return [...this.db.files].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getFile(id) {
    const f = this.db.files.find(x => x.id === id);
    return f ? { ...f, data: fs.readFileSync(path.join(this.dir, id)) } : null;
  }
  async putFile(f, data) {
    fs.writeFileSync(path.join(this.dir, f.id), data);
    this.db.files.push({ id: f.id, tenantId: f.tenantId, name: f.name, mime: f.mime, size: data.length, createdAt: new Date().toISOString() });
    this.save();
  }
  async delFile(id) {
    this.db.files = this.db.files.filter(x => x.id !== id);
    fs.rmSync(path.join(this.dir, id), { force: true });
    this.save();
  }
  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.db, null, 1));
  }
  async list(collection) {
    const c = this.db.docs[collection] || {};
    return Object.keys(c).sort().map(id => ({ id, ...c[id] }));
  }
  async get(collection, id) {
    const d = (this.db.docs[collection] || {})[id];
    return d ? { id, ...d } : null;
  }
  async put(collection, id, data) {
    (this.db.docs[collection] = this.db.docs[collection] || {})[id] = data;
    this.save();
  }
  async del(collection, id) {
    if (this.db.docs[collection]) delete this.db.docs[collection][id];
    this.save();
  }
  async userBy(field, value) {
    const key = { id: 'id', email: 'email', tenantId: 'tenantId', invite: 'inviteTokenHash' }[field];
    return this.db.users.find(u => u[key] === value) || null;
  }
  async listUsers() {
    return [...this.db.users];
  }
  async saveUser(u) {
    const i = this.db.users.findIndex(x => x.id === u.id);
    const row = { createdAt: new Date().toISOString(), ...(i >= 0 ? this.db.users[i] : {}), ...u };
    if (i >= 0) this.db.users[i] = row; else this.db.users.push(row);
    this.save();
  }
  async deleteUser(id) {
    this.db.users = this.db.users.filter(u => u.id !== id);
    this.save();
  }
}

function createStore() {
  if (process.env.DATABASE_URL) return new PgStore(process.env.DATABASE_URL);
  return new FileStore(path.join(__dirname, '..', 'data', 'dev-db.json'));
}

module.exports = { createStore, COLLECTIONS };
