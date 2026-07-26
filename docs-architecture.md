# Portal Sagatama Hub — Versi Cloudflare Workers (100% Gratis, Tanpa Blaze)

Firebase Cloud Functions **wajib plan Blaze** (walau pemakaian ringan tetap gratis,
tetap harus attach kartu). Karena semua project Firebase Anda masih di plan
**Spark (gratis)**, hub token dipindah ke **Cloudflare Workers**:
- Gratis selamanya untuk pemakaian skala kampus (100.000 request/hari di free tier).
- Tidak perlu kartu kredit untuk mendaftar/deploy.
- Firestore tetap di plan Spark — Worker mengakses Firestore lewat **REST API**
  (bukan Admin SDK Node.js, karena Workers bukan runtime Node biasa).

---

## Perubahan Desain Keamanan (penting)

Di versi Cloud Functions sebelumnya, tiap aplikasi spoke "berbicara" ke hub
lewat *shared secret*. Sekarang didesain ulang jadi lebih aman & lebih simpel:

| Endpoint | Sebelumnya (Cloud Functions) | Sekarang (Worker) |
|---|---|---|
| Login Pi | Client kirim piUid ke Cloud Function project sendiri | Worker verifikasi `piAccessToken` LANGSUNG ke Pi Platform API (`GET https://api.minepi.com/v2/me`) — tidak bisa dipalsukan |
| Kirim transaksi SGT | Client → Cloud Function (punya secret) → Worker (punya secret lain) | Client kirim **Firebase ID Token** asli (didapat setelah login) langsung ke Worker; Worker verifikasi tanda tangannya ke Google, cocokkan `aud` (project ID) dengan daftar aplikasi terdaftar |

Tidak ada "secret" apapun yang disimpan atau dikirim dari kode client — jadi
walau repo di-upload ke GitHub publik, tidak ada rahasia yang bocor.

---

## Struktur Folder

```
portal-sagatama-worker/
├── wrangler.toml                  # Konfigurasi deploy Cloudflare Worker
├── package.json
└── src/
    ├── index.js                   # Routing: /auth/exchange, /ledger/ingest
    └── lib/
        ├── allowedApps.js         # Registry project ID tiap aplikasi spoke
        ├── googleServiceAccount.js# Ambil OAuth2 access token via service account (Web Crypto, tanpa Node)
        ├── firestoreRest.js       # get/query/commit ke Firestore via REST API
        ├── verifyFirebaseIdToken.js # Verifikasi ID token client (JWKS Google)
        ├── mintCustomToken.js     # Bikin Firebase Custom Token (JWT manual, sesuai spek Firebase)
        ├── piNetworkVerify.js     # Verifikasi piAccessToken ke Pi Platform API
        └── ledger.js              # Logic inti: idempotency, update saldo, mirror-back
```

## Alur Baru

```
[Login]
Client --(piAccessToken)--> Worker /auth/exchange
   Worker verifikasi ke api.minepi.com/v2/me -> dapat piUid asli
   Worker cari mapping piUid -> NIM di Firestore (REST, service account project spoke)
   Worker mint Firebase Custom Token (ditandatangani private key service account project spoke)
   Client signInWithCustomToken(token)

[Transaksi SGT]
Client --(Firebase ID Token, di header Authorization)--> Worker /ledger/ingest
   Worker verifikasi signature ID token via JWKS Google + cocokkan project ID
   -> source_app diketahui dari project ID token tsb (bukan dari klaim client)
   Worker cek idempotencyKey, tulis ledger_transactions (Firestore REST, project hub)
   Worker update saldo (transaksi atomik lewat Firestore REST commit)
   Worker mirror balik saldo ke saldo_sgt_cache project spoke (REST, service account spoke)
```

## Kredensial yang Dibutuhkan (disimpan sebagai Worker Secrets, bukan di kode)

Untuk **project hub** (`portal-sagatama`):
- `SA_PORTAL_SAGATAMA` — JSON key service account project ini (base64), dipakai
  Worker untuk baca/tulis Firestore hub via REST.

Untuk **setiap project spoke** (mis. `siakad-kampus-app`):
- `SA_SIAKAD_KAMPUS_APP` — JSON key service account project spoke (base64),
  dipakai Worker untuk (a) mint custom token & baca mapping NIM, (b) mirror saldo.

Semua service account ini dibuat lewat **Firebase Console → Project Settings →
Service Accounts → Generate new private key** — fitur ini GRATIS, tersedia
juga di plan Spark (yang butuh Blaze hanya *menjalankan* Cloud Functions,
bukan membuat/memakai service account key).
