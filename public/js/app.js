/**
 * public/js/app.js
 * -----------------------------------------------------------------------
 * Titik masuk aplikasi. Menghubungkan pi-auth.js + sgt-client.js ke DOM.
 * -----------------------------------------------------------------------
 */

// -----------------------------------------------------------------------
// 1. Konfigurasi Firebase (nilai PUBLIK — aman ditaruh di frontend).
//    Ambil dari Firebase Console > Project settings > General > Your apps.
//    Ini BUKAN secret; keamanan sesungguhnya ada di Firestore Rules +
//    verifyIdToken() di backend, bukan di sini.
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

// -----------------------------------------------------------------------
// 2. Katalog aksi reward & sertifikat (tampilan saja — nilai reward
//    sesungguhnya divalidasi ulang oleh backend, lihat REWARD_TABLE di
//    functions/index.js).
// -----------------------------------------------------------------------
const REWARD_ACTIONS = [
  {
    type: 'presensi_hadir',
    title: 'Presensi Hari Ini',
    desc: 'Konfirmasi kehadiran sesi kuliah berjalan.',
    reward: '+2 SGT',
    refId: () => new Date().toISOString().slice(0, 10), // 1x per hari
  },
  {
    type: 'tugas_selesai',
    title: 'Kumpulkan Tugas Mingguan',
    desc: 'Tandai tugas minggu ini sudah dikumpulkan & dinilai.',
    reward: '+5 SGT',
    refId: () => `tugas-w${getWeekNumber()}`,
  },
  {
    type: 'ujian_lulus',
    title: 'Klaim Kelulusan Ujian',
    desc: 'Klaim reward setelah nilai ujian dinyatakan lulus.',
    reward: '+10 SGT',
    refId: () => `ujian-${new Date().getFullYear()}-${new Date().getMonth() + 1}`,
  },
];

const SERTIFIKAT_CATALOG = [
  { id: 'sertifikat-semester-aktif', name: 'Sertifikat Keaktifan Semester', harga: 15 },
  { id: 'sertifikat-transkrip-digital', name: 'Transkrip Nilai Digital', harga: 20 },
  { id: 'sertifikat-kelulusan-blockchain', name: 'Sertifikat Kelulusan (On-chain)', harga: 25 },
];

function getWeekNumber() {
  const d = new Date();
  const onejan = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
}

// -----------------------------------------------------------------------
// 3. Helpers UI
// -----------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function setConnected(isConnected) {
  $('connDot').classList.toggle('live', isConnected);
  $('connLabel').textContent = isConnected ? 'Terhubung · Pi Sandbox' : 'Belum terhubung';
}

function showDashboard() {
  $('gate').classList.add('hide');
  $('dashboard').classList.add('show');
}

function showGate() {
  $('gate').classList.remove('hide');
  $('dashboard').classList.remove('show');
}

// -----------------------------------------------------------------------
// 4. Render dashboard
// -----------------------------------------------------------------------
function renderKtm(profile, uid) {
  $('ktmNama').textContent = profile.nama || profile.piUsername;
  $('ktmUsername').textContent = `@${profile.piUsername}`;
  $('ktmNim').textContent = profile.nim || '—';
  $('ktmProdi').textContent = profile.prodi || '—';
  $('ktmSemester').textContent = profile.semester ?? '—';
  $('ktmHash').textContent = `uid://${uid} · kampus-sagatama.ledger`;
}

function renderStats(profile, sgtBalance) {
  $('statSaldo').textContent = `${sgtBalance} SGT`;
  $('statSaldoSub').textContent = 'real-time via portal-sagatama';
  $('statIpk').textContent = (profile.ipk ?? 0).toFixed(2);
  $('statStatus').textContent = (profile.status || 'aktif').toUpperCase();
}

function renderActions() {
  const list = $('actionList');
  list.innerHTML = '';
  REWARD_ACTIONS.forEach((action) => {
    const row = document.createElement('div');
    row.className = 'action-row';
    row.innerHTML = `
      <div>
        <div class="title">${action.title}</div>
        <div class="desc">${action.desc}</div>
      </div>
      <div style="display:flex; align-items:center; gap:12px;">
        <span class="reward">${action.reward}</span>
        <button class="btn-mini">Klaim</button>
      </div>
    `;
    const btn = row.querySelector('button');
    btn.addEventListener('click', () => handleClaimReward(action, btn));
    list.appendChild(row);
  });
}

