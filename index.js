// ================================================================
// MOISDES WORKER — single Cloudflare Worker backing the whole
// Moisdes Vien platform: auth, content CRUD, R2 presigning, forms.
// Bindings: env.DB (D1 "moisdes-db"), env.R2 (R2 "moisdes-media")
// Secrets:  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID,
//           BREVO_API_KEY (optional — email sends dry-run/log-only
//           without it, see sendEmail() below),
//           GCAL_SERVICE_ACCOUNT_JSON (optional — writing calendar events
//           fails with a clear error without it, see
//           getGoogleAccessToken() below and GOOGLE_CALENDAR_SETUP.md)
// ================================================================

const VERSION = '1.0.0';
const BUCKET_NAME = 'moisdes-media';
const SESSION_DAYS = 30;
// Canonical site origin — used only for building absolute URLs that have
// to work with no browser context of their own (image src/links inside
// an emailed HTML page, which has no origin to resolve a relative path
// against the way a page loaded in a browser does).
const SITE_ORIGIN = 'https://chatzarvien.org';

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

// base64url (no padding) of a string or raw bytes — used by the Google
// service-account JWT below (standard base64's '+/=' aren't URL-safe).
function base64UrlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A service-account private key arrives as PEM text; Web Crypto's
// importKey wants the raw PKCS8 DER bytes underneath it.
function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── EMAIL (Brevo transactional API) ──────────────────────────────────

