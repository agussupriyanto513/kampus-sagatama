'use strict';

/**
 * api/index.js — kampus-sagatama backend, versi VERCEL SERVERLESS FUNCTION.
 * ---------------------------------------------------------------------------
 * Ini adalah konversi dari functions/index.js (format Firebase Cloud
 * Functions) menjadi format yang benar-benar jalan di Vercel:
 *   - Satu Express app, dibungkus `serverless-http` supaya bisa dipanggil
 *     sebagai Vercel Serverless Function.
 *   - Semua request ke /api/** diarahkan ke file ini lewat rewrite di
 *     vercel.json ({ source: "/api/(.*)", destination: "/api/index" }).
 *   - Middleware kecil di bawah menghapus prefix "/api" dari req.url supaya
 *     definisi route (app.post('/auth/pi-login', ...)) tidak perlu diubah.
 *
 * Logika bisnis (verifikasi Pi, mint custom token, ledger SGT, dst) TIDAK
 * diubah dari functions/index.js — hanya lapisan pembungkus & init Firebase
 * Admin yang berbeda (Vercel tidak punya Application Default Credentials
 * otomatis seperti Cloud Functions, jadi service account harus di-set lewat
 * environment variable).
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const serverless = require('serverless-http');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');

// -----------------------------------------------------------------------------
// Init Firebase Admin (khusus untuk lingkungan Vercel)
// -----------------------------------------------------------------------------
// Di Vercel, taruh isi JSON service account (Firebase Console -> Project
// Settings -> Service Accounts -> Generate new private key) sebagai SATU
// environment variable bernama FIREBASE_SERVICE_ACCOUNT (paste seluruh isi
// file .json di situ, sebagai string).
if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error(
      'FIREBASE_SERVICE_ACCOUNT belum di-set di Environment Variables Vercel.'
    );
  }
  const serviceAccount = raw ? JSON.parse(raw) : undefined;
  admin.initializeApp({
    credential: serviceAccount
      ? admin.credential.cert(serviceAccount)
      : admin.credential.applicationDefault(),
  });
}
const db = admin.firestore();

// -----------------------------------------------------------------------------
// Konfigurasi lingkungan (set semua ini di Vercel -> Settings -> Environment Variables)
// -----------------------------------------------------------------------------
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
function signPayload(bodyString, timestamp) {
  return crypto
    .createHmac('sha256', SGT_INTERNAL_SECRET)
    .update(`${timestamp}.${bodyString}`)
    .digest('hex');
}

async function callPortalSagatama(method, path, data) {
  if (!SGT_INTERNAL_SECRET || !PORTAL_SAGATAMA_URL) {
    throw new Error(
      'SGT_INTERNAL_SECRET / PORTAL_SAGATAMA_URL belum dikonfigurasi di environment Vercel.'
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
// Express app
// -----------------------------------------------------------------------------
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Vercel meneruskan request dengan path lengkap "/api/auth/pi-login".
// Route di bawah didefinisikan tanpa prefix "/api" (mis. "/auth/pi-login"),
// jadi kita lepas dulu prefix-nya di sini.
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
    next();
  } catch (err) {
    console.warn('Auth verification failed', err.message);
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

    const piUser = await verifyPiAccessToken(accessToken);
    const piUsername = piUser.username;
    if (!piUsername) {
      return res.status(401).json({ error: 'Gagal memverifikasi identitas Pi Network.' });
    }

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
    }

    const customToken = await admin.auth().createCustomToken(piUsername, {
      app: SGT_CLIENT_ID,
    });

    const profile = (await mahasiswaRef.get()).data();
    return res.json({ customToken, profile });
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

// Healthcheck sederhana
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', app: SGT_CLIENT_ID, piSandbox: PI_SANDBOX === 'true' });
});

module.exports = serverless(app);
