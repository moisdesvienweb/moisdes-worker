// ================================================================
// MOISDES — API CLIENT
// moisdes-api.js
// Thin fetch wrapper around the Worker API + auth token storage.
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.api = (function () {
  const TOKEN_KEY = 'moisdes_token';
  const USER_KEY = 'moisdes_user';
  const PERMS_KEY = 'moisdes_permissions';

  function base() { return window.MOISDES.CFG.apiBase; }
  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; } }
  // Per-section {read,write} map for the logged-in user (admin/superadmin
  // get every section true; an editor gets exactly what was granted).
  // Only meaningful for hiding/disabling UI — the Worker enforces the
  // real boundary server-side regardless of what's cached here.
  function getPermissions() { try { return JSON.parse(localStorage.getItem(PERMS_KEY) || 'null'); } catch (e) { return null; } }
  function setPermissions(permissions) { localStorage.setItem(PERMS_KEY, JSON.stringify(permissions || {})); }
  function setSession(token, user, permissions) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    if (permissions) setPermissions(permissions);
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(PERMS_KEY);
  }

  async function request(method, path, body) {
    const headers = {};
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(base() + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      throw new Error(`Network error calling ${method} ${path}: ${networkErr.message}`);
    }

    const isJson = (res.headers.get('Content-Type') || '').includes('application/json');
    const data = isJson ? await res.json().catch(() => ({})) : await res.text();

    if (!res.ok) {
      const message = (isJson && data && data.error) || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Retries a presigned PUT a couple of times on a genuine network failure
  // (dropped connection, brief wifi hiccup) before giving up — the presign
  // URL is valid for an hour, so re-using it on retry is safe.
  async function putWithRetry(url, body, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fetch(url, { method: 'PUT', body });
      } catch (networkErr) {
        lastErr = networkErr;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
    throw lastErr;
  }

  return {
    getToken, getUser, setSession, clearSession, getPermissions, setPermissions,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body || {}),
    put: (path, body) => request('PUT', path, body || {}),
    del: (path, body) => request('DELETE', path, body),

    async login(email, password) {
      const data = await request('POST', '/api/login', { email, password });
      setSession(data.token, data.user, data.permissions);
      return data.user;
    },
    async logout() {
      try { await request('POST', '/api/logout'); } catch (e) { /* ignore */ }
      clearSession();
    },
    isLoggedIn() { return !!getToken() && !!getUser(); },

    // Direct browser -> R2 upload via a Worker-issued presigned URL.
    // Files above MULTIPART_THRESHOLD go through chunked multipart upload
    // instead of a single PUT. A single large PUT has to survive
    // uninterrupted for however long the whole file takes to transfer —
    // a real recording (e.g. a ~38MB audio file) took 20-100+ seconds and
    // hit net::ERR_CONNECTION_RESET on every attempt (confirmed via a HAR
    // capture). Multipart splits that same file into 10MB chunks, each
    // independently retried, so a mid-upload connection drop loses one
    // chunk's progress instead of the whole file. Lowered well below the
    // old 50MB cutoff so recordings/videos in this size range route
    // through the more resilient path.
    async uploadFile(key, file, onProgress) {
      const MULTIPART_THRESHOLD = 15 * 1024 * 1024; // 15MB
      if (file.size > MULTIPART_THRESHOLD) {
        return this.uploadFileMultipart(key, file, onProgress);
      }
      const { url } = await request('POST', '/api/presign', { key, mime: file.type || 'application/octet-stream' });
      let res;
      try {
        res = await putWithRetry(url, file);
      } catch (networkErr) {
        throw new Error(`Network error PUTting to R2: ${networkErr.message} — if this keeps happening, check that the R2 bucket's CORS policy allows PUT from this site's origin.`);
      }
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      if (onProgress) onProgress(1);
      return key;
    },

    async uploadFileMultipart(key, file, onProgress) {
      const PART_SIZE = 10 * 1024 * 1024; // 10MB per part
      const { uploadId } = await request('POST', '/api/multipart/create', { key });
      const totalParts = Math.ceil(file.size / PART_SIZE);
      const parts = [];

      try {
        for (let i = 0; i < totalParts; i++) {
          const partNumber = i + 1;
          const start = i * PART_SIZE;
          const chunk = file.slice(start, Math.min(start + PART_SIZE, file.size));
          const { url } = await request('POST', '/api/multipart/presign-part', { key, uploadId, partNumber });
          let res;
          try {
            res = await putWithRetry(url, chunk);
          } catch (networkErr) {
            throw new Error(`Network error PUTting part ${partNumber}/${totalParts} to R2: ${networkErr.message} — if this keeps happening, check that the R2 bucket's CORS policy allows PUT from this site's origin.`);
          }
          if (!res.ok) throw new Error(`Part ${partNumber}/${totalParts} failed (${res.status})`);
          const etag = res.headers.get('ETag');
          if (!etag) throw new Error(`Part ${partNumber}/${totalParts} did not return an ETag (check the R2 bucket's CORS ExposeHeaders includes ETag)`);
          parts.push({ partNumber, etag });
          if (onProgress) onProgress((i + 1) / totalParts);
        }
        await request('POST', '/api/multipart/complete', { key, uploadId, parts });
      } catch (err) {
        request('POST', '/api/multipart/abort', { key, uploadId }).catch(() => {});
        throw err;
      }
      return key;
    },

    r2Url(key) { return `${base()}/api/r2/${key.split('/').map(encodeURIComponent).join('/')}`; },

    async renameFile(oldKey, newKey) {
      return request('POST', '/api/r2-rename', { oldKey, newKey });
    },

    async listFolder(prefix) {
      if (!prefix) return [];
      const { keys } = await request('GET', `/api/r2-list?prefix=${encodeURIComponent(prefix)}`);
      return keys;
    },

    // Folder keys sort alphabetically, and uploads are written with a
    // zero-padded index prefix (0001-, 0002-, ...), so the first key is
    // whichever file was placed first in the admin's reorder list.
    async firstImageUrl(folder_url) {
      const keys = await this.listFolder(folder_url).catch(() => []);
      return keys.length ? this.r2Url(keys[0]) : null;
    },
  };
})();
