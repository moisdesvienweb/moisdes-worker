# moisdes-worker

Cloudflare Worker API for the Moisdes Vien platform. Single backend for
auth, content CRUD, R2 presigned uploads, and the forms system. See
`src/index.js` for the full implementation — it auto-migrates the D1
schema on every request, so there is nothing to run by hand there.

## Setup

1. Edit `wrangler.toml` and set `database_id` to your D1 database's ID
   (`wrangler d1 list` or the Cloudflare dashboard).
2. Set the R2 S3 API credentials as Worker secrets (needed only for
   presigned upload URLs — the R2 binding itself handles get/list/delete):
   ```
   wrangler secret put R2_ACCESS_KEY_ID
   wrangler secret put R2_SECRET_ACCESS_KEY
   wrangler secret put R2_ACCOUNT_ID
   ```
   Create the key pair at Cloudflare Dashboard → R2 → Manage R2 API
   Tokens → Create → "Object Read & Write" on bucket `moisdes-media`.
   `R2_ACCOUNT_ID` is the `<ACCOUNT-ID>` in that token's endpoint URL
   (`https://<ACCOUNT-ID>.r2.cloudflarestorage.com`).
3. Deploy: `npm install && npm run deploy` (or connect this repo to
   Cloudflare Workers via the dashboard's "Connect to Git" for
   auto-deploy on push to `main`).

## First login

A superadmin account is seeded automatically the first time the D1
schema is created: `tulib.vien@gmail.com` / `buchinger12`. Change the
password from the admin panel after first login.

## API

See the platform site repo for the full endpoint list this Worker
implements (`/api/login`, `/api/posts`, `/api/presign`, `/api/forms/*`,
etc.) — every response, including errors, carries CORS headers via the
`withCORSHeaders` wrapper in `src/index.js`.
