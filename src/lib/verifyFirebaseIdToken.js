// src/lib/verifyFirebaseIdToken.js
//
// Memverifikasi Firebase ID Token yang dikirim client TANPA perlu Admin SDK —
// cukup validasi tanda tangan JWT-nya memakai public key Google (JWKS), lalu
// cocokkan klaim `aud` (project ID) dengan project ID yang terdaftar sebagai
// aplikasi spoke. Ini yang menggantikan peran "secret" di desain sebelumnya:
// hanya token asli, yang ditandatangani Firebase Auth project ybs, yang lolos.

import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const jwks = createRemoteJWKSet(new URL(JWKS_URL));

/**
 * @param {string} idToken
 * @param {string} expectedProjectId  project ID Firebase milik aplikasi spoke
 * @returns {Promise<{uid:string, nim:string|null}>}
 */
export async function verifyFirebaseIdToken(idToken, expectedProjectId) {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: `https://securetoken.google.com/${expectedProjectId}`,
    audience: expectedProjectId,
  });

  return {
    uid: payload.sub,
    nim: payload.nim ?? null, // custom claim yang di-set saat mint custom token
  };
}
