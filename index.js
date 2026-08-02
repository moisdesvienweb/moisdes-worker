// ================================================================
// MOISDES WORKER — single Cloudflare Worker backing the whole
// Moisdes Vien platform: auth, content CRUD, R2 presigning, forms.
// Bindings: env.DB (D1 "moisdes-db"), env.R2 (R2 "moisdes-media")
// Secrets:  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID
// ================================================================

const VERSION = '1.0.0';
const BUCKET_NAME = 'moisdes-media';
const SESSION_DAYS = 30;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function withCORSHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ── CRYPTO HELPERS (Web Crypto — no node:crypto in Workers) ─────────

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBuf(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}
function randomToken() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return `pbkdf2$100000$${bufToHex(salt)}$${bufToHex(bits)}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4) return false;
  const [, iterStr, saltHex, hashHex] = parts;
  const salt = hexToBuf(saltHex);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: parseInt(iterStr, 10), hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bufToHex(bits) === hashHex;
}

async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data)));
}

async function sha256Hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return bufToHex(buf);
}

// ── D1 AUTO-MIGRATIONS ───────────────────────────────────────────────

const CONTENT_SCHEMAS = {
  posts: `CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT, title TEXT, body TEXT, folder_url TEXT, tags TEXT, category TEXT,
    uploaded_by INTEGER, created_at TEXT DEFAULT (datetime('now')), deleted_at TEXT
  )`,
  posters: `CREATE TABLE IF NOT EXISTS posters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT, parsha TEXT, folder_url TEXT,
    uploaded_by INTEGER, created_at TEXT DEFAULT (datetime('now')), deleted_at TEXT
  )`,
  events: `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT, title TEXT, location TEXT, category TEXT, description TEXT, tags TEXT, folder_url TEXT,
    uploaded_by INTEGER, created_at TEXT DEFAULT (datetime('now')), deleted_at TEXT
  )`,
  videos: `CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT, title TEXT, location TEXT, category TEXT, description TEXT, tags TEXT, video_url TEXT, folder_url TEXT,
    uploaded_by INTEGER, created_at TEXT DEFAULT (datetime('now')), deleted_at TEXT
  )`,
  pdfs: `CREATE TABLE IF NOT EXISTS pdfs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT, title TEXT, category TEXT, language TEXT, parsha TEXT, year TEXT, pdf_url TEXT, thumb_url TEXT,
    uploaded_by INTEGER, created_at TEXT DEFAULT (datetime('now')), deleted_at TEXT
  )`,
  simchas: `CREATE TABLE IF NOT EXISTS simchas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT, date_added TEXT DEFAULT (datetime('now')),
    uploaded_by INTEGER, created_at TEXT DEFAULT (datetime('now')), deleted_at TEXT
  )`,
};

const CONTENT_MIGRATIONS = {
  posts: ['tags TEXT', 'category TEXT', 'folder_url TEXT', 'deleted_at TEXT'],
  posters: ['folder_url TEXT', 'deleted_at TEXT'],
  events: ['tags TEXT', 'folder_url TEXT', 'thumb_url TEXT', 'deleted_at TEXT'],
  videos: ['tags TEXT', 'video_url TEXT', 'folder_url TEXT', 'video_file_url TEXT', 'deleted_at TEXT'],
  pdfs: ['language TEXT', 'parsha TEXT', 'year TEXT', 'thumb_url TEXT', 'deleted_at TEXT'],
  simchas: ['deleted_at TEXT'],
};

const CONTENT_FIELDS = {
  posts: ['date', 'title', 'body', 'folder_url', 'tags', 'category'],
  posters: ['date', 'parsha', 'folder_url'],
  events: ['date', 'title', 'location', 'category', 'description', 'tags', 'folder_url', 'thumb_url'],
  videos: ['date', 'title', 'location', 'category', 'description', 'tags', 'video_url', 'folder_url', 'video_file_url'],
  pdfs: ['date', 'title', 'category', 'language', 'parsha', 'year', 'pdf_url', 'thumb_url'],
  simchas: ['text', 'date_added'],
};

async function ensureContentTable(table, env) {
  await env.DB.prepare(CONTENT_SCHEMAS[table]).run();
  for (const col of CONTENT_MIGRATIONS[table] || []) {
    try {
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col}`).run();
    } catch (e) {
      /* column already exists — ignore */
    }
  }
}

const SUPERADMIN_EMAIL = 'tulib.vien@gmail.com';
const OUR_USER_COLUMNS = ['id', 'name', 'email', 'password_hash', 'role', 'active', 'created_at'];

// A pre-existing `users` table (see project notes) may enforce NOT NULL
// columns we don't use (e.g. a legacy `password` column with no default).
// Returns {column: placeholder} pairs to splice into any INSERT so it
// doesn't fail a constraint it doesn't know about.
async function legacyRequiredUserColumns(env, placeholder) {
  const { results } = await env.DB.prepare('PRAGMA table_info(users)').all();
  const extra = {};
  for (const col of results) {
    if (col.notnull && col.dflt_value === null && !OUR_USER_COLUMNS.includes(col.name)) {
      extra[col.name] = placeholder;
    }
  }
  return extra;
}

