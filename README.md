
# kampus-sagatama

Portal Universitas Digital berbasis Web3 / Pi Network — bagian dari ekosistem
**Sagatama** (`sagatama-mart`, `sagatama-games`, `hidayatulamin`,
`website-sagatama`, `portal-sagatama`).

## Arsitektur

```
Pi Browser (HTML/CSS/Vanilla JS)
        │  Pi.authenticate() → accessToken
        ▼
Firebase Hosting (Spark, gratis)  ── /api/** rewrite ──▶  Cloud Functions "api"
   (index.html, app.js, style.css)                         (Express, Node 20)
        │                                                        │
        │  signInWithCustomToken()                                │ verifyPiAccessToken()
        ▼                                                        │ (server-side, ke Pi Platform API)
Firebase Auth (uid = pi_username)                                │
        │                                                        │ HMAC S2S (SGT_INTERNAL_SECRET)
        ▼                                                        ▼
Firestore (mahasiswa/{pi_username})                     portal-sagatama (ledger SGT terpusat)
   IPK, nilai, presensi, riwayat tx (read-only ke client)   saldo, credit, debit, sinkronisasi
```

**Prinsip keamanan inti:**
- Frontend **tidak pernah** menyimpan `SGT_INTERNAL_SECRET`. Secret ini hanya
  hidup di environment Cloud Functions.
- Login tanpa password: `pi_username` diverifikasi ke Pi Platform API oleh
  backend, lalu backend mint **Firebase Custom Token** (`uid = pi_username`)
  supaya Firestore Security Rules & `verifyIdToken()` bisa memvalidasi setiap
  request tanpa sistem password terpisah.
- Semua mutasi saldo SGT (reward, klaim sertifikat) **wajib** lewat backend —
  client tidak pernah menulis langsung ke ledger atau ke field akademik
  sensitif di Firestore (lihat `firestore.rules`, `allow write: if false`).
- Reward akademik memakai *reward table* di server (`REWARD_TABLE`), bukan
  angka yang dikirim client, untuk mencegah manipulasi.

## Struktur folder

```text
kampus-sagatama/
├── public/                  # Static assets → Firebase Hosting (Spark, gratis)
│   ├── index.html
│   ├── js/
│   │   ├── pi-auth.js       # Pi SDK init + tukar token ke Firebase Auth
│   │   ├── sgt-client.js    # Fetch saldo SGT & aksi akademik
│   │   └── app.js           # Wiring DOM + boot sequence
│   └── css/
│       └── style.css
├── functions/                # Cloud Functions (Blaze plan wajib, lihat catatan)
│   ├── index.js              # Express API: auth, akademik, sgt/*, webhook
│   └── package.json
├── firebase.json
├── .firebaserc
├── firestore.rules
├── firestore.indexes.json
└── .env.example
```

## Setup lokal

```bash
npm install -g firebase-tools
firebase login

cd kampus-sagatama/functions
npm install
cp ../.env.example .env   # isi SGT_INTERNAL_SECRET, PORTAL_SAGATAMA_URL, PI_API_KEY

cd ..
firebase emulators:start
```

Isi `public/js/app.js` bagian `firebaseConfig` dengan nilai dari
**Firebase Console → Project settings → General → Your apps** (nilai ini
publik/aman ditaruh di frontend, berbeda dari `SGT_INTERNAL_SECRET`).

## Deploy

```bash
firebase deploy --only hosting,functions,firestore:rules
```

## ⚠️ Catatan penting soal Spark Plan

- **Hosting** dan **Firestore** 100% gratis di Spark Plan sesuai permintaan.
- **Cloud Functions** dengan outbound network call (memanggil Pi Platform API
  & `portal-sagatama`) secara resmi **mewajibkan upgrade ke Blaze**
  (pay-as-you-go). Blaze tetap gratis selama pemakaian di bawah kuota Spark —
  Google hanya mewajibkan kartu billing terpasang sebagai jaga-jaga terhadap
  penyalahgunaan. Karena 4 project lain di ekosistem Sagatama kemungkinan
  sudah menerapkan pola S2S serupa, project ini mengikuti pola yang sama demi
  konsistensi arsitektur ekosistem.
- Alternatif jika ingin benar-benar 0 Cloud Functions: pindahkan Express API
  ini ke Cloud Run / VPS ringan, lalu Firebase Hosting cukup melakukan
  `rewrites` ke URL eksternal tersebut. Struktur kode di `functions/index.js`
  tetap bisa dipakai ulang (tinggal bungkus `app.listen()` alih-alih
  `functions.https.onRequest`).

## Kontrak API dengan `portal-sagatama`

Backend ini mengasumsikan `portal-sagatama` menyediakan endpoint berikut
(sesuaikan path bila kontrak aktual berbeda):

| Method | Path                              | Keterangan                        |
|--------|------------------------------------|------------------------------------|
| GET    | `/ledger/balance/:piUsername`      | Ambil saldo SGT terkini            |
| POST   | `/ledger/credit`                   | Tambah saldo (reward akademik)     |
| POST   | `/ledger/debit`                    | Kurangi saldo (klaim sertifikat)   |
| POST   | `/users/register-app`              | Daftarkan user aktif di app ini    |

Setiap request S2S ditandatangani header `X-SGT-Client`, `X-SGT-Timestamp`,
`X-SGT-Signature` (HMAC-SHA256 dari `SGT_INTERNAL_SECRET`).
