'use strict';

/**
 * functions/index.js — kampus-sagatama backend, Firebase Cloud Functions (Gen 2).
 * ---------------------------------------------------------------------------
 * PERBAIKAN (lihat README / catatan commit): file ini sebelumnya berisi kode
 * hasil salin-tempel dari versi Vercel (api/index.js) — dibungkus
 * `serverless-http` dan tidak diekspor lewat `functions.https.onRequest`,
 * sehingga TIDAK PERNAH bisa berjalan sebagai Cloud Function. File ini sudah
 * ditulis ulang dalam format native Firebase Functions.
 *
 * Perbedaan dengan versi Vercel (api/index.js):
 *   - Kredensial Firebase Admin otomatis (Application Default Credentials)
 *     karena berjalan di dalam infrastruktur Google Cloud — tidak perlu
 *     env var FIREBASE_SERVICE_ACCOUNT.
 *   - Diekspor sebagai `exports.api = functions.https.onRequest(app)`,
 *     dipetakan ke "/api/**" lewat rewrite di firebase.json.
 *   - Tidak butuh `serverless-http` sama sekali.
 *
 * Logika bisnis (verifikasi Pi, mint custom token, ledger SGT, payments,
 * modul admin) identik dengan api/index.js supaya kedua target deploy
 * (Firebase Hosting+Functions ATAU Vercel) berperilaku sama persis.
 * ---------------------------------------------------------------------------
 */

const functions = require('firebase-functions');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');

// -----------------------------------------------------------------------------
// Init Firebase Admin — di Cloud Functions, applicationDefault() otomatis
// terisi tanpa konfigurasi tambahan.
// -----------------------------------------------------------------------------
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// -----------------------------------------------------------------------------
// Konfigurasi lingkungan
// Set lewat: firebase functions:config:set atau (Gen2/Node20) process.env
// via `firebase functions:secrets:set NAMA` / Environment Variables di
// Firebase Console -> Functions -> Configuration.
// -----------------------------------------------------------------------------
const {
  SGT_INTERNAL_SECRET,
  PORTAL_SAGATAMA_URL,
  SGT_CLIENT_ID = 'kampus-sagatama',
  PI_API_KEY,
  PI_SANDBOX = 'true',
  // Daftar pi_username yang diberi hak admin, dipisah koma, tanpa spasi.
  // Contoh: "budi,siti_admin"
  ADMIN_PI_USERNAMES = '',
} = process.env;

const PI_PLATFORM_API = 'https://api.minepi.com/v2';

const ADMIN_USERNAME_SET = new Set(
  ADMIN_PI_USERNAMES.split(',')
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean)
);

function isAdminUsername(piUsername) {
  return ADMIN_USERNAME_SET.has(String(piUsername || '').toLowerCase());
}

// Tabel reward SGT akademik — sumber kebenaran ada di SERVER, bukan client,
// supaya nilai reward tidak bisa dimanipulasi dari sisi browser.
const REWARD_TABLE = {
  presensi_hadir: 2, // SGT per sesi presensi tepat waktu
  tugas_selesai: 5, // SGT per tugas terkumpul & dinilai
  ujian_lulus: 10, // SGT per ujian dengan nilai lulus
};

const SERTIFIKAT_HARGA_DEFAULT_SGT = 25;

// -----------------------------------------------------------------------------
// Helper: HMAC signing untuk request S2S ke portal-sagatama
// -----------------------------------------------------------------------------
function signPayload(bodyString, timestamp) {
  return crypto
    .createHmac('sha256', SGT_INTERNAL_SECRET)
    .update(`${timestamp}.${bodyString}`)
    .digest('hex');
}

async function callPortalSagatama(method, path, data) {
  if (!SGT_INTERNAL_SECRET || !PORTAL_SAGATAMA_URL) {
    throw new Error(
      'SGT_INTERNAL_SECRET / PORTAL_SAGATAMA_URL belum dikonfigurasi di environment Functions.'
    );
  }
  const timestamp = Date.now().toString();
  const bodyString = JSON.stringify(data || {});
  const signature = signPayload(bodyString, timestamp);

  const response = await axios({
    method,
    url: `${PORTAL_SAGATAMA_URL}${path}`,
    data: data || {},
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      'X-SGT-Client': SGT_CLIENT_ID,
      'X-SGT-Timestamp': timestamp,
      'X-SGT-Signature': signature,
    },
  });
  return response.data;
}

