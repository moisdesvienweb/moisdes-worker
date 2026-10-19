// ================================================================
// MOISDES ADMIN — Users panel
// admin-users.js
// ================================================================

window.MOISDES = window.MOISDES || {};

window.MOISDES.adminUsers = (function () {
  const api = window.MOISDES.api;

  // Must match the Worker's SECTIONS list (index.js). "users" is
  // delegable like everything else here, but the backend still blocks a
  // delegated users:write holder from touching an admin/superadmin
  // account or creating a new one — see requireUsersWriteOnTarget there.
  const SECTIONS = [
    ['posts', 'Blog'], ['posters', 'Posters'], ['events', 'Events'],
    ['videos', 'Videos'], ['pdfs', 'PDFs'], ['simchas', 'Simchas'],
    ['forms', 'Forms'], ['daf', 'Daf Calendar'], ['settings', 'Settings'],
    ['emails', 'Email Center'], ['calendar', 'Calendar'], ['users', 'Users'],
  ];

  // Full admin/superadmin, or a delegated users:write grant.
  function canManageUsers() {
    const role = api.getUser()?.role;
    if (role === 'admin' || role === 'superadmin') return true;
    return !!api.getPermissions()?.users?.write;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Toggles an inline permissions-editor row directly under the clicked
  // user's row — built fresh each time so it always reflects the latest
  // saved state (no stale checkbox state left over from a prior open).
  async function openPermissions(userRow, tr) {
    const existing = tr.nextElementSibling;
    if (existing && existing.classList.contains('perm-row')) { existing.remove(); return; }
    document.querySelectorAll('.perm-row').forEach((r) => r.remove());

    const permRow = document.createElement('tr');
    permRow.className = 'perm-row';
    const td = document.createElement('td');
    td.colSpan = 6;
    td.innerHTML = '<div class="state-msg">Loading permissions…</div>';
    permRow.appendChild(td);
    tr.after(permRow);

    try {
      const { permissions } = await api.get(`/api/users/${userRow.id}/permissions`);
      const table = document.createElement('table');
      table.className = 'perm-table';
      table.innerHTML = `<thead><tr><th>Section</th><th>Read</th><th>Write</th></tr></thead>`;
      const tbody = document.createElement('tbody');
      const checks = {};
      SECTIONS.forEach(([key, label]) => {
        const row = document.createElement('tr');
        const readCb = document.createElement('input');
        readCb.type = 'checkbox';
        readCb.checked = !!permissions[key]?.read;
        const writeCb = document.createElement('input');
        writeCb.type = 'checkbox';
        writeCb.checked = !!permissions[key]?.write;
        // Write implies read (an editor who can create/edit content in a
        // section obviously needs to see it too) — keep the two boxes
        // consistent instead of allowing a write-only/no-read state that
        // would just hide the section's own tab from them.
        writeCb.addEventListener('change', () => { if (writeCb.checked) readCb.checked = true; });
        readCb.addEventListener('change', () => { if (!readCb.checked) writeCb.checked = false; });
        const rCell = document.createElement('td'); rCell.appendChild(readCb);
        const wCell = document.createElement('td'); wCell.appendChild(writeCb);
        row.innerHTML = `<td>${escapeHtml(label)}</td>`;
        row.appendChild(rCell);
        row.appendChild(wCell);
        tbody.appendChild(row);
        checks[key] = { readCb, writeCb };
      });
      table.appendChild(tbody);

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn btn-primary btn-sm';
      saveBtn.textContent = 'Save permissions';
      saveBtn.style.marginTop = '.6rem';
      const status = document.createElement('span');
      status.className = 'status-msg';
      status.style.marginInlineStart = '.6rem';

      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        const body = {};
        for (const [key, { readCb, writeCb }] of Object.entries(checks)) {
          body[key] = { read: readCb.checked, write: writeCb.checked };
        }
        try {
          await api.put(`/api/users/${userRow.id}/permissions`, { permissions: body });
          status.textContent = 'Saved.';
          status.className = 'status-msg ok';
        } catch (e) {
          status.textContent = e.message || 'Save failed';
          status.className = 'status-msg err';
        }
        saveBtn.disabled = false;
      });

      td.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'perm-editor';
      wrap.appendChild(table);
      wrap.appendChild(saveBtn);
      wrap.appendChild(status);
      td.appendChild(wrap);
    } catch (e) {
      td.innerHTML = `<div class="state-msg">${escapeHtml(e.message || 'Could not load permissions')}</div>`;
    }
  }

  // Prompts for a new password and saves it — works for any account
  // (editor, admin, or superadmin), since a locked-out user of any role
  // has no other way back in except an admin resetting it for them.
  async function setPassword(u) {
    const pw = prompt(`New password for ${u.name} (${u.email}) — at least 6 characters:`);
    if (pw === null) return; // cancelled
    if (pw.length < 6) { alert('Password must be at least 6 characters.'); return; }
    try {
      await api.put(`/api/users/${u.id}/password`, { password: pw });
      alert(`Password updated for ${u.name}.`);
    } catch (e) {
      alert(e.message || 'Could not update password.');
    }
  }

  async function deleteUser(u) {
    if (!confirm(`Delete ${u.name} (${u.email})? This cannot be undone.`)) return;
    try {
      await api.del(`/api/users/${u.id}`);
      load();
    } catch (e) {
      alert(e.message || 'Could not delete user.');
    }
  }

  // The list itself is visible to everyone who's logged in — only the
  // per-row actions below are gated to whoever can actually manage users.
  async function load() {
    const tbody = document.querySelector('#users-table tbody');
    tbody.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
    const canManage = canManageUsers();
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
        const actionsTd = document.createElement('td');
        // A delegated users:write editor can't touch an admin/superadmin
        // account anyway (the backend blocks it) — hide those actions for
        // them here too rather than show a button that'll just 403.
        const canActOnThisUser = canManage && (u.role === 'editor' || api.getUser()?.role === 'admin' || api.getUser()?.role === 'superadmin');
        if (canActOnThisUser) {
          if (u.role === 'editor') {
            const permBtn = document.createElement('button');
            permBtn.type = 'button';
            permBtn.className = 'btn btn-sm';
            permBtn.textContent = 'Permissions';
            permBtn.addEventListener('click', () => openPermissions(u, tr));
            actionsTd.appendChild(permBtn);
          }
          const pwBtn = document.createElement('button');
          pwBtn.type = 'button';
          pwBtn.className = 'btn btn-sm';
          pwBtn.textContent = 'Set password';
          pwBtn.style.marginInlineStart = u.role === 'editor' ? '.4rem' : '0';
          pwBtn.addEventListener('click', () => setPassword(u));
          actionsTd.appendChild(pwBtn);

          // Can't delete your own account (backend blocks it too) or the
          // seed superadmin account.
          if (u.id !== api.getUser()?.id && u.email !== 'tulib.vien@gmail.com') {
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'btn btn-sm btn-danger';
            delBtn.textContent = 'Delete';
            delBtn.style.marginInlineStart = '.4rem';
            delBtn.addEventListener('click', () => deleteUser(u));
            actionsTd.appendChild(delBtn);
          }
        }
        tr.appendChild(actionsTd);
        tbody.appendChild(tr);
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6">${escapeHtml(e.message || 'Failed to load')}</td></tr>`;
    }
  }

  // Every logged-in user, any role, can change their own password — this
  // never touches /api/users (which the backend still gates behind
  // users:write); it's a separate self-service endpoint.
  function initChangeOwnPassword() {
    const form = document.getElementById('change-password-form');
    const msg = document.getElementById('change-password-msg');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api.put('/api/me/password', {
          currentPassword: document.getElementById('cp-current').value,
          newPassword: document.getElementById('cp-new').value,
        });
        msg.textContent = 'Password updated.';
        msg.className = 'state-msg ok';
        form.reset();
      } catch (err) {
        msg.textContent = err.message || 'Could not update password.';
        msg.className = 'state-msg err';
      }
      btn.disabled = false;
    });
  }

  function init() {
    initChangeOwnPassword();

    const form = document.getElementById('new-user-form');
    const msg = document.getElementById('users-msg');

    if (!canManageUsers()) {
      form.style.display = 'none';
    } else {
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
    }

    load();
  }

  return { init, reload: load };
})();
