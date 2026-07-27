/**
 * public/admin/js/admin.js
 * -----------------------------------------------------------------------
 * Panel admin kampus-sagatama. Login memakai alur Pi Network yang SAMA
 * dengan portal mahasiswa (pi-auth.js) — bukan sistem password terpisah.
 * Hak admin ditentukan di server lewat whitelist ADMIN_PI_USERNAMES, dan
 * dikirim sebagai custom claim `admin: true` di Firebase ID Token. Setiap
 * panggilan /api/admin/* diverifikasi ulang di server (lihat requireAdmin
 * di functions/index.js) — flag di client hanya untuk tampilan.
 * -----------------------------------------------------------------------
 */

// -----------------------------------------------------------------------
// 1. Firebase init (sama seperti public/js/app.js — nilai publik, aman).
// -----------------------------------------------------------------------
const firebaseConfig = {
    apiKey: "AIzaSyDNWOochfAyHjBYUNyq2IAYhA9p7Ie834M",
    authDomain: "portal-sagatama.firebaseapp.com",
    projectId: "portal-sagatama",
    storageBucket: "portal-sagatama.firebasestorage.app",
    messagingSenderId: "372845954028",
    appId: "1:372845954028:web:189f2a3127ea8189b9f6c9"
};
firebase.initializeApp(firebaseConfig);

const $ = (id) => document.getElementById(id);

let currentMahasiswa = null; // piUsername yang sedang dibuka di modal

// -----------------------------------------------------------------------
// 2. Helpers UI
// -----------------------------------------------------------------------
let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

async function authedFetch(path, options = {}) {
  const idToken = await window.KampusSagatama.auth.getIdToken();
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request gagal (${res.status})`);
  return data;
}

function showGate() {
  $('adminGate').hidden = false;
  $('adminDashboard').hidden = true;
  $('adminWho').hidden = true;
}

function showDashboard() {
  $('adminGate').hidden = true;
  $('adminDashboard').hidden = false;
  $('adminWho').hidden = false;
}

// -----------------------------------------------------------------------
// 3. Login / logout
// -----------------------------------------------------------------------
$('btnAdminLogin').addEventListener('click', async () => {
  const btn = $('btnAdminLogin');
  const errorEl = $('adminGateError');
  errorEl.textContent = '';
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Menghubungkan ke Pi Network…';
  try {
    await window.KampusSagatama.auth.login();
    // onAuthStateChanged di bawah akan mengambil alih.
  } catch (err) {
    console.error(err);
    errorEl.textContent = err.message || 'Login gagal. Pastikan dibuka di Pi Browser.';
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Masuk dengan Pi Network';
  }
});

$('btnLogout').addEventListener('click', async () => {
  await window.KampusSagatama.auth.logout();
});

window.KampusSagatama.auth.onAuthStateChanged(async (user) => {
  if (!user) {
    showGate();
    return;
  }
  try {
    // Verifikasi ulang ke server — bukan cuma percaya custom claim di client.
    const who = await authedFetch('/admin/whoami', { method: 'GET' });
    $('adminWhoLabel').textContent = `@${who.piUsername}`;
    $('statAdminUser').textContent = `@${who.piUsername}`;
    showDashboard();
    loadStats();
    loadMahasiswa();
  } catch (err) {
    console.warn('Bukan admin atau gagal verifikasi', err.message);
    $('adminGateError').textContent =
      'Akun Pi Network ini belum terdaftar sebagai admin (ADMIN_PI_USERNAMES).';
    await window.KampusSagatama.auth.logout();
    showGate();
  }
});

// -----------------------------------------------------------------------
// 4. Statistik & daftar mahasiswa
// -----------------------------------------------------------------------
async function loadStats() {
  try {
    const stats = await authedFetch('/admin/stats', { method: 'GET' });
    $('statTotal').textContent = stats.totalMahasiswa ?? '—';
    $('statAktif').textContent = stats.totalAktif ?? '—';
  } catch (err) {
    console.warn('Gagal memuat statistik', err.message);
  }
}

let mahasiswaCache = [];

async function loadMahasiswa() {
  const tbody = $('mahasiswaTableBody');
  tbody.innerHTML = '<tr><td colspan="8" class="admin-empty">Memuat data…</td></tr>';
  try {
    mahasiswaCache = await authedFetch('/admin/mahasiswa', { method: 'GET' });
    renderMahasiswaTable(mahasiswaCache);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="admin-empty">Gagal memuat: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderMahasiswaTable(items) {
  const tbody = $('mahasiswaTableBody');
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="admin-empty">Belum ada mahasiswa terdaftar.</td></tr>';
    return;
  }
  tbody.innerHTML = items
    .map(
      (m) => `
    <tr data-username="${escapeHtml(m.piUsername)}">
      <td>
        <div class="cell-nama">${escapeHtml(m.nama || m.piUsername)}</div>
        <div class="cell-username">@${escapeHtml(m.piUsername)}</div>
      </td>
      <td>${escapeHtml(m.nim || '—')}</td>
      <td>${escapeHtml(m.prodi || '—')}</td>
      <td>${m.semester ?? '—'}</td>
      <td>${(m.ipk ?? 0).toFixed ? (m.ipk ?? 0).toFixed(2) : m.ipk}</td>
      <td><span class="status-pill ${escapeHtml(m.status || 'aktif')}">${escapeHtml(m.status || 'aktif')}</span></td>
      <td>${m.sgtBalanceCache ?? 0} SGT</td>
      <td><button class="btn-mini btn-detail">Kelola</button></td>
    </tr>`
    )
    .join('');

  tbody.querySelectorAll('tr').forEach((row) => {
    row.querySelector('.btn-detail').addEventListener('click', () => {
      openModal(row.dataset.username);
    });
  });
}

$('searchInput').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) return renderMahasiswaTable(mahasiswaCache);
  const filtered = mahasiswaCache.filter(
    (m) =>
      m.piUsername?.toLowerCase().includes(q) ||
      m.nama?.toLowerCase().includes(q) ||
      m.nim?.toLowerCase().includes(q)
  );
  renderMahasiswaTable(filtered);
});

$('btnRefresh').addEventListener('click', () => {
  loadStats();
  loadMahasiswa();
});

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// -----------------------------------------------------------------------
// 5. Modal detail / edit mahasiswa
// -----------------------------------------------------------------------
async function openModal(piUsername) {
  currentMahasiswa = piUsername;
  $('modalOverlay').hidden = false;
  switchTab('profil');
  $('modalNama').textContent = 'Memuat…';
  $('modalUsername').textContent = `@${piUsername}`;

  try {
    const detail = await authedFetch(`/admin/mahasiswa/${encodeURIComponent(piUsername)}`, { method: 'GET' });
    fillProfilForm(detail.profil);
    renderNilaiList(detail.nilai);
    renderSgtPane(detail.profil, detail.transaksi);
  } catch (err) {
    toast(err.message, true);
    closeModal();
  }
}

function closeModal() {
  $('modalOverlay').hidden = true;
  currentMahasiswa = null;
}
$('btnCloseModal').addEventListener('click', closeModal);
$('modalOverlay').addEventListener('click', (e) => {
  if (e.target === $('modalOverlay')) closeModal();
});

document.querySelectorAll('.modal-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

function switchTab(name) {
  document.querySelectorAll('.modal-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.modal-pane').forEach((p) => p.classList.remove('active'));
  $(`pane${name.charAt(0).toUpperCase()}${name.slice(1)}`).classList.add('active');
}

function fillProfilForm(profil) {
  $('modalNama').textContent = profil.nama || profil.piUsername;
  $('fNama').value = profil.nama || '';
  $('fNim').value = profil.nim || '';
  $('fProdi').value = profil.prodi || '';
  $('fSemester').value = profil.semester ?? 1;
  $('fIpk').value = profil.ipk ?? 0;
  $('fStatus').value = profil.status || 'aktif';
}

$('formProfil').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Menyimpan…';
  try {
    const updates = {
      nama: $('fNama').value.trim(),
      nim: $('fNim').value.trim(),
      prodi: $('fProdi').value.trim(),
      semester: Number($('fSemester').value),
      ipk: Number($('fIpk').value),
      status: $('fStatus').value,
    };
    await authedFetch(`/admin/mahasiswa/${encodeURIComponent(currentMahasiswa)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
    toast('Profil berhasil diperbarui.');
    loadMahasiswa();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Perubahan';
  }
});

