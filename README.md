# Portal Sagatama Hub — Cloudflare Worker (Gratis, Tanpa Blaze)

Baca `docs-architecture.md` dulu untuk paham alurnya. Ringkasan setup:

## 1. Install & Login Cloudflare (gratis, tanpa kartu kredit)

```bash
npm install
npx wrangler login
```

## 2. Siapkan Service Account (dari Firebase Console, GRATIS di plan Spark)

Untuk **project hub** (`portal-sagatama`) dan **setiap project spoke**
(mis. `siakad-kampus-app`):

1. Firebase Console → ⚙️ Project Settings → Service Accounts
2. Klik "Generate new private key" → download file JSON
3. Encode ke base64:
   ```bash
   base64 -i portal-sagatama-key.json | tr -d '\n' > hub-key-base64.txt
   base64 -i siakad-kampus-app-key.json | tr -d '\n' > siakad-key-base64.txt
   ```

## 3. Set Secrets di Cloudflare Worker

```bash
npx wrangler secret put SA_PORTAL_SAGATAMA
# paste isi hub-key-base64.txt saat diminta

npx wrangler secret put SA_SIAKAD_KAMPUS_APP
# paste isi siakad-key-base64.txt saat diminta
```

## 4. Sesuaikan Project ID

Edit 2 file ini, ganti placeholder project ID dengan project ID Firebase asli Anda:
- `src/lib/ledger.js` → konstanta `HUB_PROJECT_ID`
- `src/lib/allowedApps.js` → field `projectId` tiap aplikasi

## 5. Deploy

```bash
npx wrangler deploy
```

Anda akan dapat URL seperti `https://portal-sagatama-hub.<akun-anda>.workers.dev`.
Simpan URL ini — dipakai di sisi client `siakad-kampus-html`
(`assets/js/firebase-config.js` atau file konfigurasi terpisah, lihat
pembaruan `auth-service.js` & `sgt-service.js`).

## 6. Firestore Security Rules (tetap wajib!)

Worker punya akses penuh via service account (bypass rules), tapi client
tetap harus dibatasi lewat Firestore Security Rules seperti biasa — supaya
kalau ada bug di Worker atau URL-nya disalahgunakan, client tidak bisa
menulis langsung ke `ledger_transactions` / `user_balances` / `saldo_sgt_cache`.
Rules ini sudah ada di masing-masing repo aplikasi (`firestore.rules`).

## 7. Batas Gratis Cloudflare Workers

Free tier: 100.000 request/hari, cukup jauh untuk skala kampus. Kalau nanti
tumbuh besar dan butuh lebih, baru upgrade ke plan berbayar Cloudflare —
tetap jauh lebih murah & sederhana dibanding harus pindah ke Blaze Firebase.
