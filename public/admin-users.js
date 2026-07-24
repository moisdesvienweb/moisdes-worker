// ================================================================
// MOISDES ADMIN — Users panel
// admin-users.js
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.adminUsers = (function () {
  const api = window.MOISDES.api;

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function load() {
    const tbody = document.querySelector('#users-table tbody');
    tbody.innerHTML = '<tr><td colspan="5">Loading…</td></tr>';
    try {
      const { users } = await api.get('/api/users');
      tbody.innerHTML = '';
      users.forEach((u) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${escapeHtml(u.name)}</td>
          <td>${escapeHtml(u.email)}</td>
          <td>${escapeHtml(u.role)}</td>
          <td>${u.active ? 'Yes' : 'No'}</td>
          <td>${escapeHtml((u.created_at || '').slice(0, 10))}</td>`;
        tbody.appendChild(tr);
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5">${escapeHtml(e.message || 'Failed to load')}</td></tr>`;
    }
  }

  function init() {
    const form = document.getElementById('new-user-form');
    const msg = document.getElementById('users-msg');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api.post('/api/users', {
          name: document.getElementById('nu-name').value.trim(),
          email: document.getElementById('nu-email').value.trim(),
          password: document.getElementById('nu-password').value,
          role: document.getElementById('nu-role').value,
        });
        msg.textContent = 'User created.';
        msg.className = 'state-msg';
        form.reset();
        load();
      } catch (err) {
        msg.textContent = err.message || 'Could not create user.';
      }
      btn.disabled = false;
    });

    load();
  }

  return { init, reload: load };
})();
