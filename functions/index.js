'use strict';

/**
 * kampus-sagatama — functions/index.js
 * ---------------------------------------------------------------------------
 * Backend tunggal (Firebase Cloud Functions + Express) untuk portal akademik
 * "kampus-sagatama". Tanggung jawab utama:
 *
 *   1. Memverifikasi login Pi Network (access token) LANGSUNG ke Pi Platform
 *      API di sisi server — frontend tidak pernah dipercaya begitu saja.
 *   2. Mint Firebase Custom Token (uid = pi_username) supaya Firestore
 *      Security Rules bisa memvalidasi req.auth.uid tanpa password apapun.
 *   3. Menjadi satu-satunya pihak yang menyimpan & memakai
 *      SGT_INTERNAL_SECRET untuk komunikasi Server-to-Server (HMAC) ke
 *      `portal-sagatama` (ledger SGT terpusat untuk seluruh ekosistem
 *      Sagatama: sagatama-mart, sagatama-games, hidayatulamin,
 *      website-sagatama, dan kampus-sagatama).
 *
 * Secret ini TIDAK PERNAH dikirim ke browser. Frontend hanya bicara ke
 * endpoint /api/** milik Firebase Hosting (lihat rewrites di firebase.json),
 * yang diteruskan ke function `api` di file ini.
 * ---------------------------------------------------------------------------
 */

const functions = require('firebase-functions');
const { logger } = functions;
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// -----------------------------------------------------------------------------
// Konfigurasi lingkungan
// -----------------------------------------------------------------------------
// Gunakan `firebase functions:secrets:set SGT_INTERNAL_SECRET` dkk di production.
// Untuk local dev, taruh nilai ini di functions/.env (lihat .env.example di root).
const {
  SGT_INTERNAL_SECRET,
  PORTAL_SAGATAMA_URL,
  SGT_CLIENT_ID = 'kampus-sagatama',
  PI_API_KEY,
  PI_SANDBOX = 'true',
} = process.env;

const PI_PLATFORM_API = 'https://api.minepi.com/v2';

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
/**
 * Menandatangani payload dengan HMAC-SHA256 memakai SGT_INTERNAL_SECRET.
 * portal-sagatama memverifikasi signature ini sebelum memproses mutasi ledger.
 */
function signPayload(bodyString, timestamp) {
  return crypto
    .createHmac('sha256', SGT_INTERNAL_SECRET)
    .update(`${timestamp}.${bodyString}`)
    .digest('hex');
}

/**
 * Melakukan request S2S ke portal-sagatama dengan header:
 *   X-SGT-Client     : identitas aplikasi pemanggil (kampus-sagatama)
 *   X-SGT-Timestamp  : unix ms, mencegah replay attack (portal menolak > 5 menit)
 *   X-SGT-Signature  : HMAC-SHA256(timestamp + body, SGT_INTERNAL_SECRET)
 */
async function callPortalSagatama(method, path, data) {
  if (!SGT_INTERNAL_SECRET || !PORTAL_SAGATAMA_URL) {
    throw new Error(
      'SGT_INTERNAL_SECRET / PORTAL_SAGATAMA_URL belum dikonfigurasi di environment functions.'
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
  // data => { uid, username, credentials, ... } — sesuai dokumentasi Pi Platform
  return data;
}

// -----------------------------------------------------------------------------
// Express app
// -----------------------------------------------------------------------------
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

/**
 * Middleware: memverifikasi Firebase ID Token (bukan Pi access token) yang
 * dikirim client setelah signInWithCustomToken(...) di frontend.
 * req.piUsername berisi uid (== pi_username) hasil verifikasi.
 */
async function requireFirebaseAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const idToken = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!idToken) {
      return res.status(401).json({ error: 'Missing Authorization Bearer token.' });
    }
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.piUsername = decoded.uid;
    next();
  } catch (err) {
    logger.warn('Auth verification failed', err);
    return res.status(401).json({ error: 'Token tidak valid atau kedaluwarsa.' });
  }
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

    // Verifikasi token LANGSUNG ke Pi Platform API (server-side, tidak percaya client)
    const piUser = await verifyPiAccessToken(accessToken);
    const piUsername = piUser.username;
    if (!piUsername) {
      return res.status(401).json({ error: 'Gagal memverifikasi identitas Pi Network.' });
    }

    const mahasiswaRef = db.collection('mahasiswa').doc(piUsername);
    const snap = await mahasiswaRef.get();

    if (!snap.exists) {
      // Mahasiswa baru: buat profil akademik default + daftarkan ke portal-sagatama
      await mahasiswaRef.set({
        piUsername,
        piUid: piUser.uid || null,
        nama: piUsername,
        nim: `KS-${Date.now().toString().slice(-8)}`,
        prodi: 'Belum Ditentukan',
        semester: 1,
        ipk: 0,
        status: 'aktif',
        sgtBalanceCache: 0,
        sgtBalanceCachedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Beritahu portal-sagatama bahwa user ini kini aktif juga di kampus-sagatama
      // (best-effort — kegagalan di sini tidak boleh menggagalkan proses login).
      try {
        await callPortalSagatama('POST', '/users/register-app', {
          piUsername,
          app: SGT_CLIENT_ID,
        });
      } catch (syncErr) {
        logger.warn('Gagal sinkronisasi user baru ke portal-sagatama', syncErr.message);
      }
    }

    // Mint Firebase Custom Token — uid = pi_username, dipakai Firestore Rules
    const customToken = await admin.auth().createCustomToken(piUsername, {
      app: SGT_CLIENT_ID,
    });

    const profile = (await mahasiswaRef.get()).data();
    return res.json({ customToken, profile });
  } catch (err) {
    logger.error('pi-login error', err.response?.data || err.message);
    return res.status(500).json({ error: 'Login Pi Network gagal diproses.' });
  }
});

