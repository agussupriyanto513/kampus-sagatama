// src/lib/mintCustomToken.js
//
// Firebase Custom Token sebenarnya cuma JWT RS256 biasa dengan struktur
// klaim tertentu (lihat spek resmi: firebase.google.com/docs/auth/admin/create-custom-tokens#create_custom_tokens_using_a_third-party_jwt_library).
// Karena Cloudflare Workers tidak bisa pakai Admin SDK, kita tanda tangani
// sendiri pakai private key service account project spoke (`jose`).

import { SignJWT, importPKCS8 } from "jose";

/**
 * @param {{client_email:string, private_key:string}} serviceAccount  milik project SPOKE (bukan hub)
 * @param {string} uid  Firebase UID yang mau dibuatkan token, cth "pi_<piUid>"
 * @param {object} extraClaims  custom claims, cth { nim: "2023510001" }
 */
export async function mintFirebaseCustomToken(serviceAccount, uid, extraClaims = {}) {
  const privateKey = await importPKCS8(serviceAccount.private_key, "RS256");
  const now = Math.floor(Date.now() / 1000);

  return await new SignJWT({
    uid,
    claims: extraClaims,
    // Beberapa versi Firebase Auth client SDK juga membaca custom claims
    // langsung di root payload (bukan hanya di dalam "claims") — disertakan
    // agar kompatibel dengan security rules yang memakai request.auth.token.nim
    ...extraClaims,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(serviceAccount.client_email)
    .setSubject(serviceAccount.client_email)
    .setAudience(
      "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit"
    )
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}