// Every email gets the same branded wrapper — a navy header with the
// site logo, the message body, then "Powered by Everything Shul" at the
// bottom. Image src values must be absolute: an emailed HTML page has no
// origin of its own for a browser to resolve a relative /logo.avif
// against the way the live site does.
function emailWrap(bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#eef3f9;font-family:Georgia,'Times New Roman',serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f9;padding:40px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 18px rgba(13,32,60,.10);">
        <tr><td style="background:#1e3766;padding:28px 36px;text-align:center;">
          <img src="${SITE_ORIGIN}/logo.avif" alt="Moisdes Vien" height="40" style="height:40px;width:auto;max-width:260px;">
        </td></tr>
        <tr><td style="height:3px;background:#25a9ea;line-height:0;font-size:0;">&nbsp;</td></tr>
        <tr><td style="padding:36px 40px 28px;color:#1c2f4d;font-size:15px;line-height:1.7;">${bodyHtml}</td></tr>
        <tr><td style="padding:0 40px;"><div style="border-top:1px solid #dbe4ee;"></div></td></tr>
        <tr><td style="padding:20px 40px 26px;text-align:center;">
          <a href="https://everythingshul.com" style="text-decoration:none;color:#75879c;font-size:12px;">Powered By
            <img src="${SITE_ORIGIN}/everythingshul-logo.png" alt="Everything Shul" height="16" style="height:16px;width:auto;vertical-align:middle;margin-left:6px;">
          </a>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

// Sends one email and always logs the attempt to emails_sent — success
// or failure — since that table IS the Email Center's sent log, not a
// separate audit trail bolted on after the fact. No BREVO_API_KEY secret
// configured -> every send is logged as 'dry_run' and nothing actually
// goes out, so a fresh deploy before the secret is set degrades quietly
// instead of every password-reset/form-notify/manual send failing hard.
// opts: { relatedType, relatedId, sentBy } tag where a system-triggered
// email came from (e.g. relatedType 'form_notify', relatedId the form's
// id) — left unset for a manual Email Center send.
async function sendEmail(env, to, subject, bodyHtml, opts = {}) {
  const apiKey = env.BREVO_API_KEY;
  const senderEmail = env.EMAIL_SENDER || 'noreply@chatzarvien.org';
  const senderName = env.EMAIL_SENDER_NAME || 'Moisdes Vien';
  const html = emailWrap(bodyHtml);
  const log = (status, errorMessage) =>
    env.DB.prepare(
      'INSERT INTO emails_sent (to_email, subject, status, error_message, related_type, related_id, sent_by) VALUES (?,?,?,?,?,?,?)'
    ).bind(to, subject, status, errorMessage || null, opts.relatedType || null, opts.relatedId || null, opts.sentBy || null).run();

  if (!apiKey) {
    console.log(`[mail:DRY-RUN] To: ${to} | Subject: ${subject}`);
    await log('dry_run', 'BREVO_API_KEY not configured — logged only, nothing sent.');
    return { dryRun: true };
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      await log('error', errText.slice(0, 500));
      return { ok: false, error: errText };
    }
    await log('sent', null);
    return { ok: true };
  } catch (e) {
    await log('error', String(e.message || e).slice(0, 500));
    return { ok: false, error: e.message };
  }
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

// Every type except simchas (ticker-only, no page of its own) can be
// featured (home mosaic spotlight) and/or scheduled (publish_at).
const SCHEDULABLE_TYPES = ['posts', 'posters', 'events', 'videos', 'pdfs'];

const CONTENT_MIGRATIONS = {
  posts: ['tags TEXT', 'category TEXT', 'folder_url TEXT', 'deleted_at TEXT', 'featured INTEGER DEFAULT 0', 'publish_at TEXT'],
  posters: ['folder_url TEXT', 'deleted_at TEXT', 'featured INTEGER DEFAULT 0', 'publish_at TEXT'],
  events: ['tags TEXT', 'folder_url TEXT', 'thumb_url TEXT', 'deleted_at TEXT', 'featured INTEGER DEFAULT 0', 'publish_at TEXT'],
  videos: ['tags TEXT', 'video_url TEXT', 'folder_url TEXT', 'video_file_url TEXT', 'deleted_at TEXT', 'featured INTEGER DEFAULT 0', 'publish_at TEXT'],
  pdfs: ['language TEXT', 'parsha TEXT', 'year TEXT', 'thumb_url TEXT', 'deleted_at TEXT', 'featured INTEGER DEFAULT 0', 'publish_at TEXT'],
  simchas: ['deleted_at TEXT'],
};

const CONTENT_FIELDS = {
  posts: ['date', 'title', 'body', 'folder_url', 'tags', 'category', 'featured', 'publish_at'],
  posters: ['date', 'parsha', 'folder_url', 'featured', 'publish_at'],
  events: ['date', 'title', 'location', 'category', 'description', 'tags', 'folder_url', 'thumb_url', 'featured', 'publish_at'],
  videos: ['date', 'title', 'location', 'category', 'description', 'tags', 'video_url', 'folder_url', 'video_file_url', 'featured', 'publish_at'],
  pdfs: ['date', 'title', 'category', 'language', 'parsha', 'year', 'pdf_url', 'thumb_url', 'featured', 'publish_at'],
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
  try { await env.DB.prepare('ALTER TABLE tags ADD COLUMN featured INTEGER DEFAULT 0').run(); } catch (e) { /* already exists */ }

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

// Every email the system has ever sent (password resets, form-submission
// notifications, and anything sent manually from the Email Center) — the
// Email Center's "sent log" reads straight from this.
async function ensureEmailsTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS emails_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_email TEXT, subject TEXT, status TEXT, error_message TEXT,
    related_type TEXT, related_id INTEGER, sent_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
}

// Self-service "forgot my password" tokens — single-use, short-lived.
async function ensurePasswordResetsTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS password_resets (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
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

// Parshiyot beyond the standard 54 baked into the frontend's CFG.parshiyot
// (shared-config.js) — e.g. a combined-reading label an editor wants as
// its own pill. Merged with the standard list client-side; this table
// only needs to hold the extras.
async function ensureCustomParshiyotTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS custom_parshiyot (
    name TEXT PRIMARY KEY
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
  await ensureEmailsTable(env);
  await ensurePasswordResetsTable(env);
  await ensureCustomParshiyotTable(env);
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
// Every admin-panel section an editor's access can be scoped to. "users"
// is delegable like any other section (an admin can grant an editor the
// ability to add accounts / manage permissions) — but see the escalation
// guards in handleCreateUser/handleSetUserPermissions/handleSetUserPassword
// below: a non-full-access holder of users:write still can't create or
// touch an admin/superadmin account, so granting it can't be used to
// self-escalate past "editor".
const SECTIONS = ['posts', 'posters', 'events', 'videos', 'pdfs', 'simchas', 'forms', 'daf', 'settings', 'emails', 'calendar', 'users'];

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

const PASSWORD_RESET_MINUTES = 60;

// Always responds the same way regardless of whether the email matches
// an account — a different response for "no such account" vs "email
// sent" lets anyone probe which emails have logins here, which is
// exactly the kind of thing a public, unauthenticated endpoint shouldn't
// leak. The token itself (not the response) is what actually gates
// anything.
async function handleForgotPassword({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) throw new HttpError('Email is required', 400);

  const row = await env.DB.prepare('SELECT id, name FROM users WHERE email = ? AND active = 1').bind(email).first();
  if (row) {
    const token = randomToken();
    const expires = new Date(Date.now() + PASSWORD_RESET_MINUTES * 60000).toISOString();
    await env.DB.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?,?,?)').bind(token, row.id, expires).run();
    const resetUrl = `${SITE_ORIGIN}/reset-password.html?token=${encodeURIComponent(token)}`;
    await sendEmail(env, email, 'Reset your password',
      `<p>Hi ${row.name ? String(row.name).split(' ')[0] : 'there'},</p>
       <p>Click the button below to set a new password. This link works for ${PASSWORD_RESET_MINUTES} minutes.</p>
       <p style="text-align:center;margin:28px 0;"><a href="${resetUrl}" style="display:inline-block;background:#25a9ea;color:#0d2b45;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:6px;">Reset password</a></p>
       <p style="font-size:13px;color:#75879c;">If you didn't request this, you can safely ignore this email — your password won't change.</p>`,
      { relatedType: 'password_reset', relatedId: row.id });
  }
  // Intentionally the same response either way (see note above).
  return json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
}

async function handleResetPassword({ request, env }) {
  const body = await request.json().catch(() => ({}));
  const token = String(body.token || '');
  const password = String(body.password || '');
  if (!token || !password) throw new HttpError('Missing token or password', 400);
  if (password.length < 6) throw new HttpError('Password must be at least 6 characters', 400);

  const row = await env.DB.prepare('SELECT * FROM password_resets WHERE token = ?').bind(token).first();
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    throw new HttpError('This reset link is invalid or has expired. Request a new one.', 400);
  }

  const hash = await hashPassword(password);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, row.user_id).run();
  await env.DB.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE token = ?").bind(token).run();
  // Same reasoning as the admin-driven password reset: a changed password
  // should actually invalidate whatever session the old one was backing.
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id).run();
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

// Full account management (admin/superadmin) always passes. A delegated
// users:write editor passes too, but only against a target who is
// themselves a plain editor — touching an admin/superadmin account (or
// creating a new one) always needs full access, so delegating users:write
// can't be turned into a path to escalate to admin.
function isFullAccess(user) {
  return user.role === 'admin' || user.role === 'superadmin';
}
async function requireUsersWriteOnTarget(env, user, targetRole) {
  if (isFullAccess(user)) return;
  await requireSection(env, user, 'users', 'write');
  if (targetRole === 'admin' || targetRole === 'superadmin') {
    throw new HttpError("You don't have permission to manage an admin account", 403);
  }
}

// The user list itself is visible to anyone logged in — only the actions
// below (add a user, change permissions, reset someone else's password)
// need the delegable users:write permission.
async function handleListUsers({ env, user }) {
  requireUser(user);
  const { results } = await env.DB.prepare(
    'SELECT id,name,email,role,active,created_at FROM users ORDER BY id'
  ).all();
  return json({ users: results });
}

