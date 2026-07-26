/**
 * public/js/payments-client.js
 * -----------------------------------------------------------------------
 * Pi Payments ASLI (U2A — user membayar dengan Pi sungguhan), berbeda dari
 * sgt-client.js yang cuma memutasi ledger SGT internal. Dipakai untuk fitur
 * seperti "Top Up SGT pakai Pi" atau "Bayar biaya kuliah pakai Pi".
 *
 * Alur (lihat dokumentasi Pi SDK createPayment):
 *   1. Pi.createPayment({ amount, memo, metadata }, callbacks)
 *   2. Pi SDK panggil balik onReadyForServerApproval(paymentId)
 *        -> kita fetch POST /api/payments/approve
 *   3. User approve di Pi Browser, Pi SDK panggil
 *      onReadyForServerCompletion(paymentId, txid)
 *        -> kita fetch POST /api/payments/complete
 *   4. Kalau user batal di tengah jalan -> onCancel(paymentId)
 *        -> kita fetch POST /api/payments/cancel
 * -----------------------------------------------------------------------
 */

window.KampusSagatama = window.KampusSagatama || {};

(function () {
  async function authedFetch(path, body) {
    const idToken = await window.KampusSagatama.auth.getIdToken();
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request gagal (${res.status})`);
    return data;
  }

  /**
   * Mulai pembayaran Pi asli.
   * @param {number} amountPi - jumlah Pi yang dibayar user.
   * @param {string} memo - deskripsi singkat, tampil di Pi Browser.
   * @param {'topup_sgt'|string} purpose - dicatat di Firestore piPayments.
   * @param {object} [callbacks] - opsional: { onSuccess(newBalance), onCancel(), onError(err) }
   */
  function createPayment(amountPi, memo, purpose, callbacks = {}) {
    if (typeof Pi === 'undefined') {
      callbacks.onError?.(new Error('Pi SDK belum termuat. Buka lewat Pi Browser.'));
      return;
    }

    Pi.createPayment(
      {
        amount: amountPi,
        memo,
        metadata: { purpose },
      },
      {
        onReadyForServerApproval: async (paymentId) => {
          try {
            await authedFetch('/payments/approve', { paymentId, purpose });
          } catch (err) {
            console.error('[Pi] approve gagal', err);
            callbacks.onError?.(err);
          }
        },
        onReadyForServerCompletion: async (paymentId, txid) => {
          try {
            const result = await authedFetch('/payments/complete', { paymentId, txid });
            callbacks.onSuccess?.(result.newBalance);
          } catch (err) {
            console.error('[Pi] complete gagal', err);
            callbacks.onError?.(err);
          }
        },
        onCancel: async (paymentId) => {
          try {
            await authedFetch('/payments/cancel', { paymentId, reason: 'user_cancelled' });
          } finally {
            callbacks.onCancel?.();
          }
        },
        onError: (error, payment) => {
          console.error('[Pi] createPayment error', error, payment);
          callbacks.onError?.(error);
        },
      }
    );
  }

  window.KampusSagatama.payments = { createPayment };
})();
