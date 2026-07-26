// src/index.js — entry point Cloudflare Worker

import { verifyFirebaseIdToken } from "./lib/verifyFirebaseIdToken.js";
import { verifyPiAccessToken } from "./lib/piNetworkVerify.js";
import { mintFirebaseCustomToken } from "./lib/mintCustomToken.js";
import { parseServiceAccount } from "./lib/googleServiceAccount.js";
import { getAppConfig, getAppConfigByProjectId } from "./lib/allowedApps.js";
import { processLedgerTransaction, findMappingByPiUid } from "./lib/ledger.js";

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

// Daftar origin frontend yang boleh memanggil Worker ini.
// Tambahkan domain lain di sini kalau ada aplikasi spoke baru / domain custom.
const ALLOWED_ORIGINS = [
  "https://kampus-513.vercel.app",
  "http://localhost:5500", // buat testing lokal
];

function corsHeaders(origin) {
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? "";
    const cors = corsHeaders(origin);

    // Preflight request dari browser (selalu dikirim sebelum POST lintas-origin)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      let response;
      if (request.method === "POST" && url.pathname === "/auth/exchange") {
        response = await handleAuthExchange(request, env);
      } else if (request.method === "POST" && url.pathname === "/ledger/ingest") {
        response = await handleLedgerIngest(request, env);
      } else {
        response = jsonResponse({ error: "Route tidak ditemukan." }, 404);
      }

      // Sisipkan header CORS ke response apapun hasilnya
      for (const [key, value] of Object.entries(cors)) {
        response.headers.set(key, value);
      }
      return response;
    } catch (err) {
      console.error(err);
      return jsonResponse({ error: err.message ?? "Terjadi kesalahan internal." }, 500, cors);
    }
  },
};

/**
 * POST /auth/exchange
 * Body: { sourceApp: string, piAccessToken: string }
 * Return: { token: string, nim: string, portalSagatamaUserId: string }
 */
async function handleAuthExchange(request, env) {
  const { sourceApp, piAccessToken } = await request.json();

  if (!sourceApp || !piAccessToken) {
    return jsonResponse({ error: "sourceApp dan piAccessToken wajib diisi." }, 400);
  }

  const appConfig = getAppConfig(sourceApp, env);
  if (!appConfig) {
    return jsonResponse({ error: `sourceApp "${sourceApp}" tidak dikenal.` }, 400);
  }

  // Verifikasi LANGSUNG ke server Pi Network — tidak percaya klaim dari client
  const { piUid } = await verifyPiAccessToken(piAccessToken);

  const mapping = await findMappingByPiUid(appConfig, piUid);
  if (!mapping) {
    return jsonResponse(
      { error: "Akun Pi Network ini belum ter-mapping ke NIM manapun." },
      404
    );
  }

  const serviceAccount = parseServiceAccount(appConfig.serviceAccountBase64);
  const firebaseUid = `pi_${piUid}`;
  const token = await mintFirebaseCustomToken(serviceAccount, firebaseUid, { nim: mapping.docId });

  return jsonResponse({
    token,
    nim: mapping.docId,
    portalSagatamaUserId: mapping.portalSagatamaUserId,
  });
}

/**
 * POST /ledger/ingest
 * Header: Authorization: Bearer <Firebase ID Token>
 * Body: { portalSagatamaUserId, type, amountSgt, reason, reasonDetail, refId, idempotencyKey }
 */
async function handleLedgerIngest(request, env) {
  const authHeader = request.headers.get("Authorization") ?? "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) {
    return jsonResponse({ error: "Header Authorization: Bearer <idToken> wajib diisi." }, 401);
  }

  const body = await request.json();
  const { sourceApp } = body;
  const appConfig = getAppConfig(sourceApp, env);
  if (!appConfig) {
    return jsonResponse({ error: `sourceApp "${sourceApp}" tidak dikenal.` }, 400);
  }

  // Verifikasi ID token BENAR-BENAR diterbitkan oleh project Firebase aplikasi ini
  let verifiedClaims;
  try {
    verifiedClaims = await verifyFirebaseIdToken(idToken, appConfig.projectId);
  } catch (err) {
    return jsonResponse({ error: "ID token tidak valid: " + err.message }, 401);
  }

  const {
    portalSagatamaUserId,
    type,
    amountSgt,
    reason,
    reasonDetail,
    refId,
    idempotencyKey,
  } = body;

  if (!portalSagatamaUserId || !type || !amountSgt || !reason || !refId || !idempotencyKey) {
    return jsonResponse({ error: "Payload transaksi SGT tidak lengkap." }, 400);
  }
  if (!["earn", "spend"].includes(type)) {
    return jsonResponse({ error: 'type harus "earn" atau "spend".' }, 400);
  }
  if (typeof amountSgt !== "number" || amountSgt <= 0) {
    return jsonResponse({ error: "amountSgt harus angka > 0." }, 400);
  }

  // Sanity check tambahan: pastikan NIM di dalam token (kalau ada) memang
  // pemilik idempotencyKey/refId yang diklaim — dicek longgar di sini,
  // validasi bisnis lebih detail sebaiknya tetap ada di sisi client sebelum kirim.
  if (verifiedClaims.nim && !idempotencyKey.includes(verifiedClaims.nim)) {
    console.warn(
      `[ledger] Peringatan: idempotencyKey "${idempotencyKey}" tidak memuat NIM token ` +
        `(${verifiedClaims.nim}) — lanjut diproses, tapi layak dicek manual.`
    );
  }

  const hubServiceAccountJson = parseServiceAccount(env.SA_PORTAL_SAGATAMA);

  const result = await processLedgerTransaction({
    sourceApp,
    portalSagatamaUserId,
    type,
    amountSgt,
    reason,
    reasonDetail,
    refId,
    idempotencyKey,
    hubServiceAccountJson,
    spokeAppConfig: appConfig,
  });

  return jsonResponse(result, result.status === "rejected" ? 402 : 200);
}