async function insertUser(env, { name, email, hash, role }) {
  const extra = await legacyRequiredUserColumns(env, hash);
  const cols = ['name', 'email', 'password_hash', 'role', 'active', ...Object.keys(extra)];
  const vals = [name, email, hash, role, 1, ...Object.values(extra)];
  return env.DB.prepare(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .bind(...vals).run();
}

async function ensureCoreTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    password_hash TEXT,
    role TEXT DEFAULT 'editor',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  // The D1 database may pre-date this schema (see project notes) — patch
  // in any columns an older users table might be missing.
  for (const col of ['name TEXT', "password_hash TEXT", "role TEXT DEFAULT 'editor'", 'active INTEGER DEFAULT 1', "created_at TEXT DEFAULT (datetime('now'))"]) {
    try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); } catch (e) { /* column already exists */ }
  }

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER,
    expires_at TEXT
  )`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE
  )`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE
  )`).run();

  // Seed (or repair) the superadmin by email, not by "is the table empty" —
  // a pre-existing D1 database may already have unrelated user rows.
  const existing = await env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?').bind(SUPERADMIN_EMAIL).first();
  if (!existing) {
    const hash = await hashPassword('buchinger12');
    await insertUser(env, { name: 'Superadmin', email: SUPERADMIN_EMAIL, hash, role: 'superadmin' });
  } else if (!existing.password_hash) {
    // Row exists (e.g. from an older/partial schema) but has no usable password yet.
    const hash = await hashPassword('buchinger12');
    await env.DB.prepare("UPDATE users SET password_hash = ?, role = 'superadmin', active = 1 WHERE id = ?")
      .bind(hash, existing.id).run();
  }
}

async function ensureFormsTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS forms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, slug TEXT UNIQUE, settings TEXT,
    created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), deleted_at TEXT
  )`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS form_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_id INTEGER, type TEXT, label TEXT, placeholder TEXT, options TEXT,
    required INTEGER DEFAULT 0, field_order INTEGER DEFAULT 0, settings TEXT
  )`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS form_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_id INTEGER, submitted_at TEXT DEFAULT (datetime('now')), metadata TEXT, read_at TEXT
  )`).run();
  // A pre-existing DB won't have read_at from before this feature existed.
  try { await env.DB.prepare('ALTER TABLE form_responses ADD COLUMN read_at TEXT').run(); } catch (e) { /* column already exists */ }

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS form_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    response_id INTEGER, field_id INTEGER, value TEXT
  )`).run();
}

async function ensureDafTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS daf_entries (
    date TEXT PRIMARY KEY,
    text TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
}

// Generic key/value store for small site-wide settings (e.g. the
// newsletter signup link) that don't need their own dedicated table.
async function ensureSettingsTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`).run();
}

async function ensureAnalyticsTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT,
    path TEXT,
    label TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
}

// Per-user, per-section read/write flags for 'editor' role accounts.
// 'admin'/'superadmin' bypass this entirely (see getEffectivePermissions)
// — it only narrows what an editor can see/do in the admin panel. A
// section with no row here defaults to no access (opt-in, not opt-out),
// so a freshly created editor starts locked out of everything until an
// admin explicitly grants sections.
async function ensurePermissionsTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_permissions (
    user_id INTEGER NOT NULL,
    section TEXT NOT NULL,
    can_read INTEGER DEFAULT 0,
    can_write INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, section)
  )`).run();
}

let migrated = false;
async function ensureAllTables(env) {
  if (migrated) return;
  await ensureCoreTables(env);
  for (const t of Object.keys(CONTENT_SCHEMAS)) await ensureContentTable(t, env);
  await ensureFormsTables(env);
  await ensureDafTable(env);
  await ensureSettingsTable(env);
  await ensureAnalyticsTable(env);
  await ensurePermissionsTable(env);
  migrated = true;
}

// ── AUTH ──────────────────────────────────────────────────────────────

async function createSession(userId, env) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').bind(token, userId, expires).run();
  return { token, expires };
}

function bearerToken(request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer (.+)$/);
  return m ? m[1] : null;
}

async function getUserFromRequest(request, env) {
  const token = bearerToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.active, u.created_at, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`
  ).bind(token).first();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  if (!row.active) return null;
  delete row.expires_at;
  return row;
}

function requireUser(user) {
  if (!user) throw new HttpError('Unauthorized', 401);
  return user;
}
function requireAdmin(user) {
  requireUser(user);
  if (user.role !== 'admin' && user.role !== 'superadmin') throw new HttpError('Forbidden', 403);
  return user;
}

// Every admin-panel section an editor's access can be scoped to. "users"
// (creating/editing accounts and granting permissions) is deliberately
// left out — that stays admin/superadmin-only, not delegable, since it's
// the one section that could otherwise be used to self-escalate.
const SECTIONS = ['posts', 'posters', 'events', 'videos', 'pdfs', 'simchas', 'forms', 'daf', 'settings'];

// admin/superadmin always get full read+write on every section; an
// 'editor' gets exactly what's stored for them in user_permissions (no
// row for a section = no access to that section).
async function getEffectivePermissions(env, user) {
  const fullAccess = user.role === 'admin' || user.role === 'superadmin';
  const perms = {};
  for (const s of SECTIONS) perms[s] = { read: fullAccess, write: fullAccess };
  if (fullAccess) return perms;
  const { results } = await env.DB.prepare(
    'SELECT section, can_read, can_write FROM user_permissions WHERE user_id = ?'
  ).bind(user.id).all();
  for (const row of results) {
    if (perms[row.section]) perms[row.section] = { read: !!row.can_read, write: !!row.can_write };
  }
  return perms;
}

async function requireSection(env, user, section, mode) {
  requireUser(user);
  const perms = await getEffectivePermissions(env, user);
  if (!perms[section] || !perms[section][mode]) {
    throw new HttpError(`You don't have ${mode} access to ${section}`, 403);
  }
}

// ── HANDLERS: core ────────────────────────────────────────────────────

async function handlePing() {
  return json({ ok: true, version: VERSION });
}

async function handleLogin({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) throw new HttpError('Missing email or password', 400);

  const row = await env.DB.prepare('SELECT * FROM users WHERE email = ? AND active = 1').bind(email).first();
  if (!row) throw new HttpError('Invalid credentials', 401);
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) throw new HttpError('Invalid credentials', 401);

  const { token, expires } = await createSession(row.id, env);
  // SELECT * also picks up any legacy columns (e.g. an old `password` field) —
  // only return the columns the client actually needs.
  const user = { id: row.id, name: row.name, email: row.email, role: row.role, active: row.active, created_at: row.created_at };
  const permissions = await getEffectivePermissions(env, user);
  return json({ token, expires, user, permissions });
}

async function handleLogout({ request, env }) {
  const token = bearerToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  return json({ ok: true });
}

async function handleMe({ env, user }) {
  requireUser(user);
  const permissions = await getEffectivePermissions(env, user);
  return json({ user, permissions });
}

async function handleRefresh({ request, env, user }) {
  requireUser(user);
  const token = bearerToken(request);
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').bind(expires, token).run();
  const permissions = await getEffectivePermissions(env, user);
  return json({ token, expires, user, permissions });
}

async function handleListUsers({ env, user }) {
  requireAdmin(user);
  const { results } = await env.DB.prepare(
    'SELECT id,name,email,role,active,created_at FROM users ORDER BY id'
  ).all();
  return json({ users: results });
}

async function handleGetUserPermissions({ match, env, user }) {
  requireAdmin(user);
  const targetId = Number(match[1]);
  const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(targetId).first();
  if (!target) throw new HttpError('User not found', 404);
  const permissions = await getEffectivePermissions(env, { id: targetId, role: target.role });
  return json({ role: target.role, permissions });
}