async function handleGetUserPermissions({ match, env, user }) {
  const targetId = Number(match[1]);
  const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(targetId).first();
  if (!target) throw new HttpError('User not found', 404);
  await requireUsersWriteOnTarget(env, user, target.role);
  const permissions = await getEffectivePermissions(env, { id: targetId, role: target.role });
  return json({ role: target.role, permissions });
}

async function handleSetUserPermissions({ match, request, env, user }) {
  const targetId = Number(match[1]);
  const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(targetId).first();
  if (!target) throw new HttpError('User not found', 404);
  await requireUsersWriteOnTarget(env, user, target.role);
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
  const targetId = Number(match[1]);
  const target = await env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(targetId).first();
  if (!target) throw new HttpError('User not found', 404);
  await requireUsersWriteOnTarget(env, user, target.role);
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

// Self-service — any logged-in user, of any role, changing their own
// password. Separate from handleSetUserPassword above (an admin-driven
// reset of someone ELSE's password): this one needs the current password
// instead of a permission check, since proving you already know the old
// password is what makes this safe for literally everyone to call on
// themselves, write permission or not.
async function handleChangeOwnPassword({ request, env, user }) {
  requireUser(user);
  const body = await request.json().catch(() => ({}));
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 6) throw new HttpError('New password must be at least 6 characters', 400);
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
  if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
    throw new HttpError('Current password is incorrect', 401);
  }
  const hash = await hashPassword(newPassword);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, user.id).run();
  // Drop every OTHER session on this account (same reasoning as an admin
  // reset — a changed password should actually log out anyone else using
  // the old one) but keep the session making this very request valid, so
  // changing your own password doesn't also log yourself out.
  const token = bearerToken(request);
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').bind(user.id, token).run();
  return json({ ok: true });
}

async function handleDeleteUser({ match, env, user }) {
  const targetId = Number(match[1]);
  if (targetId === user.id) throw new HttpError("You can't delete your own account", 400);
  const target = await env.DB.prepare('SELECT id, role, email FROM users WHERE id = ?').bind(targetId).first();
  if (!target) throw new HttpError('User not found', 404);
  await requireUsersWriteOnTarget(env, user, target.role);
  if (target.email === SUPERADMIN_EMAIL) throw new HttpError("The superadmin account can't be deleted", 400);
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetId).run();
  await env.DB.prepare('DELETE FROM user_permissions WHERE user_id = ?').bind(targetId).run();
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId).run();
  return json({ ok: true });
}

async function handleCreateUser({ request, env, user }) {
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const role = String(body.role || 'editor');
  await requireUsersWriteOnTarget(env, user, role);
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
  if (body.parsha) {
    await env.DB.prepare('INSERT OR IGNORE INTO custom_parshiyot (name) VALUES (?)')
      .bind(String(body.parsha).trim()).run().catch(() => {});
  }
}

const ORDER_COLUMN = { simchas: 'date_added' };

// One combined read for the home page's mosaic instead of five separate
// requests (posts/posters/events/videos/pdfs each as their own round
// trip) — same data, one network round trip. Capped at the 60 most
// recent per type, which is already far more than the home page's mosaic
// + "more news" strip ever show; a full, uncapped list per type is still
// available from each type's own /api/<type> endpoint (used by Browse &
// Edit and the dedicated section pages).
// A post/poster/event-without-its-own-thumbnail/direct-upload-video shows
// whatever's alphabetically first in its R2 "folder" as its thumbnail.
// The client used to resolve this itself — one extra /api/r2-list round
// trip PER tile, awaited one at a time — which was the actual dominant
// cost on the home page (far more than the five content-list requests
// already combined into this endpoint). Resolving it here instead, with
// a direct R2 binding call (no HTTP round trip at all) run in parallel
// across every row, means the client never has to make that call itself.
async function firstImageKey(env, folderUrl) {
  if (!folderUrl) return null;
  try {
    const listed = await env.R2.list({ prefix: folderUrl, limit: 25 });
    const keys = listed.objects.map((o) => o.key).sort();
    return keys[0] || null;
  } catch (e) { return null; }
}

function youtubeIdServer(url) {
  if (!url) return null;
  const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}

async function getHomeFeedPayload(env) {
  const tables = ['posts', 'posters', 'events', 'videos', 'pdfs'];
  // The home feed is purely a public-page feed (no admin consumer) — a
  // scheduled item with a future publish_at is always excluded here,
  // unconditionally.
  const resultsArr = await Promise.all(tables.map((t) => {
    const orderCol = ORDER_COLUMN[t] || 'date';
    return env.DB.prepare(
      `SELECT * FROM ${t} WHERE deleted_at IS NULL AND (publish_at IS NULL OR publish_at <= datetime('now')) ORDER BY ${orderCol} DESC, id DESC LIMIT 60`
    ).all();
  }));
  const payload = {};
  tables.forEach((t, i) => { payload[t] = resultsArr[i].results; });

  // Posts/posters always need their gallery's first image; events/videos
  // only need it as a fallback (an event's own thumb_url wins if set, a
  // video's YouTube thumbnail wins if its URL has one) — skip the R2 call
  // entirely whenever it won't end up being used anyway. PDFs always have
  // their own thumb_url with no folder fallback, so they're untouched.
  await Promise.all([
    ...payload.posts.map(async (r) => { r.first_image_key = await firstImageKey(env, r.folder_url); }),
    ...payload.posters.map(async (r) => { r.first_image_key = await firstImageKey(env, r.folder_url); }),
    ...payload.events.map(async (r) => { if (!r.thumb_url) r.first_image_key = await firstImageKey(env, r.folder_url); }),
    ...payload.videos.map(async (r) => { if (!youtubeIdServer(r.video_url)) r.first_image_key = await firstImageKey(env, r.folder_url); }),
  ]);
  return payload;
}