// --- Nilai ---------------------------------------------------------------
function renderNilaiList(nilaiArr) {
  const wrap = $('nilaiList');
  if (!nilaiArr.length) {
    wrap.innerHTML = '<div class="admin-list-empty">Belum ada nilai tercatat.</div>';
    return;
  }
  wrap.innerHTML = nilaiArr
    .map(
      (n) => `
    <div class="admin-list-item">
      <div>
        <div>${escapeHtml(n.mataKuliah)}</div>
        <div class="meta">Semester ${n.semester} · ${n.sks || 0} SKS</div>
      </div>
      <div class="cell-username">${escapeHtml(n.nilai)}</div>
    </div>`
    )
    .join('');
}

$('formNilai').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await authedFetch(`/admin/mahasiswa/${encodeURIComponent(currentMahasiswa)}/nilai`, {
      method: 'POST',
      body: JSON.stringify({
        mataKuliah: $('nMataKuliah').value.trim(),
        sks: Number($('nSks').value) || 0,
        nilai: $('nNilai').value.trim(),
        semester: Number($('nSemester').value),
      }),
    });
    toast('Nilai berhasil ditambahkan.');
    e.target.reset();
    const detail = await authedFetch(`/admin/mahasiswa/${encodeURIComponent(currentMahasiswa)}`, { method: 'GET' });
    renderNilaiList(detail.nilai);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// --- SGT -------------------------------------------------------------
function renderSgtPane(profil, transaksiArr) {
  $('sgtSaldoCache').textContent = `${profil.sgtBalanceCache ?? 0} SGT`;
  const wrap = $('sgtTxList');
  if (!transaksiArr.length) {
    wrap.innerHTML = '<div class="admin-list-empty">Belum ada riwayat transaksi.</div>';
    return;
  }
  wrap.innerHTML = transaksiArr
    .map(
      (t) => `
    <div class="admin-list-item">
      <div>
        <div>${escapeHtml(t.type || t.reason || '—')}</div>
        <div class="meta">${t.arah === 'debit' ? '−' : '+'}${t.amount} SGT${t.reason ? ' · ' + escapeHtml(t.reason) : ''}</div>
      </div>
    </div>`
    )
    .join('');
}

$('formSgtAdjust').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const result = await authedFetch('/admin/sgt/adjust', {
      method: 'POST',
      body: JSON.stringify({
        piUsername: currentMahasiswa,
        arah: $('sArah').value,
        amount: Number($('sAmount').value),
        reason: $('sReason').value.trim(),
      }),
    });
    toast(`Berhasil. Saldo baru: ${result.newBalance ?? '—'} SGT.`);
    e.target.reset();
    const detail = await authedFetch(`/admin/mahasiswa/${encodeURIComponent(currentMahasiswa)}`, { method: 'GET' });
    renderSgtPane(detail.profil, detail.transaksi);
    loadMahasiswa();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});
