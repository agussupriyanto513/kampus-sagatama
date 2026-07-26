/**
 * public/js/pi-auth.js
 * -----------------------------------------------------------------------
 * Inisialisasi Pi SDK + alur login "kampus-sagatama".
 *
 * Alur:
 *   1. Pi.authenticate() -> dapat { user, accessToken } dari Pi Browser.
 *   2. Kirim accessToken ke backend kita (/api/auth/pi-login).
 *   3. Backend verifikasi accessToken LANGSUNG ke Pi Platform API
 *      (server-side, tidak bisa dipalsukan dari console browser).
 *   4. Backend mengembalikan Firebase Custom Token (uid = pi_username).
 *   5. Kita signInWithCustomToken() ke Firebase Auth (compat SDK) supaya
 *      semua request Firestore & panggilan API selanjutnya punya identitas
 *      yang bisa diverifikasi (req.auth.uid / decoded ID token).
 *
 * Modul ini tidak memakai bundler apapun — murni <script> tag, kompatibel
 * 100% dengan Firebase Hosting Spark Plan (static hosting saja).
 * -----------------------------------------------------------------------
 */

window.KampusSagatama = window.KampusSagatama || {};

(function () {
  const IS_SANDBOX = true; // set false saat submit ke Pi mainnet review

  let piUser = null; // { uid, username } dari Pi SDK
  let firebaseUser = null; // hasil signInWithCustomToken

  function onIncompletePaymentFound(payment) {
    console.warn('[Pi] Ditemukan pembayaran belum selesai:', payment);
    // Untuk kasus kampus: pembayaran SGT dilakukan lewat backend kita sendiri
    // (bukan Pi Payment native), jadi ini umumnya hanya relevan bila kelak
    // ditambahkan pembayaran Pi asli (mis. biaya kuliah via Pi).
  }

  async function initPiSdk() {
    if (typeof Pi === 'undefined') {
      throw new Error('Pi SDK belum termuat. Pastikan halaman dibuka di Pi Browser.');
    }
    Pi.init({ version: '2.0', sandbox: IS_SANDBOX });
  }

  /**
   * Login penuh: Pi.authenticate -> tukar ke Firebase Custom Token -> sign in.
   * Mengembalikan { piProfile, academicProfile }.
   */
  async function login() {
    await initPiSdk();

    const scopes = ['username'];
    const authResult = await Pi.authenticate(scopes, onIncompletePaymentFound);
    // authResult => { accessToken, user: { uid, username } }
    piUser = authResult.user;

    const res = await fetch('/api/auth/pi-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: authResult.accessToken }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Login ke kampus-sagatama gagal.');
    }

    const { customToken, profile } = await res.json();

    const cred = await firebase.auth().signInWithCustomToken(customToken);
    firebaseUser = cred.user;

    persistSession(profile);
    return { piProfile: piUser, academicProfile: profile };
  }

  function persistSession(profile) {
    // Hanya menyimpan data non-sensitif untuk mempercepat render awal.
    // Sumber kebenaran tetap Firestore/Firebase Auth, ini cuma cache tampilan.
    sessionStorage.setItem(
      'ks_profile_cache',
      JSON.stringify({ piUsername: profile.piUsername, nama: profile.nama })
    );
  }

  function getCachedProfile() {
    try {
      return JSON.parse(sessionStorage.getItem('ks_profile_cache') || 'null');
    } catch {
      return null;
    }
  }

  async function logout() {
    await firebase.auth().signOut();
    sessionStorage.removeItem('ks_profile_cache');
    piUser = null;
    firebaseUser = null;
  }

  /** Mengambil Firebase ID Token segar untuk dipakai sebagai Bearer token API. */
  async function getIdToken() {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('Belum login.');
    return user.getIdToken(/* forceRefresh */ false);
  }

  function onAuthStateChanged(callback) {
    return firebase.auth().onAuthStateChanged(callback);
  }

  window.KampusSagatama.auth = {
    login,
    logout,
    getIdToken,
    getCachedProfile,
    onAuthStateChanged,
  };
})();