async function handleSetUserPermissions({ match, request, env, user }) {
  requireAdmin(user);
  const targetId = Number(match[1]);
  const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(targetId).first();
  if (!target) throw new HttpError('User not found', 404);
  const body = await request.json().catch(() => ({}));
  const permissions = body.permissions || {};
  for (const section of SECTIONS) {
    const p = permissions[section] || {};
    await env.DB.prepare(
      `INSERT INTO user_permissions (user_id, section, can_read, can_write) VALUES (?,?,?,?)
       ON CONFLICT(user_id, section) DO UPDATE SET can_read = excluded.can_read, can_write = excluded.can_write`
    ).bind(targetId, section, p.read ? 1 : 0, p.write ? 1 : 0).run();
  }
  return json({ ok: true });
}

async function handleSetUserPassword({ match, request, env, user }) {
  requireAdmin(user);
  const targetId = Number(match[1]);
  const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(targetId).first();
  if (!target) throw new HttpError('User not found', 404);
  const body = await request.json().catch(() => ({}));
  const password = String(body.password || '');
  if (password.length < 6) throw new HttpError('Password must be at least 6 characters', 400);
  const hash = await hashPassword(password);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, targetId).run();
  // Any existing sessions were signed against this account before the
  // password changed — drop them so a password reset actually locks out
  // whoever had the old one, instead of leaving old sessions valid.
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetId).run();
  return json({ ok: true });
}

async function handleCreateUser({ request, env, user }) {
  requireAdmin(user);
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const role = String(body.role || 'editor');
  if (!name || !email || !password) throw new HttpError('Missing required fields', 400);

  const hash = await hashPassword(password);
  try {
    const res = await insertUser(env, { name, email, hash, role });
    return json({ ok: true, id: res.meta.last_row_id });
  } catch (e) {
    throw new HttpError('A user with that email already exists', 409);
  }
}

// ── HANDLERS: content (posts/posters/events/videos/pdfs) ──────────────

async function saveNewTaxonomy(body, env) {
  if (body.tags) {
    const names = String(body.tags).split(',').map((s) => s.trim()).filter(Boolean);
    for (const n of names) {
      await env.DB.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').bind(n).run().catch(() => {});
    }
  }
  if (body.category) {
    await env.DB.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)')
      .bind(String(body.category).trim()).run().catch(() => {});
  }
}

const ORDER_COLUMN = { simchas: 'date_added' };

async function handleListContent({ match, url, env, user }) {
  const table = match[1];
  const orderCol = ORDER_COLUMN[table] || 'date';
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY ${orderCol} DESC, id DESC`
  ).all();

  // Who uploaded each item is admin-only info — attach it only for an
  // authenticated request that actually has read access to this section.
  // This same endpoint also serves the public site's pages (unauthenticated,
  // no `user`), which must never see it — so the attribution is fetched
  // and merged in only inside this gated branch, never unconditionally.
  if (user) {
    try {
      await requireSection(env, user, table, 'read');
      const ids = [...new Set(results.map((r) => r.uploaded_by).filter(Boolean))];
      if (ids.length) {
        const { results: uploaders } = await env.DB.prepare(
          `SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`
        ).bind(...ids).all();
        const nameById = Object.fromEntries(uploaders.map((u) => [u.id, u.name]));
        for (const r of results) r.uploaded_by_name = nameById[r.uploaded_by] || null;
      }
    } catch (e) { /* not authorized for this section — no attribution attached */ }
  }

  if (url.searchParams.get('format') === 'csv') {
    const cols = ['id', ...CONTENT_FIELDS[table]];
    const lines = [cols.map(csvEscape).join(',')];
    for (const r of results) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
    return new Response(lines.join('\n'), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${table}.csv"` },
    });
  }
  return json({ [table]: results });
}

