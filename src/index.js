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
};

const CONTENT_MIGRATIONS = {
  posts: ['tags TEXT', 'category TEXT', 'folder_url TEXT', 'deleted_at TEXT'],
  posters: ['folder_url TEXT', 'deleted_at TEXT'],
  events: ['tags TEXT', 'folder_url TEXT', 'deleted_at TEXT'],
  videos: ['tags TEXT', 'video_url TEXT', 'folder_url TEXT', 'deleted_at TEXT'],
  pdfs: ['language TEXT', 'parsha TEXT', 'year TEXT', 'thumb_url TEXT', 'deleted_at TEXT'],
};

const CONTENT_FIELDS = {
  posts: ['date', 'title', 'body', 'folder_url', 'tags', 'category'],
  posters: ['date', 'parsha', 'folder_url'],
  events: ['date', 'title', 'location', 'category', 'description', 'tags', 'folder_url'],
  videos: ['date', 'title', 'location', 'category', 'description', 'tags', 'video_url', 'folder_url'],
  pdfs: ['date', 'title', 'category', 'language', 'parsha', 'year', 'pdf_url', 'thumb_url'],
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
    await env.DB.prepare('INSERT INTO users (name,email,password_hash,role,active) VALUES (?,?,?,?,1)')
      .bind('Superadmin', SUPERADMIN_EMAIL, hash, 'superadmin')
      .run();
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
    form_id INTEGER, submitted_at TEXT DEFAULT (datetime('now')), metadata TEXT
  )`).run();

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS form_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    response_id INTEGER, field_id INTEGER, value TEXT
  )`).run();
}

let migrated = false;
async function ensureAllTables(env) {
  if (migrated) return;
  await ensureCoreTables(env);
  for (const t of Object.keys(CONTENT_SCHEMAS)) await ensureContentTable(t, env);
  await ensureFormsTables(env);
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
  delete row.password_hash;
  return json({ token, expires, user: row });
}

async function handleLogout({ request, env }) {
  const token = bearerToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  return json({ ok: true });
}

async function handleMe({ user }) {
  requireUser(user);
  return json({ user });
}

async function handleRefresh({ request, env, user }) {
  requireUser(user);
  const token = bearerToken(request);
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').bind(expires, token).run();
  return json({ token, expires, user });
}

