/**
 * public/js/sgt-client.js
 * -----------------------------------------------------------------------
 * Semua komunikasi ke saldo & transaksi SGT lewat backend kita sendiri
 * (/api/sgt/*). Frontend TIDAK PERNAH memegang SGT_INTERNAL_SECRET —
 * itu hanya hidup di functions/index.js.
 * -----------------------------------------------------------------------
 */

window.KampusSagatama = window.KampusSagatama || {};

(function () {
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
    if (!res.ok) {
      throw new Error(data.error || `Request gagal (${res.status})`);
    }
    return data;
  }

  /** Ambil saldo SGT real-time dari portal-sagatama (via backend). */
  async function getBalance() {
    return authedFetch('/sgt/balance', { method: 'GET' });
  }

  /** Ambil profil akademik (IPK, prodi, semester, dsb). */
  async function getProfil() {
    return authedFetch('/akademik/profil', { method: 'GET' });
  }

  /** Ambil daftar nilai per mata kuliah. */
  async function getNilai() {
    return authedFetch('/akademik/nilai', { method: 'GET' });
  }

  /**
   * Klaim reward SGT untuk aktivitas akademik.
   * type: 'presensi_hadir' | 'tugas_selesai' | 'ujian_lulus'
   * refId: id unik sesi/tugas/ujian (mencegah reward ganda).
   */
  async function claimReward(type, refId) {
    return authedFetch('/sgt/reward', {
      method: 'POST',
      body: JSON.stringify({ type, refId }),
    });
  }

  /** Klaim sertifikat digital dengan membayar sejumlah SGT. */
  async function claimSertifikat(sertifikatId, hargaSgt) {
    return authedFetch('/sgt/klaim-sertifikat', {
      method: 'POST',
      body: JSON.stringify({ sertifikatId, hargaSgt }),
    });
  }

  window.KampusSagatama.sgt = {
    getBalance,
    getProfil,
    getNilai,
    claimReward,
    claimSertifikat,
  };
})();