// =============================================================================
// 2. AKADEMIK — Profil, nilai, presensi (baca saja dari sisi client)
// =============================================================================
app.get('/akademik/profil', requireFirebaseAuth, async (req, res) => {
  try {
    const snap = await db.collection('mahasiswa').doc(req.piUsername).get();
    if (!snap.exists) return res.status(404).json({ error: 'Profil tidak ditemukan.' });
    return res.json(snap.data());
  } catch (err) {
    logger.error('profil error', err);
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
    logger.error('nilai error', err);
    return res.status(500).json({ error: 'Gagal mengambil data nilai.' });
  }
});

// =============================================================================
// 3. SGT — Saldo real-time (proxy ke portal-sagatama, di-cache di Firestore)
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
    logger.warn('portal-sagatama unreachable, fallback ke cache', err.message);
    // Fallback: portal pusat sedang down -> tampilkan cache terakhir agar UI tidak rusak
    const cached = await db.collection('mahasiswa').doc(piUsername).get();
    const balance = cached.exists ? cached.data().sgtBalanceCache || 0 : 0;
    return res.json({ piUsername, balance, source: 'cache', warning: 'Saldo mungkin tidak real-time.' });
  }
});

// =============================================================================
// 4. SGT — Reward akademik (presensi / tugas / ujian)
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
    // Cegah reward ganda untuk refId yang sama (idempoten via deterministic doc id)
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
    logger.error('reward error', err.response?.data || err.message);
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
    // portal-sagatama akan menolak (400/402) jika saldo SGT tidak cukup
    if (err.response?.status === 402) {
      return res.status(402).json({ error: 'Saldo SGT tidak mencukupi untuk klaim sertifikat ini.' });
    }
    logger.error('klaim-sertifikat error', err.response?.data || err.message);
    return res.status(502).json({ error: 'Gagal memproses klaim sertifikat.' });
  }
});

// =============================================================================
// 6. Webhook masuk (opsional) — portal-sagatama -> kampus-sagatama
// =============================================================================
// Dipakai jika portal-sagatama ingin mendorong update saldo secara proaktif
// (mis. user top-up SGT dari sagatama-mart, kampus-sagatama perlu tahu).
app.post('/webhook/sgt-sync', async (req, res) => {
  try {
    const signature = req.headers['x-sgt-signature'];
    const timestamp = req.headers['x-sgt-timestamp'];
    const bodyString = JSON.stringify(req.body || {});

    if (!signature || !timestamp) {
      return res.status(400).json({ error: 'Header signature/timestamp hilang.' });
    }
    // Tolak request lawas (> 5 menit) untuk mencegah replay attack
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
    logger.error('webhook sgt-sync error', err);
    return res.status(500).json({ error: 'Gagal memproses webhook.' });
  }
});

// Healthcheck sederhana untuk monitoring
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', app: SGT_CLIENT_ID, piSandbox: PI_SANDBOX === 'true' });
});

exports.api = functions
  .region('asia-southeast2')
  .runWith({ secrets: ['SGT_INTERNAL_SECRET', 'PI_API_KEY'] })
  .https.onRequest(app);
