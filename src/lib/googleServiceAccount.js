// src/lib/googleServiceAccount.js
//
// Cloudflare Workers bukan runtime Node.js, jadi tidak bisa pakai
// `firebase-admin`. Di sini kita implementasikan sendiri alur OAuth2
// "Service Account JWT Bearer" milik Google memakai `jose` (Web Crypto),
// supaya Worker bisa dapat access token untuk memanggil Firestore REST API.

import { SignJWT, importPKCS8 } from "jose";

const TOKEN_CACHE = new Map(); // key: clientEmail -> { accessToken, expiresAt }

/**
 * @param {{client_email:string, private_key:string, project_id:string}} serviceAccount
 * @param {string[]} scopes
 * @returns {Promise<string>} access token
 */
export async function getGoogleAccessToken(serviceAccount, scopes) {
  const cacheKey = serviceAccount.client_email + scopes.join(",");
  const cached = TOKEN_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.accessToken;
  }

  const privateKey = await importPKCS8(serviceAccount.private_key, "RS256");

  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({
    scope: scopes.join(" "),
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(serviceAccount.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gagal mendapatkan Google access token: ${errText}`);
  }

  const data = await response.json();
  TOKEN_CACHE.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });

  return data.access_token;
}

/**
 * Parse service account JSON yang disimpan sebagai secret (base64-encoded)
 * di environment variable Worker.
 * @param {string} base64Json
 */
export function parseServiceAccount(base64Json) {
  const jsonStr = atob(base64Json);
  return JSON.parse(jsonStr);
}