async function handleHomeFeed({ env, ctx }) {
  const cache = caches.default;
  const cacheKey = new Request('https://cache.internal/home-feed');
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const payload = await getHomeFeedPayload(env);
  const response = new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=30' },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ── HOME PAGE SSR (mosaic pre-rendered server-side) ──────────────────
// The home page's mosaic used to be entirely client-rendered: blank page
// -> fetch -> build DOM. Instead, GET / is now intercepted (see
// wrangler.toml's [assets] run_worker_first) so the mosaic's HTML can be
// baked directly into the page before it's ever sent to the browser — the
// visitor's very first paint already has real content, no fetch/render
// gap to cover with the loading overlay. The whole rendered page is then
// cached the same way the API responses above are, so this only actually
// costs a D1+R2 round trip once per cache window, not once per visitor.
// zmanim/daf/upcoming (personalized/geolocated, or just lower priority)
// stay exactly as before — client-fetched after the page is already
// visible, per the user's own call that those can land a moment later.

// Minimal Hebrew-date conversion (Gregorian ISO -> Hebrew display
// string) — mirrors hebrew-dates.js's isoToHebrewString and everything it
// depends on. Duplicated here (rather than shared) because that file is
// written for the browser (attaches to window.MOISDES) and this runs in
// the Worker; keep the two in sync if the calendar math there ever
// changes. See hebrew-dates.js for the derivation/verification notes.
const HEB_PARTS_PER_HOUR = 1080;
const HEB_PARTS_PER_DAY = 25920;
const HEB_MONTH_PARTS = 29 * HEB_PARTS_PER_DAY + 12 * HEB_PARTS_PER_HOUR + 793;
const HEB_EPOCH_PARTS = 1 * HEB_PARTS_PER_DAY + 5 * HEB_PARTS_PER_HOUR + 204;
const HEB_EPOCH = 347996;
const HEB_MONTH_NAMES_REGULAR = ['תשרי', 'חשון', 'כסלו', 'טבת', 'שבט', 'אדר', 'ניסן', 'אייר', 'סיון', 'תמוז', 'אב', 'אלול'];
const HEB_MONTH_NAMES_LEAP = ['תשרי', 'חשון', 'כסלו', 'טבת', 'שבט', 'אדר א', 'אדר ב', 'ניסן', 'אייר', 'סיון', 'תמוז', 'אב', 'אלול'];

function gregorianToJDN(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const y2 = y + 4800 - a;
  const m2 = m + 12 * a - 3;
  return d + Math.floor((153 * m2 + 2) / 5) + 365 * y2 + Math.floor(y2 / 4) -
    Math.floor(y2 / 100) + Math.floor(y2 / 400) - 32045;
}
function isHebrewLeapYearServer(year) { return ((7 * year + 1) % 19) < 7; }
function monthsElapsedServer(year) { return Math.floor((235 * year - 234) / 19); }
function moladPartsServer(year) { return HEB_EPOCH_PARTS + monthsElapsedServer(year) * HEB_MONTH_PARTS; }
function roshHashanaDayServer(year) {
  const totalParts = moladPartsServer(year);
  let rhDay = Math.floor(totalParts / HEB_PARTS_PER_DAY) + 1;
  const partsInDay = totalParts % HEB_PARTS_PER_DAY;
  const dow = (rhDay - 1) % 7;
  const leap = isHebrewLeapYearServer(year);
  const prevLeap = isHebrewLeapYearServer(year - 1);
  if (partsInDay >= 18 * HEB_PARTS_PER_HOUR) rhDay += 1;
  else if (!leap && dow === 2 && partsInDay >= 9 * HEB_PARTS_PER_HOUR + 204) rhDay += 1;
  else if (prevLeap && dow === 1 && partsInDay >= 15 * HEB_PARTS_PER_HOUR + 589) rhDay += 1;
  const finalDow = (rhDay - 1) % 7;
  if (finalDow === 0 || finalDow === 3 || finalDow === 5) rhDay += 1;
  return rhDay;
}
function hebrewYearLengthServer(year) { return roshHashanaDayServer(year + 1) - roshHashanaDayServer(year); }
function monthNamesServer(year) { return isHebrewLeapYearServer(year) ? HEB_MONTH_NAMES_LEAP : HEB_MONTH_NAMES_REGULAR; }
function monthLengthsServer(year) {
  const leap = isHebrewLeapYearServer(year);
  const yl = hebrewYearLengthServer(year);
  const base = leap ? yl - 30 : yl;
  let cheshvan, kislev;
  if (base === 353) { cheshvan = 29; kislev = 29; }
  else if (base === 354) { cheshvan = 29; kislev = 30; }
  else { cheshvan = 30; kislev = 30; }
  const lengths = [30, cheshvan, kislev, 29, 30];
  if (leap) lengths.push(30, 29); else lengths.push(29);
  lengths.push(30, 29, 30, 29, 30, 29);
  return lengths;
}
function jdnToHebrewServer(jdn) {
  let year = Math.round((jdn - HEB_EPOCH) / 365.2468);
  while (HEB_EPOCH + roshHashanaDayServer(year) > jdn) year--;
  while (HEB_EPOCH + roshHashanaDayServer(year + 1) <= jdn) year++;
  const lengths = monthLengthsServer(year);
  let remaining = jdn - (HEB_EPOCH + roshHashanaDayServer(year));
  let month = 1;
  while (remaining >= lengths[month - 1]) { remaining -= lengths[month - 1]; month++; }
  return { year, month, day: remaining + 1 };
}
const HEB_HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת'];
const HEB_TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
const HEB_ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
function gematriaServer(n) {
  let h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), o = n % 10, r = '';
  while (h > 4) { r += 'ת'; h -= 4; }
  r += HEB_HUNDREDS[h] || '';
  const to = t * 10 + o;
  if (to === 15) return r + 'ט"ו';
  if (to === 16) return r + 'ט"ז';
  r += HEB_TENS[t] || '';
  r += HEB_ONES[o] || '';
  if (r.length === 0) return '';
  if (r.length === 1) return r + "'";
  return r.slice(0, -1) + '"' + r.slice(-1);
}
function isoToHebrewStringServer(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const heb = jdnToHebrewServer(gregorianToJDN(y, m, d));
  return `${gematriaServer(heb.day)} ${monthNamesServer(heb.year)[heb.month - 1]} ${gematriaServer(heb.year - 5000)}`;
}