// -----------------------------------------------------------------------------
// Helper: verifikasi access token Pi Network ke Pi Platform API
// -----------------------------------------------------------------------------
async function verifyPiAccessToken(accessToken) {
  const { data } = await axios.get(`${PI_PLATFORM_API}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 8000,
  });
  return data;
}

// -----------------------------------------------------------------------------
// Helper: panggilan S2S ke Pi Platform API untuk Pi Payments asli
// (approve/complete/cancel) — pakai App API Key, bukan token milik user.
// -----------------------------------------------------------------------------
async function callPiPlatform(method, path, data) {
  if (!PI_API_KEY) {
    throw new Error('PI_API_KEY belum dikonfigurasi di environment Functions.');
  }
  const response = await axios({
    method,
    url: `${PI_PLATFORM_API}${path}`,
    data: data || undefined,
    timeout: 10000,
    headers: { Authorization: `Key ${PI_API_KEY}` },
  });
  return response.data;
}

// -----------------------------------------------------------------------------
// Express app
// -----------------------------------------------------------------------------
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// firebase.json me-rewrite "/api/**" ke function ini, dan Cloud Functions
// meneruskan path LENGKAP termasuk prefix "/api". Route di bawah didefinisikan
// tanpa prefix "/api" (mis. "/auth/pi-login"), jadi kita lepas dulu di sini.
app.use((req, _res, next) => {
  if (req.url.startsWith('/api')) {
    req.url = req.url.slice(4) || '/';
  }
  next();
});

async function requireFirebaseAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!idToken) {
      return res.status(401).json({ error: 'Missing Authorization Bearer token.' });
    }
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.piUsername = decoded.uid;
    req.decodedToken = decoded;
    next();
  } catch (err) {
    console.warn('Auth verification failed', err.message);
    return res.status(401).json({ error: 'Token tidak valid atau kedaluwarsa.' });
  }
}

/** Wajib dipasang SETELAH requireFirebaseAuth. Menolak non-admin dengan 403. */
function requireAdmin(req, res, next) {
  if (!req.decodedToken || req.decodedToken.admin !== true) {
    return res.status(403).json({ error: 'Akses ditolak. Akun ini bukan admin.' });
  }
  next();
}

// =============================================================================
// 1. AUTH — Login Pi Network -> Firebase Custom Token
// =============================================================================
app.post('/auth/pi-login', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) {
      return res.status(400).json({ error: 'accessToken wajib dikirim.' });
    }

    const piUser = await verifyPiAccessToken(accessToken);
    const piUsername = piUser.username;
    if (!piUsername) {
      return res.status(401).json({ error: 'Gagal memverifikasi identitas Pi Network.' });
    }

    const isAdmin = isAdminUsername(piUsername);

    const mahasiswaRef = db.collection('mahasiswa').doc(piUsername);
    const snap = await mahasiswaRef.get();

    if (!snap.exists) {
      await mahasiswaRef.set({
        piUsername,
        piUid: piUser.uid || null,
        nama: piUsername,
        nim: `KS-${Date.now().toString().slice(-8)}`,
        prodi: 'Belum Ditentukan',
        semester: 1,
        ipk: 0,
        status: 'aktif',
        isAdmin,
        sgtBalanceCache: 0,
        sgtBalanceCachedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      try {
        await callPortalSagatama('POST', '/users/register-app', {
          piUsername,
          app: SGT_CLIENT_ID,
        });
      } catch (syncErr) {
        console.warn('Gagal sinkronisasi user baru ke portal-sagatama', syncErr.message);
      }
    } else if (snap.data().isAdmin !== isAdmin) {
      // Sinkronkan flag isAdmin di profil setiap kali status whitelist berubah.
      await mahasiswaRef.update({ isAdmin });
    }

    const customToken = await admin.auth().createCustomToken(piUsername, {
      app: SGT_CLIENT_ID,
      admin: isAdmin,
    });

    const profile = (await mahasiswaRef.get()).data();
    return res.json({ customToken, profile, isAdmin });
  } catch (err) {
    console.error('pi-login error', err.response?.data || err.message);
    return res.status(500).json({ error: 'Login Pi Network gagal diproses.' });
  }
});

// =============================================================================
// 2. AKADEMIK — Profil, nilai
// =============================================================================
app.get('/akademik/profil', requireFirebaseAuth, async (req, res) => {
  try {
    const snap = await db.collection('mahasiswa').doc(req.piUsername).get();
    if (!snap.exists) return res.status(404).json({ error: 'Profil tidak ditemukan.' });
    return res.json(snap.data());
  } catch (err) {
    console.error('profil error', err);
    return res.status(500).json({ error: 'Gagal mengambil profil akademik.' });
  }
});

app.get('/akademik/nilai', requireFirebaseAuth, async (req, res) => {
  try {
    const snap = await db
      .collection('mahasiswa')
      .doc(req.piUsername)
      .collection('nilai')
      .orderBy('semester', 'desc')
      .get();
    return res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    console.error('nilai error', err);
    return res.status(500).json({ error: 'Gagal mengambil data nilai.' });
  }
});

// =============================================================================
// 3. SGT — Saldo real-time
// =============================================================================
app.get('/sgt/balance', requireFirebaseAuth, async (req, res) => {
  const piUsername = req.piUsername;
  try {
    const ledger = await callPortalSagatama('GET', `/ledger/balance/${piUsername}`);
    const balance = ledger.balance ?? 0;

    await db.collection('mahasiswa').doc(piUsername).update({
      sgtBalanceCache: balance,
      sgtBalanceCachedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ piUsername, balance, source: 'portal-sagatama' });
  } catch (err) {
    console.warn('portal-sagatama unreachable, fallback ke cache', err.message);
    const cached = await db.collection('mahasiswa').doc(piUsername).get();
    const balance = cached.exists ? cached.data().sgtBalanceCache || 0 : 0;
    return res.json({ piUsername, balance, source: 'cache', warning: 'Saldo mungkin tidak real-time.' });
  }
});

// =============================================================================
// 4. SGT — Reward akademik
// =============================================================================
app.post('/sgt/reward', requireFirebaseAuth, async (req, res) => {
  const piUsername = req.piUsername;
  const { type, refId } = req.body;

  const amount = REWARD_TABLE[type];
  if (!amount) {
    return res.status(400).json({ error: `Tipe reward "${type}" tidak dikenal.` });
  }
  if (!refId) {
    return res.status(400).json({ error: 'refId (id sesi/tugas/ujian) wajib dikirim.' });
  }

  const mahasiswaRef = db.collection('mahasiswa').doc(piUsername);
  const txRef = mahasiswaRef.collection('sgtTransaksi').doc(`${type}_${refId}`);

  try {
    const existing = await txRef.get();
    if (existing.exists) {
      return res.status(409).json({ error: 'Reward untuk aktivitas ini sudah pernah diberikan.' });
    }

    const result = await callPortalSagatama('POST', '/ledger/credit', {
      piUsername,
      amount,
      reason: `kampus-sagatama:${type}`,
      refId,
    });

    await txRef.set({
      type,
      refId,
      amount,
      arah: 'credit',
      portalTxId: result.txId || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true, amount, newBalance: result.newBalance ?? null });
  } catch (err) {
    console.error('reward error', err.response?.data || err.message);
    return res.status(502).json({ error: 'Gagal menyalurkan reward SGT ke portal-sagatama.' });
  }
});

// =============================================================================
// 5. SGT — Klaim sertifikat digital (debit SGT)
// =============================================================================
app.post('/sgt/klaim-sertifikat', requireFirebaseAuth, async (req, res) => {
  const piUsername = req.piUsername;
  const { sertifikatId, hargaSgt } = req.body;
  const harga = Number.isFinite(hargaSgt) ? hargaSgt : SERTIFIKAT_HARGA_DEFAULT_SGT;

  if (!sertifikatId) {
    return res.status(400).json({ error: 'sertifikatId wajib dikirim.' });
  }

  const mahasiswaRef = db.collection('mahasiswa').doc(piUsername);
  const claimRef = mahasiswaRef.collection('sertifikat').doc(sertifikatId);

  try {
    const already = await claimRef.get();
    if (already.exists) {
      return res.status(409).json({ error: 'Sertifikat ini sudah pernah diklaim.' });
    }

    const result = await callPortalSagatama('POST', '/ledger/debit', {
      piUsername,
      amount: harga,
      reason: `kampus-sagatama:sertifikat:${sertifikatId}`,
    });

    await claimRef.set({
      sertifikatId,
      hargaSgt: harga,
      portalTxId: result.txId || null,
      claimedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true, sertifikatId, newBalance: result.newBalance ?? null });
  } catch (err) {
    if (err.response?.status === 402) {
      return res.status(402).json({ error: 'Saldo SGT tidak mencukupi untuk klaim sertifikat ini.' });
    }
    console.error('klaim-sertifikat error', err.response?.data || err.message);
    return res.status(502).json({ error: 'Gagal memproses klaim sertifikat.' });
  }
});

// =============================================================================
// 6. Webhook masuk — portal-sagatama -> kampus-sagatama
// =============================================================================
app.post('/webhook/sgt-sync', async (req, res) => {
  try {
    const signature = req.headers['x-sgt-signature'];
    const timestamp = req.headers['x-sgt-timestamp'];
    const bodyString = JSON.stringify(req.body || {});

    if (!signature || !timestamp) {
      return res.status(400).json({ error: 'Header signature/timestamp hilang.' });
    }
    if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) {
      return res.status(401).json({ error: 'Timestamp kedaluwarsa.' });
    }
    const expected = signPayload(bodyString, timestamp);
    const valid = crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(String(signature), 'hex')
    );
    if (!valid) {
      return res.status(401).json({ error: 'Signature tidak valid.' });
    }

    const { piUsername, newBalance } = req.body;
    if (!piUsername || typeof newBalance !== 'number') {
      return res.status(400).json({ error: 'Payload tidak lengkap.' });
    }

    await db.collection('mahasiswa').doc(piUsername).update({
      sgtBalanceCache: newBalance,
      sgtBalanceCachedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('webhook sgt-sync error', err);
    return res.status(500).json({ error: 'Gagal memproses webhook.' });
  }
});

// =============================================================================
// 7. PI PAYMENTS ASLI (U2A) — top up SGT pakai Pi sungguhan
// =============================================================================
app.post('/payments/approve', requireFirebaseAuth, async (req, res) => {
  const piUsername = req.piUsername;
  const { paymentId, purpose, refId } = req.body;
  if (!paymentId) return res.status(400).json({ error: 'paymentId wajib dikirim.' });

  try {
    const payment = await callPiPlatform('GET', `/payments/${paymentId}`);

    await db.collection('piPayments').doc(paymentId).set({
      paymentId,
      piUsername,
      amount: payment.amount,
      purpose: purpose || 'topup_sgt',
      refId: refId || null,
      status: 'approving',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await callPiPlatform('POST', `/payments/${paymentId}/approve`);
    await db.collection('piPayments').doc(paymentId).update({ status: 'approved' });

    return res.json({ success: true });
  } catch (err) {
    console.error('payments/approve error', err.response?.data || err.message);
    return res.status(502).json({ error: 'Gagal approve payment ke Pi Platform.' });
  }
});

app.post('/payments/complete', requireFirebaseAuth, async (req, res) => {
  const piUsername = req.piUsername;
  const { paymentId, txid } = req.body;
  if (!paymentId || !txid) {
    return res.status(400).json({ error: 'paymentId dan txid wajib dikirim.' });
  }

  const payRef = db.collection('piPayments').doc(paymentId);

  try {
    const snap = await payRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Payment tidak dikenal (belum di-approve?).' });
    const payment = snap.data();

    if (payment.piUsername !== piUsername) {
      return res.status(403).json({ error: 'Payment ini bukan milik user yang login.' });
    }
    if (payment.status === 'completed') {
      return res.json({ success: true, alreadyCompleted: true });
    }

    await callPiPlatform('POST', `/payments/${paymentId}/complete`, { txid });

    try {
      const result = await callPortalSagatama('POST', '/ledger/credit', {
        piUsername,
        amount: payment.amount,
        reason: `kampus-sagatama:pi-payment:${payment.purpose}`,
        refId: paymentId,
      });
      await payRef.update({
        status: 'completed',
        txid,
        newBalance: result.newBalance ?? null,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ success: true, newBalance: result.newBalance ?? null });
    } catch (ledgerErr) {
      console.error('Kredit SGT gagal setelah payment complete', ledgerErr.message);
      await payRef.update({
        status: 'completed_ledger_failed',
        txid,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(207).json({
        success: true,
        warning: 'Pembayaran Pi berhasil, tapi kredit SGT tertunda dan akan direkonsiliasi manual.',
      });
    }
  } catch (err) {
    console.error('payments/complete error', err.response?.data || err.message);
    return res.status(502).json({ error: 'Gagal menyelesaikan payment ke Pi Platform.' });
  }
});

app.post('/payments/cancel', requireFirebaseAuth, async (req, res) => {
  const piUsername = req.piUsername;
  const { paymentId, reason } = req.body;
  if (!paymentId) return res.status(400).json({ error: 'paymentId wajib dikirim.' });

  try {
    await callPiPlatform('POST', `/payments/${paymentId}/cancel`);

    const payRef = db.collection('piPayments').doc(paymentId);
    const snap = await payRef.get();
    if (snap.exists && snap.data().piUsername === piUsername) {
      await payRef.update({
        status: 'cancelled',
        cancelReason: reason || 'user_cancelled',
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('payments/cancel error', err.response?.data || err.message);
    return res.status(502).json({ error: 'Gagal membatalkan payment ke Pi Platform.' });
  }
});

app.post('/payments/incomplete-action', requireFirebaseAuth, async (req, res) => {
  const piUsername = req.piUsername;
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: 'paymentId wajib dikirim.' });

  try {
    const payment = await callPiPlatform('GET', `/payments/${paymentId}`);
    const txid = payment.transaction?.txid;

    if (txid) {
      await callPiPlatform('POST', `/payments/${paymentId}/complete`, { txid });
      await db.collection('piPayments').doc(paymentId).set(
        {
          paymentId,
          piUsername,
          amount: payment.amount,
          status: 'completed',
          txid,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return res.json({ success: true, resolved: 'completed' });
    }

    await callPiPlatform('POST', `/payments/${paymentId}/cancel`);
    await db.collection('piPayments').doc(paymentId).set(
      {
        paymentId,
        piUsername,
        status: 'cancelled',
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return res.json({ success: true, resolved: 'cancelled' });
  } catch (err) {
    console.error('payments/incomplete-action error', err.response?.data || err.message);
    return res.status(502).json({ error: 'Gagal memproses payment yang belum selesai.' });
  }
});

// =============================================================================
// 8. ADMIN — dilindungi requireFirebaseAuth + requireAdmin (whitelist
//    ADMIN_PI_USERNAMES). Semua mutasi data mahasiswa & SGT WAJIB lewat sini,
//    tidak pernah langsung dari client ke Firestore (lihat firestore.rules).
// =============================================================================

app.get('/admin/whoami', requireFirebaseAuth, requireAdmin, async (req, res) => {
  return res.json({ piUsername: req.piUsername, isAdmin: true });
});

app.get('/admin/stats', requireFirebaseAuth, requireAdmin, async (req, res) => {
  try {
    const totalSnap = await db.collection('mahasiswa').count().get();
    const aktifSnap = await db.collection('mahasiswa').where('status', '==', 'aktif').get();
    return res.json({
      totalMahasiswa: totalSnap.data().count,
      totalAktif: aktifSnap.size,
    });
  } catch (err) {
    console.error('admin/stats error', err);
    return res.status(500).json({ error: 'Gagal mengambil statistik.' });
  }
});

app.get('/admin/mahasiswa', requireFirebaseAuth, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    let query = db.collection('mahasiswa').orderBy('createdAt', 'desc').limit(limit);
    const snap = await query.get();
    let items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const search = (req.query.search || '').trim().toLowerCase();
    if (search) {
      items = items.filter(
        (m) =>
          m.piUsername?.toLowerCase().includes(search) ||
          m.nama?.toLowerCase().includes(search) ||
          m.nim?.toLowerCase().includes(search)
      );
    }

    return res.json(items);
  } catch (err) {
    console.error('admin/mahasiswa list error', err);
    return res.status(500).json({ error: 'Gagal mengambil daftar mahasiswa.' });
  }
});

app.get('/admin/mahasiswa/:piUsername', requireFirebaseAuth, requireAdmin, async (req, res) => {
  try {
    const ref = db.collection('mahasiswa').doc(req.params.piUsername);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Mahasiswa tidak ditemukan.' });

    const [nilaiSnap, txSnap, sertifSnap] = await Promise.all([
      ref.collection('nilai').orderBy('semester', 'desc').get(),
      ref.collection('sgtTransaksi').orderBy('createdAt', 'desc').limit(50).get(),
      ref.collection('sertifikat').get(),
    ]);

    return res.json({
      profil: { id: snap.id, ...snap.data() },
      nilai: nilaiSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      transaksi: txSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      sertifikat: sertifSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    });
  } catch (err) {
    console.error('admin/mahasiswa detail error', err);
    return res.status(500).json({ error: 'Gagal mengambil detail mahasiswa.' });
  }
});

const MAHASISWA_EDITABLE_FIELDS = ['nama', 'nim', 'prodi', 'semester', 'ipk', 'status'];

app.patch('/admin/mahasiswa/:piUsername', requireFirebaseAuth, requireAdmin, async (req, res) => {
  try {
    const ref = db.collection('mahasiswa').doc(req.params.piUsername);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Mahasiswa tidak ditemukan.' });

    const updates = {};
    for (const field of MAHASISWA_EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Tidak ada field valid untuk diupdate.' });
    }
    if (updates.semester !== undefined) updates.semester = Number(updates.semester);
    if (updates.ipk !== undefined) updates.ipk = Number(updates.ipk);

    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    updates.updatedBy = req.piUsername;

    await ref.update(updates);
    const fresh = await ref.get();
    return res.json({ success: true, profil: { id: fresh.id, ...fresh.data() } });
  } catch (err) {
    console.error('admin/mahasiswa patch error', err);
    return res.status(500).json({ error: 'Gagal mengupdate data mahasiswa.' });
  }
});

app.post('/admin/mahasiswa/:piUsername/nilai', requireFirebaseAuth, requireAdmin, async (req, res) => {
  try {
    const { mataKuliah, sks, nilai, semester } = req.body;
    if (!mataKuliah || nilai === undefined || semester === undefined) {
      return res.status(400).json({ error: 'mataKuliah, nilai, dan semester wajib diisi.' });
    }
    const ref = db.collection('mahasiswa').doc(req.params.piUsername);
    const parent = await ref.get();
    if (!parent.exists) return res.status(404).json({ error: 'Mahasiswa tidak ditemukan.' });

    const docRef = await ref.collection('nilai').add({
      mataKuliah,
      sks: Number(sks) || 0,
      nilai,
      semester: Number(semester),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.piUsername,
    });

    return res.json({ success: true, id: docRef.id });
  } catch (err) {
    console.error('admin/nilai add error', err);
    return res.status(500).json({ error: 'Gagal menambah nilai.' });
  }
});

app.delete(
  '/admin/mahasiswa/:piUsername/nilai/:nilaiId',
  requireFirebaseAuth,
  requireAdmin,
  async (req, res) => {
    try {
      await db
        .collection('mahasiswa')
        .doc(req.params.piUsername)
        .collection('nilai')
        .doc(req.params.nilaiId)
        .delete();
      return res.json({ success: true });
    } catch (err) {
      console.error('admin/nilai delete error', err);
      return res.status(500).json({ error: 'Gagal menghapus nilai.' });
    }
  }
);

// Penyesuaian saldo SGT manual oleh admin (koreksi, reward khusus, dsb).
// Tetap lewat portal-sagatama supaya ledger pusat selalu jadi sumber kebenaran.
app.post('/admin/sgt/adjust', requireFirebaseAuth, requireAdmin, async (req, res) => {
  const { piUsername, arah, amount, reason } = req.body;
  if (!piUsername || !['credit', 'debit'].includes(arah) || !(Number(amount) > 0)) {
    return res.status(400).json({ error: 'piUsername, arah (credit/debit), dan amount (>0) wajib diisi.' });
  }

  const mahasiswaRef = db.collection('mahasiswa').doc(piUsername);
  const target = await mahasiswaRef.get();
  if (!target.exists) return res.status(404).json({ error: 'Mahasiswa tidak ditemukan.' });

  try {
    const result = await callPortalSagatama('POST', `/ledger/${arah}`, {
      piUsername,
      amount: Number(amount),
      reason: `kampus-sagatama:admin-adjust:${reason || 'tanpa-alasan'}`,
    });

    await mahasiswaRef.collection('sgtTransaksi').add({
      type: 'admin_adjustment',
      arah,
      amount: Number(amount),
      reason: reason || null,
      adminUsername: req.piUsername,
      portalTxId: result.txId || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (result.newBalance != null) {
      await mahasiswaRef.update({
        sgtBalanceCache: result.newBalance,
        sgtBalanceCachedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return res.json({ success: true, newBalance: result.newBalance ?? null });
  } catch (err) {
    if (err.response?.status === 402) {
      return res.status(402).json({ error: 'Saldo SGT tidak mencukupi untuk debit ini.' });
    }
    console.error('admin/sgt/adjust error', err.response?.data || err.message);
    return res.status(502).json({ error: 'Gagal menyesuaikan saldo SGT via portal-sagatama.' });
  }
});

// Healthcheck sederhana
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', app: SGT_CLIENT_ID, piSandbox: PI_SANDBOX === 'true' });
});

exports.api = functions.https.onRequest(app);