async function handleCreateContent({ match, request, env, user }) {
  const table = match[1];
  await requireSection(env, user, table, 'write');
  const body = await request.json().catch(() => ({}));
  const fields = CONTENT_FIELDS[table];
  const cols = [...fields, 'uploaded_by'];
  const vals = [...fields.map((f) => body[f] ?? ''), user.id];
  const placeholders = cols.map(() => '?').join(',');
  const res = await env.DB.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`)
    .bind(...vals).run();
  await saveNewTaxonomy(body, env);
  return json({ ok: true, id: res.meta.last_row_id });
}

async function handleUpdateContent({ match, request, env, user }) {
  const table = match[1];
  await requireSection(env, user, table, 'write');
  const id = match[2];
  const body = await request.json().catch(() => ({}));
  const fields = CONTENT_FIELDS[table];
  const sets = fields.map((f) => `${f}=?`).join(',');
  const vals = fields.map((f) => body[f] ?? '');
  await env.DB.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).bind(...vals, id).run();
  await saveNewTaxonomy(body, env);
  return json({ ok: true });
}

async function handleDeleteContent({ match, env, user }) {
  const table = match[1];
  await requireSection(env, user, table, 'write');
  const id = match[2];
  await env.DB.prepare(`UPDATE ${table} SET deleted_at = datetime('now') WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

async function handleTags({ env }) {
  const { results } = await env.DB.prepare('SELECT name FROM tags ORDER BY name').all();
  return json({ tags: results.map((r) => r.name) });
}

async function handleCategories({ env }) {
  const { results } = await env.DB.prepare('SELECT name FROM categories ORDER BY name').all();
  return json({ categories: results.map((r) => r.name) });
}

// ── HANDLERS: site settings ──────────────────────────────────────────

async function handleGetSettings({ env }) {
  const { results } = await env.DB.prepare('SELECT key, value FROM site_settings').all();
  const settings = {};
  for (const r of results) settings[r.key] = r.value;
  return json({ settings });
}

async function handleUpdateSettings({ request, env, user }) {
  await requireSection(env, user, 'settings', 'write');
  const body = await request.json().catch(() => ({}));
  const entries = Object.entries(body.settings || {});
  for (const [key, value] of entries) {
    await env.DB.prepare(
      `INSERT INTO site_settings (key, value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(key, String(value ?? '')).run();
  }
  return json({ ok: true });
}

// ── HANDLERS: analytics (page views + clicks/shares) ────────────────

async function handleTrack({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const kind = String(body.kind || 'view').slice(0, 20);
  const path = String(body.path || '').slice(0, 300);
  const label = String(body.label || '').slice(0, 200);
  if (!path) throw new HttpError('Missing path', 400);
  await env.DB.prepare('INSERT INTO analytics_events (kind, path, label) VALUES (?,?,?)').bind(kind, path, label).run();
  return json({ ok: true });
}

async function handleAnalyticsSummary({ env, user }) {
  requireUser(user);
  const totals = await env.DB.prepare(
    'SELECT kind, COUNT(*) as count FROM analytics_events GROUP BY kind'
  ).all();
  const byPath = await env.DB.prepare(
    'SELECT path, kind, COUNT(*) as count FROM analytics_events GROUP BY path, kind ORDER BY count DESC LIMIT 30'
  ).all();
  const byLabel = await env.DB.prepare(
    "SELECT label, kind, COUNT(*) as count FROM analytics_events WHERE label != '' GROUP BY label, kind ORDER BY count DESC LIMIT 30"
  ).all();
  return json({ totals: totals.results, byPath: byPath.results, byLabel: byLabel.results });
}

// ── HANDLERS: daf calendar (ובהם נהגה) ─────────────────────────────

async function handleDafEntries({ env }) {
  const { results } = await env.DB.prepare('SELECT date, text FROM daf_entries ORDER BY date').all();
  return json({ entries: results });
}

// Bulk upsert from an admin-parsed Excel sheet: [{date: 'YYYY-MM-DD', text}, ...]
async function handleDafBulkUpsert({ request, env, user }) {
  await requireSection(env, user, 'daf', 'write');
  const body = await request.json().catch(() => ({}));
  const entries = Array.isArray(body.entries) ? body.entries : [];
  for (const e of entries) {
    if (!e.date) continue;
    await env.DB.prepare(
      `INSERT INTO daf_entries (date, text, updated_at) VALUES (?,?,datetime('now'))
       ON CONFLICT(date) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`
    ).bind(e.date, e.text || '').run();
  }
  return json({ ok: true, count: entries.length });
}

// ── HANDLERS: Zmanim (via Hebcal.com's public zmanim API) ───────────
// Hebcal computes zmanim server-side and freely allows this kind of use
// with attribution (the frontend shows a small "Zmanim via Hebcal.com"
// credit). Proxied through the Worker rather than called directly from
// the browser so a bad/slow Hebcal response can never surface as a CORS
// error, and so repeat requests for the same day+location are cached at
// Cloudflare's edge instead of hitting Hebcal every page load.
async function handleHebcalZmanim({ url, ctx }) {
  const lat = url.searchParams.get('lat');
  const lon = url.searchParams.get('lon');
  const date = url.searchParams.get('date');
  if (!lat || !lon || !date) throw new HttpError('Missing lat, lon, or date', 400);
  if (!/^-?\d+(\.\d+)?$/.test(lat) || !/^-?\d+(\.\d+)?$/.test(lon) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpError('Invalid lat, lon, or date', 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.internal/hebcal-zmanim?lat=${lat}&lon=${lon}&date=${date}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Hebcal's zmanim endpoint wants the full "latitude"/"longitude" param
  // names, not "lat"/"lon" — confirmed via a direct browser test against
  // the live API, which came back {"error":"Location is required"}
  // because those short names weren't being recognized at all.
  const hebcalUrl = `https://www.hebcal.com/zmanim?cfg=json&latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&date=${encodeURIComponent(date)}`;
  const upstream = await fetch(hebcalUrl, { headers: { 'User-Agent': 'MoisdesVienPlatform/1.0 (+https://moisdesvien.com)' } });
  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    throw new HttpError(`Hebcal zmanim lookup failed: ${errText.slice(0, 200)}`, 502);
  }
  const data = await upstream.json().catch(() => null);
  if (!data || !data.times) throw new HttpError('Hebcal returned an unexpected response', 502);

  const response = new Response(JSON.stringify({ times: data.times }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=21600' },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// Single Gregorian date -> Hebrew date, via Hebcal's date converter.
// hebrew is already Hebrew-script formatted (e.g. "ט״ז באב תשפ״ו"), which
// is what every "today's date" display on the site wants directly.
async function handleHebcalDate({ url, ctx }) {
  const date = url.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError('Missing or invalid date', 400);
  const [gy, gm, gd] = date.split('-').map(Number);

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.internal/hebcal-date?date=${date}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const hebcalUrl = `https://www.hebcal.com/converter?cfg=json&gy=${gy}&gm=${gm}&gd=${gd}&g2h=1`;
  const upstream = await fetch(hebcalUrl, { headers: { 'User-Agent': 'MoisdesVienPlatform/1.0 (+https://moisdesvien.com)' } });
  if (!upstream.ok) throw new HttpError('Hebcal date lookup failed', 502);
  const data = await upstream.json().catch(() => null);
  if (!data || !data.hebrew) throw new HttpError('Hebcal returned an unexpected response', 502);

  const response = new Response(JSON.stringify({ hy: data.hy, hm: data.hm, hd: data.hd, hebrew: data.hebrew, events: data.events || [] }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// Date-range calendar (parsha, major/minor holidays, Rosh Chodesh) via
// Hebcal's main calendar API — one call per visible month instead of one
// per day, since this returns every notable day in the range at once.
// Location is passed through (candle-lighting/havdalah) when available;
// this community's timezone is hardcoded the same way gcal-events already
// assumes it (America/New_York) since Hebcal has no way to infer it from
// lat/lon alone.
async function handleHebcalCalendar({ url, ctx }) {
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  const lat = url.searchParams.get('lat');
  const lon = url.searchParams.get('lon');
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new HttpError('Missing or invalid start/end', 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.internal/hebcal-calendar?start=${start}&end=${end}&lat=${lat || ''}&lon=${lon || ''}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({ v: '1', cfg: 'json', start, end, maj: 'on', min: 'on', nx: 'on', s: 'on' });
  if (lat && lon && /^-?\d+(\.\d+)?$/.test(lat) && /^-?\d+(\.\d+)?$/.test(lon)) {
    params.set('c', 'on');
    params.set('latitude', lat);
    params.set('longitude', lon);
    params.set('tzid', 'America/New_York');
  } else {
    params.set('geo', 'none');
  }
  const hebcalUrl = `https://www.hebcal.com/hebcal?${params.toString()}`;
  const upstream = await fetch(hebcalUrl, { headers: { 'User-Agent': 'MoisdesVienPlatform/1.0 (+https://moisdesvien.com)' } });
  if (!upstream.ok) throw new HttpError('Hebcal calendar lookup failed', 502);
  const data = await upstream.json().catch(() => null);
  if (!data || !Array.isArray(data.items)) throw new HttpError('Hebcal returned an unexpected response', 502);

  const response = new Response(JSON.stringify({ items: data.items }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=21600' },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ── HANDLERS: Google Calendar sync ──────────────────────────────────
// Fetched server-side (not client-side) because Google's public .ics
// export doesn't send CORS headers a browser would need to read it directly.

function unfoldIcs(text) {
  // ICS "folds" long lines with a leading space/tab on the continuation.
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}
function icsUnescape(s) {
  return String(s || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}
function parseIcsDate(raw) {
  // All-day events: YYYYMMDD. Timed events: YYYYMMDDTHHMMSS[Z].
  const m = String(raw || '').match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { iso: `${y}-${mo}-${d}`, allDay: true };
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${z ? 'Z' : ''}`;
  return { iso, allDay: false, isUtc: !!z };
}

// Google exports timed events in UTC (a trailing Z). Slicing that string's
// date portion directly gives the wrong calendar day for evening events in
// US timezones (e.g. 7pm Eastern becomes past midnight UTC, rolling to the
// next date) — so timed/UTC events get their date recomputed in the
// community's local timezone instead. All-day events have no time
// component to convert and are already correct as-is.
function icsLocalDateStr(dtstart) {
  if (dtstart.allDay || !dtstart.isUtc) return dtstart.iso.slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(dtstart.iso));
}

async function handleGcalEvents({ env }) {
  const calendarId = env.GCAL_CALENDAR_ID;
  if (!calendarId) throw new HttpError('GCAL_CALENDAR_ID is not configured on the Worker', 500);
  const url = `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`;

  const res = await fetch(url);
  if (!res.ok) throw new HttpError('Could not fetch the Google Calendar feed (is it shared publicly?)', 502);
  const text = unfoldIcs(await res.text());

  const events = [];
  const blocks = text.split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const body = block.split('END:VEVENT')[0];
    const get = (tag) => {
      const m = body.match(new RegExp(`^${tag}[^:\\n]*:(.*)$`, 'm'));
      return m ? icsUnescape(m[1].trim()) : '';
    };
    const dtstart = parseIcsDate(get('DTSTART'));
    if (!dtstart) continue;
    events.push({
      summary: get('SUMMARY'),
      description: get('DESCRIPTION'),
      location: get('LOCATION'),
      start: dtstart.iso,
      date: icsLocalDateStr(dtstart),
      allDay: dtstart.allDay,
    });
  }

  // Past and future both, sorted ascending — callers that only want
  // upcoming events filter client-side (this also feeds a full month-grid
  // calendar view, which needs past dates too).
  events.sort((a, b) => a.start.localeCompare(b.start));
  return json({ events: events.slice(0, 300) });
}

async function handleGcalSubscribeUrl({ env }) {
  const calendarId = env.GCAL_CALENDAR_ID;
  if (!calendarId) throw new HttpError('GCAL_CALENDAR_ID is not configured on the Worker', 500);
  return json({ url: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(calendarId)}` });
}

// ── HANDLERS: R2 ────────────────────────────────────────────────────

const MIME_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
};
function guessMime(key) {
  const ext = key.split('.').pop().toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

async function handleR2Get({ match, env }) {
  const key = decodeURIComponent(match[1]);
  const obj = await env.R2.get(key);
  if (!obj) throw new HttpError('Not found', 404);
  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType || guessMime(key));
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
  return new Response(obj.body, { headers });
}

async function handleR2List({ url, env }) {
  const prefix = url.searchParams.get('prefix') || '';
  const listed = await env.R2.list({ prefix, limit: 1000 });
  return json({ keys: listed.objects.map((o) => o.key).sort() });
}

async function handleR2Delete({ request, env, user }) {
  requireUser(user);
  const body = await request.json().catch(() => ({}));
  if (!body.key) throw new HttpError('Missing key', 400);
  await env.R2.delete(body.key);
  return json({ ok: true });
}

// R2 has no native rename — stream the object to its new key, then drop the
// old one. Streaming (not buffering) keeps this cheap even for large files.
async function handleR2Rename({ request, env, user }) {
  requireUser(user);
  const body = await request.json().catch(() => ({}));
  if (!body.oldKey || !body.newKey) throw new HttpError('Missing oldKey or newKey', 400);
  if (body.oldKey === body.newKey) return json({ ok: true });
  const obj = await env.R2.get(body.oldKey);
  if (!obj) throw new HttpError('Source file not found', 404);
  await env.R2.put(body.newKey, obj.body, { httpMetadata: obj.httpMetadata });
  await env.R2.delete(body.oldKey);
  return json({ ok: true });
}

function r2Credentials(env) {
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const accountId = env.R2_ACCOUNT_ID;
  if (!accessKeyId || !secretAccessKey || !accountId) {
    throw new HttpError('R2 credentials are not configured on the Worker', 500);
  }
  return { accessKeyId, secretAccessKey, accountId, host: `${accountId}.r2.cloudflarestorage.com` };
}

async function sigV4SigningKey(secretAccessKey, dateStamp, region, service) {
  let key = await hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  key = await hmacSha256(key, region);
  key = await hmacSha256(key, service);
  key = await hmacSha256(key, 'aws4_request');
  return key;
}

// AWS SigV4 requires percent-encoding every byte outside its unreserved
// set (A-Za-z0-9-_.~) — but JS's encodeURIComponent deliberately leaves
// !, *, ', (, ) unescaped (they're valid in a URI without encoding).
// Filenames with an apostrophe (common in Hebrew/Yiddish titles using
// ' / '' for geresh/gershayim) would sign fine but the byte the browser
// actually sends differs from what got signed once R2 re-canonicalizes
// it strictly — signature mismatch, 403, and R2 omits CORS headers on
// that rejection, which then shows up in the browser as a misleading
// "blocked by CORS policy" error with no hint of the real cause.
function awsUriEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// AWS SigV4 presigned URL for direct browser -> R2 upload (also used for
// individual multipart-upload parts via extraParams {partNumber, uploadId}).
async function presignR2PutUrl(env, key, extraParams = {}) {
  const { accessKeyId, secretAccessKey, host } = r2Credentials(env);
  const region = 'auto';
  const service = 's3';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const encodedKey = key.split('/').map(awsUriEncode).join('/');
  const canonicalUri = `/${BUCKET_NAME}/${encodedKey}`;

  const queryParams = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '3600',
    'X-Amz-SignedHeaders': 'host',
    ...extraParams,
  };
  const canonicalQuery = Object.keys(queryParams).sort()
    .map((k) => `${awsUriEncode(k)}=${awsUriEncode(queryParams[k])}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = ['PUT', canonicalUri, canonicalQuery, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');
  const signingKey = await sigV4SigningKey(secretAccessKey, dateStamp, region, service);
  const signature = bufToHex(await hmacSha256(signingKey, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// Signed (Authorization-header) S3 API request, executed by the Worker
// itself using its R2 credentials — used for the small multipart-upload
// control calls (create/complete/abort), never for file bytes.
async function signedR2Request(env, method, key, queryParams, body) {
  const { accessKeyId, secretAccessKey, host } = r2Credentials(env);
  const region = 'auto';
  const service = 's3';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const encodedKey = key.split('/').map(awsUriEncode).join('/');
  const canonicalUri = `/${BUCKET_NAME}/${encodedKey}`;
  const canonicalQuery = Object.keys(queryParams || {}).sort()
    .map((k) => `${awsUriEncode(k)}=${awsUriEncode(queryParams[k])}`)
    .join('&');

  const payloadHash = await sha256Hex(body || '');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');
  const signingKey = await sigV4SigningKey(secretAccessKey, dateStamp, region, service);
  const signature = bufToHex(await hmacSha256(signingKey, stringToSign));

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `https://${host}${canonicalUri}${canonicalQuery ? '?' + canonicalQuery : ''}`;

  const headers = { 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, Authorization: authHeader };
  if (body) headers['Content-Type'] = 'application/xml';
  return fetch(url, { method, headers, body: body || undefined });
}

function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

async function handlePresign({ request, env, user }) {
  requireUser(user);
  const body = await request.json().catch(() => ({}));
  const key = String(body.key || '');
  if (!key) throw new HttpError('Missing key', 400);
  if (/[\\?#%*:"<>|\x00-\x1F]/.test(key)) throw new HttpError('Key contains unsupported characters', 400);
  const url = await presignR2PutUrl(env, key);
  return json({ url, key });
}

// ── Multipart upload (large files: recordings, video) ──────────────────
// Cloudflare's proxy caps a single request's body size well under what a
// multi-hundred-MB or multi-GB recording/video needs, so big files are
// split into parts (each its own direct browser -> R2 PUT, well under the
// cap) and R2 assembles them. The Worker only handles the small control
// calls below — file bytes always go straight from the browser to R2.

async function handleMultipartCreate({ request, env, user }) {
  requireUser(user);
  const body = await request.json().catch(() => ({}));
  const key = String(body.key || '');
  if (!key) throw new HttpError('Missing key', 400);
  if (/[\\?#%*:"<>|\x00-\x1F]/.test(key)) throw new HttpError('Key contains unsupported characters', 400);

  const res = await signedR2Request(env, 'POST', key, { uploads: '' }, '');
  const text = await res.text();
  if (!res.ok) throw new HttpError(`Could not start upload: ${text.slice(0, 300)}`, 502);
  const uploadId = xmlTag(text, 'UploadId');
  if (!uploadId) throw new HttpError('R2 did not return an upload ID', 502);
  return json({ uploadId, key });
}

async function handleMultipartPresignPart({ request, env, user }) {
  requireUser(user);
  const body = await request.json().catch(() => ({}));
  const key = String(body.key || '');
  const uploadId = String(body.uploadId || '');
  const partNumber = parseInt(body.partNumber, 10);
  if (!key || !uploadId || !partNumber) throw new HttpError('Missing key, uploadId, or partNumber', 400);
  const url = await presignR2PutUrl(env, key, { partNumber: String(partNumber), uploadId });
  return json({ url });
}

async function handleMultipartComplete({ request, env, user }) {
  requireUser(user);
  const body = await request.json().catch(() => ({}));
  const key = String(body.key || '');
  const uploadId = String(body.uploadId || '');
  const parts = Array.isArray(body.parts) ? body.parts : [];
  if (!key || !uploadId || !parts.length) throw new HttpError('Missing key, uploadId, or parts', 400);

  const partsXml = [...parts]
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
    .join('');
  const res = await signedR2Request(env, 'POST', key, { uploadId }, `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`);
  const text = await res.text();
  if (!res.ok) throw new HttpError(`Could not complete upload: ${text.slice(0, 300)}`, 502);
  return json({ ok: true, key });
}

async function handleMultipartAbort({ request, env, user }) {
  requireUser(user);
  const body = await request.json().catch(() => ({}));
  const key = String(body.key || '');
  const uploadId = String(body.uploadId || '');
  if (!key || !uploadId) throw new HttpError('Missing key or uploadId', 400);
  await signedR2Request(env, 'DELETE', key, { uploadId }, '');
  return json({ ok: true });
}

// Public, unauthenticated presign for file-upload fields on public forms.
// The key is always server-constructed under form-uploads/<slug>/ so a
// public submitter can never target any other prefix in the bucket.
async function handleFormPresign({ match, request, env }) {
  const slug = normalizeSlug(match[1]);
  const form = await findFormBySlug(env, slug);
  if (!form) throw new HttpError('Form not found', 404);

  const body = await request.json().catch(() => ({}));
  const safeName = String(body.filename || 'file')
    .replace(/[\\/?#%*:"<>|\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ').trim()
    .slice(-80) || 'file';
  const key = `form-uploads/${slug}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`;
  const url = await presignR2PutUrl(env, key);
  return json({ url, key });
}

// ── HANDLERS: forms ───────────────────────────────────────────────────
// Public surface is exactly 3 read-only-safe, unauthenticated endpoints:
// GET .../public (form + fields), POST .../submit (one response), POST
// .../presign (a file field's upload URL). Everything else is admin-only.

const SLUG_RE = /^[a-z0-9-]+$/;

function randomSlug() {
  // Never depends on Date.now() alone — two forms created in the same
  // millisecond (e.g. a double-click) must never collide.
  return 'form-' + crypto.randomUUID().slice(0, 8);
}
function normalizeSlug(raw) {
  return String(raw || '').trim().toLowerCase();
}
function safeParse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch (e) {
    return fallback;
  }
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function serializeForm(row) {
  return { ...row, settings: safeParse(row.settings, {}) };
}
function serializeField(row) {
  return { ...row, options: safeParse(row.options, []) };
}

async function findFormBySlug(env, slug) {
  return env.DB.prepare('SELECT * FROM forms WHERE slug = ? AND deleted_at IS NULL').bind(slug).first();
}

async function handleListForms({ env, user }) {
  await requireSection(env, user, 'forms', 'read');
  const { results } = await env.DB.prepare(
    `SELECT f.*, (
       SELECT COUNT(*) FROM form_responses r WHERE r.form_id = f.id AND r.read_at IS NULL
     ) AS unread_count
     FROM forms f WHERE f.deleted_at IS NULL ORDER BY f.id DESC`
  ).all();
  return json({ forms: results.map(serializeForm) });
}

async function handleCreateForm({ request, env, user }) {
  await requireSection(env, user, 'forms', 'write');
  const body = await request.json().catch(() => ({}));
  const title = String(body.title || '').trim();
  const settings = JSON.stringify(body.settings || {});

  const requestedSlug = normalizeSlug(body.slug);
  let slug = requestedSlug && SLUG_RE.test(requestedSlug) ? requestedSlug : randomSlug();

  const insert = (s) =>
    env.DB.prepare('INSERT INTO forms (title,slug,settings,created_by) VALUES (?,?,?,?)')
      .bind(title, s, settings, user.id).run();

  try {
    const res = await insert(slug);
    return json({ ok: true, id: res.meta.last_row_id, slug });
  } catch (e) {
    // Slug collision (or any other insert failure) — fall back to a
    // guaranteed-unique generated one rather than failing the whole
    // create, since "new form" is meant to always succeed instantly.
    slug = randomSlug();
    const res = await insert(slug);
    return json({ ok: true, id: res.meta.last_row_id, slug });
  }
}

async function handleUpdateForm({ match, request, env, user }) {
  await requireSection(env, user, 'forms', 'write');
  const numericId = Number(match[1]);
  const body = await request.json().catch(() => ({}));
  const title = String(body.title || '').trim();
  const settings = JSON.stringify(body.settings || {});

  if (body.slug !== undefined) {
    const slug = normalizeSlug(body.slug);
    if (!SLUG_RE.test(slug)) throw new HttpError('Slug may only contain lowercase letters, numbers, and hyphens', 400);
    const clash = await env.DB.prepare('SELECT id FROM forms WHERE slug = ? AND id != ? AND deleted_at IS NULL').bind(slug, numericId).first();
    if (clash) throw new HttpError('That slug is already taken by another form', 409);
    try {
      await env.DB.prepare('UPDATE forms SET title = ?, slug = ?, settings = ? WHERE id = ?')
        .bind(title, slug, settings, numericId).run();
    } catch (e) {
      throw new HttpError('That slug is already taken by another form', 409);
    }
    return json({ ok: true, slug });
  }

  await env.DB.prepare('UPDATE forms SET title = ?, settings = ? WHERE id = ?')
    .bind(title, settings, numericId).run();
  return json({ ok: true });
}

async function handleDeleteForm({ match, env, user }) {
  await requireSection(env, user, 'forms', 'write');
  await env.DB.prepare("UPDATE forms SET deleted_at = datetime('now') WHERE id = ?").bind(Number(match[1])).run();
  return json({ ok: true });
}

// ── Public (unauthenticated) ─────────────────────────────────────────

async function handleFormPublic({ match, env }) {
  const slug = normalizeSlug(match[1]);
  const form = await findFormBySlug(env, slug);
  if (!form) throw new HttpError('Form not found', 404);
  const { results: fields } = await env.DB.prepare(
    'SELECT * FROM form_fields WHERE form_id = ? ORDER BY field_order'
  ).bind(form.id).all();
  return json({ form: serializeForm(form), fields: fields.map(serializeField) });
}

async function handleFormSubmit({ match, request, env }) {
  const slug = normalizeSlug(match[1]);
  const form = await findFormBySlug(env, slug);
  if (!form) throw new HttpError('Form not found', 404);
  const settings = safeParse(form.settings, {});
  if (settings.status === 'closed') throw new HttpError('This form is closed', 403);

  const { results: validFields } = await env.DB.prepare('SELECT id FROM form_fields WHERE form_id = ?').bind(form.id).all();
  const validIds = new Set(validFields.map((f) => String(f.id)));

  const body = await request.json().catch(() => ({}));
  const answers = body.answers && typeof body.answers === 'object' ? body.answers : {};

  const res = await env.DB.prepare('INSERT INTO form_responses (form_id, metadata) VALUES (?,?)')
    .bind(form.id, JSON.stringify(body.metadata || {})).run();
  const responseId = res.meta.last_row_id;

  for (const [fieldId, value] of Object.entries(answers)) {
    // Ignore any answer keyed to a field that isn't actually part of this
    // form — a stale/tampered client payload shouldn't be able to write
    // arbitrary field_id rows.
    if (!validIds.has(String(fieldId))) continue;
    const stored = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    await env.DB.prepare('INSERT INTO form_answers (response_id, field_id, value) VALUES (?,?,?)')
      .bind(responseId, Number(fieldId), stored).run();
  }
  return json({ ok: true });
}

// ── Fields ─────────────────────────────────────────────────────────

async function handleListFields({ match, env, user }) {
  await requireSection(env, user, 'forms', 'read');
  const { results } = await env.DB.prepare(
    'SELECT * FROM form_fields WHERE form_id = ? ORDER BY field_order'
  ).bind(Number(match[1])).all();
  return json({ fields: results.map(serializeField) });
}

async function handleSaveFields({ match, request, env, user }) {
  await requireSection(env, user, 'forms', 'write');
  const formId = Number(match[1]);
  const body = await request.json().catch(() => ({}));
  const fields = Array.isArray(body.fields) ? body.fields : [];

  // Replace-all: simplest correct semantics for a drag-reordered field
  // list edited as a whole in the builder, and D1 has no multi-statement
  // transaction API to make a smarter diff meaningfully safer anyway.
  await env.DB.prepare('DELETE FROM form_fields WHERE form_id = ?').bind(formId).run();
  let order = 0;
  for (const f of fields) {
    await env.DB.prepare(
      'INSERT INTO form_fields (form_id,type,label,placeholder,options,required,field_order,settings) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(
      formId,
      String(f.type || 'text'),
      String(f.label || ''),
      String(f.placeholder || ''),
      JSON.stringify(Array.isArray(f.options) ? f.options : []),
      f.required ? 1 : 0,
      order++,
      JSON.stringify(f.settings || {})
    ).run();
  }
  return json({ ok: true });
}

async function handleFormResponses({ match, url, env, user }) {
  await requireSection(env, user, 'forms', 'read');
  const formId = match[1];
  const { results: fields } = await env.DB.prepare(
    'SELECT * FROM form_fields WHERE form_id = ? ORDER BY field_order'
  ).bind(formId).all();
  const { results: responses } = await env.DB.prepare(
    'SELECT * FROM form_responses WHERE form_id = ? ORDER BY id DESC'
  ).bind(formId).all();
  const { results: answers } = await env.DB.prepare(
    'SELECT * FROM form_answers WHERE response_id IN (SELECT id FROM form_responses WHERE form_id = ?)'
  ).bind(formId).all();

  const byResponse = {};
  for (const a of answers) (byResponse[a.response_id] ||= {})[a.field_id] = a.value;
  const rows = responses.map((r) => ({ id: r.id, submitted_at: r.submitted_at, read_at: r.read_at, answers: byResponse[r.id] || {} }));

  if (url.searchParams.get('format') === 'csv') {
    const header = ['id', 'submitted_at', ...fields.map((f) => f.label)];
    const lines = [header.map(csvEscape).join(',')];
    for (const r of rows) {
      lines.push([r.id, r.submitted_at, ...fields.map((f) => r.answers[f.id] || '')].map(csvEscape).join(','));
    }
    return new Response(lines.join('\n'), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="responses.csv"' },
    });
  }
  return json({ fields, responses: rows });
}

async function handleMarkResponseRead({ match, request, env, user }) {
  await requireSection(env, user, 'forms', 'write');
  const formId = Number(match[1]);
  const responseId = Number(match[2]);
  const body = await request.json().catch(() => ({}));
  const read = body.read !== false; // default true — "mark as read" is the common case
  await env.DB.prepare(
    "UPDATE form_responses SET read_at = ? WHERE id = ? AND form_id = ?"
  ).bind(read ? new Date().toISOString() : null, responseId, formId).run();
  return json({ ok: true });
}

// ── ROUTER ────────────────────────────────────────────────────────────

const routes = [
  ['GET', /^\/api\/ping$/, handlePing],
  ['POST', /^\/api\/login$/, handleLogin],
  ['POST', /^\/api\/logout$/, handleLogout],
  ['GET', /^\/api\/me$/, handleMe],
  ['POST', /^\/api\/refresh$/, handleRefresh],
  ['GET', /^\/api\/users$/, handleListUsers],
  ['POST', /^\/api\/users$/, handleCreateUser],
  ['GET', /^\/api\/users\/(\d+)\/permissions$/, handleGetUserPermissions],
  ['PUT', /^\/api\/users\/(\d+)\/permissions$/, handleSetUserPermissions],
  ['PUT', /^\/api\/users\/(\d+)\/password$/, handleSetUserPassword],
  ['GET', /^\/api\/tags$/, handleTags],
  ['GET', /^\/api\/categories$/, handleCategories],
  ['GET', /^\/api\/r2-list$/, handleR2List],
  ['DELETE', /^\/api\/r2-delete$/, handleR2Delete],
  ['POST', /^\/api\/r2-rename$/, handleR2Rename],
  ['POST', /^\/api\/presign$/, handlePresign],
  ['POST', /^\/api\/multipart\/create$/, handleMultipartCreate],
  ['POST', /^\/api\/multipart\/presign-part$/, handleMultipartPresignPart],
  ['POST', /^\/api\/multipart\/complete$/, handleMultipartComplete],
  ['POST', /^\/api\/multipart\/abort$/, handleMultipartAbort],
  ['GET', /^\/api\/r2\/(.+)$/, handleR2Get],
  ['GET', /^\/api\/forms$/, handleListForms],
  ['POST', /^\/api\/forms$/, handleCreateForm],
  ['GET', /^\/api\/forms\/([^/]+)\/public$/, handleFormPublic],
  ['POST', /^\/api\/forms\/([^/]+)\/submit$/, handleFormSubmit],
  ['POST', /^\/api\/forms\/([^/]+)\/presign$/, handleFormPresign],
  ['GET', /^\/api\/forms\/(\d+)\/fields$/, handleListFields],
  ['POST', /^\/api\/forms\/(\d+)\/fields$/, handleSaveFields],
  ['GET', /^\/api\/forms\/(\d+)\/responses$/, handleFormResponses],
  ['PUT', /^\/api\/forms\/(\d+)\/responses\/(\d+)\/read$/, handleMarkResponseRead],
  ['PUT', /^\/api\/forms\/(\d+)$/, handleUpdateForm],
  ['DELETE', /^\/api\/forms\/(\d+)$/, handleDeleteForm],
  ['GET', /^\/api\/(posts|posters|events|videos|pdfs|simchas)$/, handleListContent],
  ['POST', /^\/api\/(posts|posters|events|videos|pdfs|simchas)$/, handleCreateContent],
  ['PUT', /^\/api\/(posts|posters|events|videos|pdfs|simchas)\/(\d+)$/, handleUpdateContent],
  ['DELETE', /^\/api\/(posts|posters|events|videos|pdfs|simchas)\/(\d+)$/, handleDeleteContent],
  ['GET', /^\/api\/hebcal-zmanim$/, handleHebcalZmanim],
  ['GET', /^\/api\/hebcal-date$/, handleHebcalDate],
  ['GET', /^\/api\/hebcal-calendar$/, handleHebcalCalendar],
  ['GET', /^\/api\/daf-entries$/, handleDafEntries],
  ['POST', /^\/api\/daf-entries\/bulk$/, handleDafBulkUpsert],
  ['GET', /^\/api\/gcal-events$/, handleGcalEvents],
  ['GET', /^\/api\/gcal-subscribe-url$/, handleGcalSubscribeUrl],
  ['GET', /^\/api\/settings$/, handleGetSettings],
  ['PUT', /^\/api\/settings$/, handleUpdateSettings],
  ['POST', /^\/api\/track$/, handleTrack],
  ['GET', /^\/api\/analytics\/summary$/, handleAnalyticsSummary],
];

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  await ensureAllTables(env);
  const user = await getUserFromRequest(request, env);

  for (const [method, pattern, handler] of routes) {
    if (request.method !== method) continue;
    const match = pattern.exec(url.pathname);
    if (match) return handler({ request, env, ctx, url, match, user });
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    try {
      const response = await handleRequest(request, env, ctx);
      return withCORSHeaders(response);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return withCORSHeaders(json({ error: err.message || 'Internal server error' }, status));
    }
  },
};