function r2UrlServer(key) {
  return `/api/r2/${String(key).split('/').map(encodeURIComponent).join('/')}`;
}

// Mirrors home.js's TYPE_META/titleFor/imageFor/dateDesc + the mosaic's
// "featured post + one of every type + fill by recency" selection and
// its renderMosaicTile markup — keep in sync if that file's mosaic logic
// changes. Only the mosaic (above-the-fold, first paint) is rendered
// server-side; the "more news" strip below it stays client-rendered,
// same as before.
const HOME_TYPE_META = {
  post: { label: 'בלאג', href: (d) => `/blog/post.html?id=${d.id}` },
  poster: { label: 'מודעה', href: (d) => `/posters#poster-${d.id}` },
  event: { label: 'מעמד', href: (d) => `/events/post.html?id=${d.id}` },
  video: { label: 'ווידיאו', href: (d) => `/video/post.html?id=${d.id}` },
  pdf: { label: 'גליון', href: (d) => `/pdfs#pdf-${d.id}` },
};
function homeTitleFor(type, data) {
  if (type === 'poster') return data.parsha ? `מודעה — ${data.parsha}` : 'מודעה';
  return data.title || '';
}
function homeImageFor(type, data) {
  if (type === 'event') return data.thumb_url ? r2UrlServer(data.thumb_url) : (data.first_image_key ? r2UrlServer(data.first_image_key) : null);
  if (type === 'video') {
    const ytId = youtubeIdServer(data.video_url);
    if (ytId) return `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
    return data.first_image_key ? r2UrlServer(data.first_image_key) : null;
  }
  if (type === 'pdf') return data.thumb_url ? r2UrlServer(data.thumb_url) : null;
  return data.first_image_key ? r2UrlServer(data.first_image_key) : null;
}
function dateDescServer(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return b.localeCompare(a);
}

function renderHomeMosaicHtml(payload) {
  const byType = {
    post: [...(payload.posts || [])],
    poster: [...(payload.posters || [])],
    event: [...(payload.events || [])],
    video: [...(payload.videos || [])],
    pdf: [...(payload.pdfs || [])],
  };
  const allFlat = Object.entries(byType).flatMap(([type, arr]) => arr.map((data) => ({ type, data })));
  allFlat.sort((a, b) => dateDescServer(a.data.date, b.data.date));
  if (!allFlat.length) return null;

  const chosen = [];
  const chosenSet = new Set();
  function add(type, data) {
    const k = `${type}-${data.id}`;
    if (chosenSet.has(k)) return;
    chosenSet.add(k);
    chosen.push({ type, data });
  }
  if (byType.post[0]) add('post', byType.post[0]);
  ['poster', 'event', 'video', 'pdf'].forEach((t) => { if (byType[t][0]) add(t, byType[t][0]); });
  for (const it of allFlat) {
    if (chosen.length >= 10) break;
    add(it.type, it.data);
  }
  chosen.sort((a, b) => dateDescServer(a.data.date, b.data.date));

  const SIZE_BY_INDEX = { 0: 'mosaic-big', 2: 'mosaic-tall', 3: 'mosaic-wide', 7: 'mosaic-tall', 8: 'mosaic-wide' };
  return chosen.map(({ type, data }, i) => {
    const meta = HOME_TYPE_META[type];
    const img = homeImageFor(type, data);
    const sizeClass = SIZE_BY_INDEX[i] || '';
    return `<a class="mosaic-item${sizeClass ? ' ' + sizeClass : ''}" href="${escapeHtmlMail(meta.href(data))}">
      ${img ? `<div class="mosaic-media" style="background-image:url('${escapeHtmlMail(img)}')"></div>` : ''}
      <div class="mosaic-overlay">
        <span class="mosaic-badge">${meta.label}</span>
        <div class="mosaic-title">${escapeHtmlMail(homeTitleFor(type, data))}</div>
        <div class="mosaic-date">${isoToHebrewStringServer(data.date)}</div>
      </div>
    </a>`;
  }).join('');
}

async function handleHomePage({ request, env, ctx }) {
  const cache = caches.default;
  const cacheKey = new Request('https://cache.internal/home-page-html');
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const assetResponse = await env.ASSETS.fetch(request);
  if (!assetResponse.ok || !assetResponse.headers.get('content-type')?.includes('text/html')) return assetResponse;

  const payload = await getHomeFeedPayload(env);
  const mosaicHtml = renderHomeMosaicHtml(payload);
  let html = await assetResponse.text();
  if (mosaicHtml) {
    html = html
      .replace(
        '<div class="mosaic" id="home-mosaic"><p class="state-msg">לאדט...</p></div>',
        `<div class="mosaic" id="home-mosaic" data-ssr="1">${mosaicHtml}</div>`
      )
      // The mosaic is already visible the instant this HTML paints — the
      // full-screen loading overlay (meant to cover the gap while it was
      // being fetched/built client-side) would otherwise still sit on
      // top of it until home.js's own JS gets around to hiding it.
      .replace('<div id="loading-overlay">', '<div id="loading-overlay" class="hidden">');
  }

  const response = new Response(html, {
    status: assetResponse.status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=30' },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleListContent({ match, url, env, user, ctx }) {
  const table = match[1];
  const isCsv = url.searchParams.get('format') === 'csv';

  // Anonymous reads (the public site's own pages) are cached for a short
  // while — this is the same data on every request until someone
  // publishes/edits, so there's no reason to hit D1 for every single page
  // view. Authenticated requests (admin Browse & Edit, which also needs
  // the uploaded_by attribution below) always go straight to D1 instead,
  // since that attribution must never leak into a cache shared by anyone.
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.internal/content-list/${table}`);
  if (!user && !isCsv) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const orderCol = ORDER_COLUMN[table] || 'date';
  // A scheduled (publish_at in the future) item stays invisible to an
  // anonymous request — exactly like "deleted", just time-gated instead
  // of permanent — but an authenticated admin request still sees it (so
  // Browse & Edit can show/manage what's scheduled before it goes live).
  const scheduleClause = SCHEDULABLE_TYPES.includes(table) && !user
    ? "AND (publish_at IS NULL OR publish_at <= datetime('now'))"
    : '';
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${table} WHERE deleted_at IS NULL ${scheduleClause} ORDER BY ${orderCol} DESC, id DESC`
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

  if (isCsv) {
    const cols = ['id', ...CONTENT_FIELDS[table]];
    const lines = [cols.map(csvEscape).join(',')];
    for (const r of results) lines.push(cols.map((c) => csvEscape(r[c])).join(','));
    return new Response(lines.join('\n'), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${table}.csv"` },
    });
  }

  if (!user) {
    const response = new Response(JSON.stringify({ [table]: results }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=30' },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
  return json({ [table]: results });
}

// Clears handleListContent's/handleHomeFeed's cached public reads for a
// table right after a write to it, instead of leaving a stale list up for
// however long is left on its TTL — a freshly-published item should show
// up on the live site immediately, not after a wait.
async function bustContentCache(table) {
  const cache = caches.default;
  await Promise.all([
    cache.delete(new Request(`https://cache.internal/content-list/${table}`)),
    cache.delete(new Request('https://cache.internal/home-feed')),
    cache.delete(new Request('https://cache.internal/home-page-html')),
  ]);
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
  await bustContentCache(table);
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
  await bustContentCache(table);
  return json({ ok: true });
}

async function handleDeleteContent({ match, env, user }) {
  const table = match[1];
  await requireSection(env, user, table, 'write');
  const id = match[2];
  await env.DB.prepare(`UPDATE ${table} SET deleted_at = datetime('now') WHERE id = ?`).bind(id).run();
  await bustContentCache(table);
  return json({ ok: true });
}

async function handleTags({ env }) {
  const { results } = await env.DB.prepare('SELECT name, featured FROM tags ORDER BY name').all();
  return json({
    tags: results.map((r) => r.name),
    featured: results.filter((r) => r.featured).map((r) => r.name),
  });
}

async function handleSetTagFeatured({ request, env, user }) {
  requireUser(user);
  const perms = await getEffectivePermissions(env, user);
  if (!perms.posts?.write && !perms.events?.write && !perms.videos?.write) {
    throw new HttpError("You don't have write access to tags", 403);
  }
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (!name) throw new HttpError('Tag name is required', 400);
  await env.DB.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').bind(name).run();
  await env.DB.prepare('UPDATE tags SET featured = ? WHERE name = ?').bind(body.featured ? 1 : 0, name).run();
  return json({ ok: true });
}

// Renames a tag everywhere at once: the shared `tags` registry (so it
// shows up under its new name in every picker going forward) and every
// already-published post/event/video that had the old name in its own
// comma-separated tags column — otherwise a rename would only affect
// future uploads and leave every existing item still labeled with the
// old name.
async function renameTagInContentTable(env, table, from, to) {
  const { results } = await env.DB.prepare(`SELECT id, tags FROM ${table} WHERE tags LIKE ?`).bind(`%${from}%`).all();
  for (const row of results) {
    const list = (row.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    if (!list.includes(from)) continue; // LIKE can match a substring of a different tag — only touch an exact token
    const updated = [...new Set(list.map((t) => (t === from ? to : t)))];
    await env.DB.prepare(`UPDATE ${table} SET tags = ? WHERE id = ?`).bind(updated.join(', '), row.id).run();
  }
}

async function handleRenameTag({ request, env, user }) {
  requireUser(user);
  const perms = await getEffectivePermissions(env, user);
  // Tags aren't their own section — they're shared across posts/events/
  // videos — so renaming one just needs write access to at least one of
  // those, same bar as adding a new tag already clears today.
  if (!perms.posts?.write && !perms.events?.write && !perms.videos?.write) {
    throw new HttpError("You don't have write access to tags", 403);
  }
  const body = await request.json().catch(() => ({}));
  const from = String(body.from || '').trim();
  const to = String(body.to || '').trim();
  if (!from || !to) throw new HttpError('Both the old and new tag name are required', 400);
  if (from === to) return json({ ok: true });

  await env.DB.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').bind(to).run();
  await env.DB.prepare('DELETE FROM tags WHERE name = ?').bind(from).run();

  for (const table of ['posts', 'events', 'videos']) {
    await renameTagInContentTable(env, table, from, to);
    await bustContentCache(table);
  }
  return json({ ok: true });
}

async function handleCategories({ env }) {
  const { results } = await env.DB.prepare('SELECT name FROM categories ORDER BY name').all();
  return json({ categories: results.map((r) => r.name) });
}

async function handleCustomParshiyot({ env }) {
  const { results } = await env.DB.prepare('SELECT name FROM custom_parshiyot ORDER BY name').all();
  return json({ parshiyot: results.map((r) => r.name) });
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

// ── HANDLERS: email center ───────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleListEmails({ env, user }) {
  await requireSection(env, user, 'emails', 'read');
  const { results } = await env.DB.prepare(
    'SELECT * FROM emails_sent ORDER BY id DESC LIMIT 200'
  ).all();
  return json({ emails: results });
}

// Manual send from the Email Center — the one place in this app that can
// mail an arbitrary address, as opposed to the system-triggered sends
// (password reset, form notifications) that only ever mail an address
// already on file somewhere.
async function handleSendEmail({ request, env, user }) {
  await requireSection(env, user, 'emails', 'write');
  const body = await request.json().catch(() => ({}));
  const to = String(body.to || '').trim().toLowerCase();
  const subject = String(body.subject || '').trim();
  const bodyHtml = String(body.bodyHtml || '');
  if (!EMAIL_RE.test(to)) throw new HttpError('Enter a valid email address', 400);
  if (!subject) throw new HttpError('Subject is required', 400);
  const result = await sendEmail(env, to, subject, bodyHtml, { sentBy: user.id });
  if (result.dryRun) return json({ ok: true, dryRun: true, message: 'BREVO_API_KEY isn’t configured yet — logged, nothing actually sent.' });
  if (!result.ok) throw new HttpError(`Email provider rejected the send: ${String(result.error || '').slice(0, 300)}`, 502);
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

async function handleGcalEvents({ env, ctx }) {
  const calendarId = env.GCAL_CALENDAR_ID;
  if (!calendarId) throw new HttpError('GCAL_CALENDAR_ID is not configured on the Worker', 500);

  // This was being re-fetched + re-parsed from Google on every single page
  // load (home page's "upcoming" strip included) — a slow external fetch
  // for data that only changes when someone edits the calendar. Cached the
  // same way the Hebcal endpoints already are.
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.internal/gcal-events?id=${encodeURIComponent(calendarId)}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

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
  const response = new Response(JSON.stringify({ events: events.slice(0, 300) }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=600' },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleGcalSubscribeUrl({ env }) {
  const calendarId = env.GCAL_CALENDAR_ID;
  if (!calendarId) throw new HttpError('GCAL_CALENDAR_ID is not configured on the Worker', 500);
  return json({ url: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(calendarId)}` });
}

// ── GOOGLE CALENDAR WRITE (service account) ──────────────────────────
//
// The two handlers above only ever read the calendar's public iCal feed.
// Creating events needs real write credentials — a Google service account
// (env.GCAL_SERVICE_ACCOUNT_JSON, the full JSON key as a string secret)
// that's been given "Make changes to events" access on the calendar in
// Google Calendar's sharing settings. See GOOGLE_CALENDAR_SETUP.md for the
// one-time setup. Workers have no googleapis SDK, so this signs a JWT by
// hand with Web Crypto and exchanges it for an access token exactly like
// any OAuth2 service-account flow.

// Module-level — survives for the life of this Worker isolate, so most
// requests reuse the cached token instead of signing + exchanging a fresh
// JWT every single time (same pattern as the `migrated` flag elsewhere).
let gcalTokenCache = { token: null, exp: 0 };

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (gcalTokenCache.token && gcalTokenCache.exp > now) return gcalTokenCache.token;

  const raw = env.GCAL_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new HttpError('GCAL_SERVICE_ACCOUNT_JSON is not configured on the Worker — see GOOGLE_CALENDAR_SETUP.md', 500);
  let creds;
  try { creds = JSON.parse(raw); } catch (e) { throw new HttpError('GCAL_SERVICE_ACCOUNT_JSON is not valid JSON', 500); }

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(creds.private_key || ''),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64UrlEncode(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new HttpError(`Google auth failed: ${data.error_description || data.error || 'unknown error'}`, 502);
  }

  gcalTokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) - 60 };
  return data.access_token;
}

async function handleCreateGcalEvent({ request, env, user }) {
  await requireSection(env, user, 'calendar', 'write');
  const calendarId = env.GCAL_CALENDAR_ID;
  if (!calendarId) throw new HttpError('GCAL_CALENDAR_ID is not configured on the Worker', 500);

  const body = await request.json().catch(() => ({}));
  const title = String(body.title || '').trim();
  const startDate = String(body.startDate || '').trim();
  const endDate = String(body.endDate || startDate).trim();
  const startTime = String(body.startTime || '').trim();
  const endTime = String(body.endTime || '').trim();
  const location = String(body.location || '').trim();
  const description = String(body.description || '');
  if (!title) throw new HttpError('Title is required', 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new HttpError('A valid start date is required', 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new HttpError('A valid end date is required', 400);

  const timeZone = env.GCAL_TIMEZONE || 'America/New_York';
  const allDay = !startTime && !endTime;

  let start, end;
  if (allDay) {
    start = { date: startDate };
    // Google's end.date is EXCLUSIVE — bump one day past the last day so a
    // single-day pick (start === end) still renders as that one day
    // instead of a zero-length event.
    const endObj = new Date(`${endDate}T00:00:00Z`);
    endObj.setUTCDate(endObj.getUTCDate() + 1);
    end = { date: endObj.toISOString().slice(0, 10) };
  } else {
    start = { dateTime: `${startDate}T${startTime || '00:00'}:00`, timeZone };
    end = { dateTime: `${endDate}T${endTime || startTime || '23:59'}:00`, timeZone };
  }

  const accessToken = await getGoogleAccessToken(env);
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: title, description, location, start, end }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(`Google Calendar rejected the event: ${data.error?.message || 'unknown error'}`, 502);

  // So the event just created shows up immediately instead of waiting out
  // handleGcalEvents' 10-minute cache.
  const cache = caches.default;
  await cache.delete(new Request(`https://cache.internal/gcal-events?id=${encodeURIComponent(calendarId)}`));

  return json({ ok: true, event: { id: data.id, htmlLink: data.htmlLink } });
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
// Only used for embedding untrusted user input (form answers) into an
// outgoing email's HTML — this API worker otherwise only ever emits
// JSON, so nothing else here handles HTML at all.
function escapeHtmlMail(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

async function handleFormSubmit({ match, request, env, ctx }) {
  const slug = normalizeSlug(match[1]);
  const form = await findFormBySlug(env, slug);
  if (!form) throw new HttpError('Form not found', 404);
  const settings = safeParse(form.settings, {});
  if (settings.status === 'closed') throw new HttpError('This form is closed', 403);

  const { results: validFields } = await env.DB.prepare('SELECT id, label FROM form_fields WHERE form_id = ?').bind(form.id).all();
  const validIds = new Set(validFields.map((f) => String(f.id)));
  const labelById = Object.fromEntries(validFields.map((f) => [String(f.id), f.label]));

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

  // Per-form "email me on new submissions" (set in the form's Settings
  // tab) — best-effort and fire-and-forget: a notification failure must
  // never surface as a failed submission to whoever just filled it out.
  if (settings.notifyEmail && settings.notifyAddress && EMAIL_RE.test(settings.notifyAddress)) {
    const rows = Object.entries(answers)
      .filter(([fieldId, value]) => validIds.has(String(fieldId)) && value !== '' && value != null)
      .map(([fieldId, value]) => {
        const label = labelById[String(fieldId)] || 'Answer';
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return `<tr><td style="padding:4px 14px 4px 0;color:#75879c;vertical-align:top;white-space:nowrap;">${escapeHtmlMail(label)}</td><td style="padding:4px 0;">${escapeHtmlMail(text)}</td></tr>`;
      }).join('');
    // Cloudflare can tear the worker down right after the response is
    // sent — waitUntil keeps it alive long enough for the fetch to Brevo
    // and the emails_sent log write to actually finish, instead of this
    // send silently racing the response and sometimes losing.
    ctx.waitUntil(
      sendEmail(env, settings.notifyAddress, `New response: ${form.title || 'Form'}`,
        `<p>A new response came in for <strong>${escapeHtmlMail(form.title || 'your form')}</strong>.</p>
         <table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:14px;">${rows}</table>`,
        { relatedType: 'form_notify', relatedId: form.id }
      ).catch(() => {})
    );
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

// Deletes one submitted response — distinct from handleDeleteForm, which
// soft-deletes the whole form. This only removes the one logged
// submission row (and its answers); the form itself and every other
// response are untouched.
async function handleDeleteResponse({ match, env, user }) {
  await requireSection(env, user, 'forms', 'write');
  const formId = Number(match[1]);
  const responseId = Number(match[2]);
  await env.DB.prepare('DELETE FROM form_answers WHERE response_id = ?').bind(responseId).run();
  await env.DB.prepare('DELETE FROM form_responses WHERE id = ? AND form_id = ?').bind(responseId, formId).run();
  return json({ ok: true });
}

// ── ROUTER ────────────────────────────────────────────────────────────

const routes = [
  // handleHomePage (SSR'd mosaic) is intentionally NOT routed right now —
  // see the comment in wrangler.toml's [assets] block. "/" is served
  // directly by Cloudflare's static-assets layer, same as every other
  // file in public/, until that's sorted out.
  ['GET', /^\/api\/ping$/, handlePing],
  ['POST', /^\/api\/login$/, handleLogin],
  ['POST', /^\/api\/logout$/, handleLogout],
  ['POST', /^\/api\/forgot-password$/, handleForgotPassword],
  ['POST', /^\/api\/reset-password$/, handleResetPassword],
  ['GET', /^\/api\/me$/, handleMe],
  ['POST', /^\/api\/refresh$/, handleRefresh],
  ['GET', /^\/api\/users$/, handleListUsers],
  ['POST', /^\/api\/users$/, handleCreateUser],
  ['DELETE', /^\/api\/users\/(\d+)$/, handleDeleteUser],
  ['GET', /^\/api\/users\/(\d+)\/permissions$/, handleGetUserPermissions],
  ['PUT', /^\/api\/users\/(\d+)\/permissions$/, handleSetUserPermissions],
  ['PUT', /^\/api\/users\/(\d+)\/password$/, handleSetUserPassword],
  ['PUT', /^\/api\/me\/password$/, handleChangeOwnPassword],
  ['GET', /^\/api\/tags$/, handleTags],
  ['PUT', /^\/api\/tags\/rename$/, handleRenameTag],
  ['PUT', /^\/api\/tags\/featured$/, handleSetTagFeatured],
  ['GET', /^\/api\/categories$/, handleCategories],
  ['GET', /^\/api\/parshiyot-custom$/, handleCustomParshiyot],
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
  ['DELETE', /^\/api\/forms\/(\d+)\/responses\/(\d+)$/, handleDeleteResponse],
  ['PUT', /^\/api\/forms\/(\d+)$/, handleUpdateForm],
  ['DELETE', /^\/api\/forms\/(\d+)$/, handleDeleteForm],
  ['GET', /^\/api\/home-feed$/, handleHomeFeed],
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
  ['POST', /^\/api\/gcal-events$/, handleCreateGcalEvent],
  ['GET', /^\/api\/gcal-subscribe-url$/, handleGcalSubscribeUrl],
  ['GET', /^\/api\/settings$/, handleGetSettings],
  ['PUT', /^\/api\/settings$/, handleUpdateSettings],
  ['GET', /^\/api\/emails$/, handleListEmails],
  ['POST', /^\/api\/emails\/send$/, handleSendEmail],
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
  // Belt-and-suspenders fallback: every static file is normally served
  // directly by Cloudflare's edge without ever reaching this Worker (only
  // "/" is routed through first — see wrangler.toml's run_worker_first).
  // If that ever changes, or something else unmatched slips through,
  // hand any non-API GET to the asset binding instead of a bare 404 —
  // keeps a real request for a real file working either way.
  if (request.method === 'GET' && !url.pathname.startsWith('/api/') && env.ASSETS) {
    return env.ASSETS.fetch(request);
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