function renderSertifikat() {
  const grid = $('certGrid');
  grid.innerHTML = '';
  SERTIFIKAT_CATALOG.forEach((cert) => {
    const card = document.createElement('div');
    card.className = 'cert-card';
    card.innerHTML = `
      <div class="name">${cert.name}</div>
      <div class="price">${cert.harga} SGT</div>
      <button class="btn-mini">Klaim Sertifikat</button>
    `;
    const btn = card.querySelector('button');
    btn.addEventListener('click', () => handleClaimSertifikat(cert, btn));
    grid.appendChild(card);
  });
}

// -----------------------------------------------------------------------
// 5. Handlers
// -----------------------------------------------------------------------
async function handleClaimReward(action, btn) {
  btn.disabled = true;
  btn.textContent = 'Memproses…';
  try {
    const refId = action.refId();
    const result = await window.KampusSagatama.sgt.claimReward(action.type, refId);
    toast(`Berhasil! +${result.amount} SGT masuk ke saldo kamu.`);
    if (result.newBalance != null) {
      $('statSaldo').textContent = `${result.newBalance} SGT`;
    } else {
      refreshBalance();
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Klaim';
  }
}

async function handleClaimSertifikat(cert, btn) {
  btn.disabled = true;
  btn.textContent = 'Memproses…';
  try {
    const result = await window.KampusSagatama.sgt.claimSertifikat(cert.id, cert.harga);
    toast(`Sertifikat "${cert.name}" berhasil diklaim.`);
    if (result.newBalance != null) {
      $('statSaldo').textContent = `${result.newBalance} SGT`;
    } else {
      refreshBalance();
    }
    btn.textContent = 'Sudah Diklaim';
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
    btn.textContent = 'Klaim Sertifikat';
  }
}

function handleTopupPi() {
  const amountStr = prompt('Berapa Pi yang mau kamu top up ke saldo SGT? (contoh: 1)');
  const amount = Number(amountStr);
  if (!amount || amount <= 0) return;

  const btn = $('btnTopupPi');
  btn.disabled = true;
  btn.textContent = 'Menunggu Pi Browser…';

  window.KampusSagatama.payments.createPayment(
    amount,
    `Top up ${amount} Pi -> SGT (kampus-sagatama)`,
    'topup_sgt',
    {
      onSuccess: (newBalance) => {
        toast(`Top up berhasil! Saldo SGT sekarang ${newBalance ?? '—'}.`);
        if (newBalance != null) $('statSaldo').textContent = `${newBalance} SGT`;
        else refreshBalance();
        btn.disabled = false;
        btn.textContent = 'Top Up via Pi';
      },
      onCancel: () => {
        toast('Top up dibatalkan.');
        btn.disabled = false;
        btn.textContent = 'Top Up via Pi';
      },
      onError: (err) => {
        toast(err.message || 'Top up gagal.', true);
        btn.disabled = false;
        btn.textContent = 'Top Up via Pi';
      },
    }
  );
}

async function refreshBalance() {
  try {
    const { balance } = await window.KampusSagatama.sgt.getBalance();
    $('statSaldo').textContent = `${balance} SGT`;
  } catch (err) {
    console.warn('Gagal refresh saldo', err);
  }
}

// -----------------------------------------------------------------------
// 6. Boot sequence
// -----------------------------------------------------------------------
async function loadDashboardData(uid) {
  try {
    const [profil, balanceRes] = await Promise.all([
      window.KampusSagatama.sgt.getProfil(),
      window.KampusSagatama.sgt.getBalance(),
    ]);
    renderKtm(profil, uid);
    renderStats(profil, balanceRes.balance);
    renderActions();
    renderSertifikat();
    showDashboard();
    setConnected(true);
    $('adminLink').hidden = !profil.isAdmin;
  } catch (err) {
    console.error(err);
    toast('Gagal memuat data akademik. Coba muat ulang halaman.', true);
  }
}

$('btnTopupPi').addEventListener('click', handleTopupPi);

$('btnLogin').addEventListener('click', async () => {
  const btn = $('btnLogin');
  const errorEl = $('gate-error');
  errorEl.textContent = '';
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Menghubungkan ke Pi Network…';
  try {
    await window.KampusSagatama.auth.login();
    // onAuthStateChanged (di bawah) akan mengambil alih render dashboard.
  } catch (err) {
    console.error(err);
    errorEl.textContent = err.message || 'Login gagal. Pastikan dibuka di Pi Browser.';
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Masuk dengan Pi Network';
  }
});

window.KampusSagatama.auth.onAuthStateChanged((user) => {
  if (user) {
    loadDashboardData(user.uid);
  } else {
    showGate();
    setConnected(false);
  }
});
