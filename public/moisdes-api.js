// ================================================================
// MOISDES — API CLIENT
// moisdes-api.js
// Thin fetch wrapper around the Worker API + auth token storage.
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.api = (function () {
  const TOKEN_KEY = 'moisdes_token';
  const USER_KEY = 'moisdes_user';

  function base() { return window.MOISDES.CFG.apiBase; }
  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; } }
  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  async function request(method, path, body) {
    const headers = {};
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(base() + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

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

  return {
    getToken, getUser, setSession, clearSession,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body || {}),
    put: (path, body) => request('PUT', path, body || {}),
    del: (path, body) => request('DELETE', path, body),

    async login(email, password) {
      const data = await request('POST', '/api/login', { email, password });
      setSession(data.token, data.user);
      return data.user;
    },
    async logout() {
      try { await request('POST', '/api/logout'); } catch (e) { /* ignore */ }
      clearSession();
    },
    isLoggedIn() { return !!getToken() && !!getUser(); },

    // Direct browser -> R2 upload via a Worker-issued presigned URL.
    async uploadFile(key, file) {
      const { url } = await request('POST', '/api/presign', { key, mime: file.type || 'application/octet-stream' });
      const res = await fetch(url, { method: 'PUT', body: file });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      return key;
    },

    r2Url(key) { return `${base()}/api/r2/${key.split('/').map(encodeURIComponent).join('/')}`; },

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