async function handleListUsers({ env, user }) {
  requireUser(user);
  const { results } = await env.DB.prepare(
    'SELECT id,name,email,role,active,created_at FROM users ORDER BY id'
  ).all();
  return json({ users: results });
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
    const res = await env.DB.prepare(
      'INSERT INTO users (name,email,password_hash,role,active) VALUES (?,?,?,?,1)'
    ).bind(name, email, hash, role).run();
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

async function handleListContent({ match, env }) {
  const table = match[1];
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY date DESC, id DESC`
  ).all();
  return json({ [table]: results });
}

async function handleCreateContent({ match, request, env, user }) {
  requireUser(user);
  const table = match[1];
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
  requireUser(user);
  const table = match[1];
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
  requireUser(user);
  const table = match[1];
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

// AWS SigV4 presigned PUT URL for direct browser -> R2 upload.
// Keys must only contain [A-Za-z0-9_.-/] — enforced client-side at upload time —
// so a plain per-segment encodeURIComponent is a correct, unambiguous canonical URI.
async function presignR2PutUrl(env, key) {
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const accountId = env.R2_ACCOUNT_ID;
  if (!accessKeyId || !secretAccessKey || !accountId) {
    throw new HttpError('R2 credentials are not configured on the Worker', 500);
  }

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const region = 'auto';
  const service = 's3';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const canonicalUri = `/${BUCKET_NAME}/${encodedKey}`;

  const queryParams = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '3600',
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(queryParams).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = ['PUT', canonicalUri, canonicalQuery, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');

  let signingKey = await hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  signingKey = await hmacSha256(signingKey, region);
  signingKey = await hmacSha256(signingKey, service);
  signingKey = await hmacSha256(signingKey, 'aws4_request');
  const signature = bufToHex(await hmacSha256(signingKey, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function handlePresign({ request, env, user }) {
  requireUser(user);
  const body = await request.json().catch(() => ({}));
  const key = String(body.key || '');
  if (!key) throw new HttpError('Missing key', 400);
  if (!/^[A-Za-z0-9_.\-/]+$/.test(key)) throw new HttpError('Key contains unsupported characters', 400);
  const url = await presignR2PutUrl(env, key);
  return json({ url, key });
}

// Public, unauthenticated presign for file-upload fields on public forms.
// The key is always server-constructed under form-uploads/<slug>/ so a
// public submitter can never target any other prefix in the bucket.
async function handleFormPresign({ match, request, env }) {
  const slug = match[1];
  const form = await env.DB.prepare('SELECT id FROM forms WHERE slug = ? AND deleted_at IS NULL').bind(slug).first();
  if (!form) throw new HttpError('Form not found', 404);

  const body = await request.json().catch(() => ({}));
  const safeName = String(body.filename || 'file')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(-80);
  const key = `form-uploads/${slug}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`;
  const url = await presignR2PutUrl(env, key);
  return json({ url, key });
}

// ── HANDLERS: forms ───────────────────────────────────────────────────

function base36Slug() {
  return 'form-' + Date.now().toString(36);
}
function safeParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return fallback;
  }
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function handleListForms({ env, user }) {
  requireUser(user);
  const { results } = await env.DB.prepare('SELECT * FROM forms WHERE deleted_at IS NULL ORDER BY id DESC').all();
  return json({ forms: results.map((f) => ({ ...f, settings: safeParse(f.settings, {}) })) });
}

async function handleCreateForm({ request, env, user }) {
  requireUser(user);
  const body = await request.json().catch(() => ({}));
  let slug = String(body.slug || '').trim();
  if (!slug || !/^[a-z0-9-]+$/i.test(slug)) slug = base36Slug();
  const settings = JSON.stringify(body.settings || {});

  const insert = async (s) =>
    env.DB.prepare('INSERT INTO forms (title,slug,settings,created_by) VALUES (?,?,?,?)')
      .bind(String(body.title || ''), s, settings, user.id).run();

  try {
    const res = await insert(slug);
    return json({ ok: true, id: res.meta.last_row_id, slug });
  } catch (e) {
    slug = base36Slug();
    const res = await insert(slug);
    return json({ ok: true, id: res.meta.last_row_id, slug });
  }
}

async function handleUpdateForm({ match, request, env, user }) {
  requireUser(user);
  const id = match[1];
  const body = await request.json().catch(() => ({}));
  const settings = JSON.stringify(body.settings || {});
  await env.DB.prepare('UPDATE forms SET title = ?, settings = ? WHERE id = ?')
    .bind(String(body.title || ''), settings, id).run();
  return json({ ok: true });
}

async function handleDeleteForm({ match, env, user }) {
  requireUser(user);
  await env.DB.prepare("UPDATE forms SET deleted_at = datetime('now') WHERE id = ?").bind(match[1]).run();
  return json({ ok: true });
}

async function handleFormPublic({ match, env }) {
  const slug = match[1];
  const form = await env.DB.prepare('SELECT * FROM forms WHERE slug = ? AND deleted_at IS NULL').bind(slug).first();
  if (!form) throw new HttpError('Form not found', 404);
  const { results: fields } = await env.DB.prepare(
    'SELECT * FROM form_fields WHERE form_id = ? ORDER BY field_order'
  ).bind(form.id).all();
  return json({
    form: { ...form, settings: safeParse(form.settings, {}) },
    fields: fields.map((f) => ({ ...f, options: safeParse(f.options, []) })),
  });
}

async function handleFormSubmit({ match, request, env }) {
  const slug = match[1];
  const form = await env.DB.prepare('SELECT * FROM forms WHERE slug = ? AND deleted_at IS NULL').bind(slug).first();
  if (!form) throw new HttpError('Form not found', 404);
  const settings = safeParse(form.settings, {});
  if (settings.status === 'closed') throw new HttpError('This form is closed', 403);

  const body = await request.json().catch(() => ({}));
  const answers = body.answers || {};
  const res = await env.DB.prepare('INSERT INTO form_responses (form_id, metadata) VALUES (?,?)')
    .bind(form.id, JSON.stringify(body.metadata || {})).run();
  const responseId = res.meta.last_row_id;

  for (const [fieldId, value] of Object.entries(answers)) {
    await env.DB.prepare('INSERT INTO form_answers (response_id, field_id, value) VALUES (?,?,?)')
      .bind(responseId, fieldId, typeof value === 'string' ? value : JSON.stringify(value)).run();
  }
  return json({ ok: true });
}

async function handleListFields({ match, env, user }) {
  requireUser(user);
  const { results } = await env.DB.prepare(
    'SELECT * FROM form_fields WHERE form_id = ? ORDER BY field_order'
  ).bind(match[1]).all();
  return json({ fields: results.map((f) => ({ ...f, options: safeParse(f.options, []) })) });
}

async function handleSaveFields({ match, request, env, user }) {
  requireUser(user);
  const formId = match[1];
  const body = await request.json().catch(() => ({}));
  const fields = Array.isArray(body.fields) ? body.fields : [];
  await env.DB.prepare('DELETE FROM form_fields WHERE form_id = ?').bind(formId).run();
  let order = 0;
  for (const f of fields) {
    await env.DB.prepare(
      'INSERT INTO form_fields (form_id,type,label,placeholder,options,required,field_order,settings) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(
      formId, f.type || 'text', f.label || '', f.placeholder || '',
      JSON.stringify(f.options || []), f.required ? 1 : 0, order++, JSON.stringify(f.settings || {})
    ).run();
  }
  return json({ ok: true });
}

async function handleFormResponses({ match, url, env, user }) {
  requireUser(user);
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
  const rows = responses.map((r) => ({ id: r.id, submitted_at: r.submitted_at, answers: byResponse[r.id] || {} }));

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

// ── ROUTER ────────────────────────────────────────────────────────────

const routes = [
  ['GET', /^\/api\/ping$/, handlePing],
  ['POST', /^\/api\/login$/, handleLogin],
  ['POST', /^\/api\/logout$/, handleLogout],
  ['GET', /^\/api\/me$/, handleMe],
  ['POST', /^\/api\/refresh$/, handleRefresh],
  ['GET', /^\/api\/users$/, handleListUsers],
  ['POST', /^\/api\/users$/, handleCreateUser],
  ['GET', /^\/api\/tags$/, handleTags],
  ['GET', /^\/api\/categories$/, handleCategories],
  ['GET', /^\/api\/r2-list$/, handleR2List],
  ['DELETE', /^\/api\/r2-delete$/, handleR2Delete],
  ['POST', /^\/api\/presign$/, handlePresign],
  ['GET', /^\/api\/r2\/(.+)$/, handleR2Get],
  ['GET', /^\/api\/forms$/, handleListForms],
  ['POST', /^\/api\/forms$/, handleCreateForm],
  ['GET', /^\/api\/forms\/([^/]+)\/public$/, handleFormPublic],
  ['POST', /^\/api\/forms\/([^/]+)\/submit$/, handleFormSubmit],
  ['POST', /^\/api\/forms\/([^/]+)\/presign$/, handleFormPresign],
  ['GET', /^\/api\/forms\/(\d+)\/fields$/, handleListFields],
  ['POST', /^\/api\/forms\/(\d+)\/fields$/, handleSaveFields],
  ['GET', /^\/api\/forms\/(\d+)\/responses$/, handleFormResponses],
  ['PUT', /^\/api\/forms\/(\d+)$/, handleUpdateForm],
  ['DELETE', /^\/api\/forms\/(\d+)$/, handleDeleteForm],
  ['GET', /^\/api\/(posts|posters|events|videos|pdfs)$/, handleListContent],
  ['POST', /^\/api\/(posts|posters|events|videos|pdfs)$/, handleCreateContent],
  ['PUT', /^\/api\/(posts|posters|events|videos|pdfs)\/(\d+)$/, handleUpdateContent],
  ['DELETE', /^\/api\/(posts|posters|events|videos|pdfs)\/(\d+)$/, handleDeleteContent],
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
