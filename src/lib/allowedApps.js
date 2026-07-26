// src/lib/allowedApps.js
//
// Registry aplikasi spoke. `env` adalah objek environment binding Worker
// (berisi secrets yang di-set via `wrangler secret put`).

export function getAppConfig(sourceApp, env) {
  const registry = {
    "siakad-kampus-app": {
      projectId: "siakad-kampus-app-prod", // ganti sesuai project ID Firebase asli
      serviceAccountSecretName: "SA_SIAKAD_KAMPUS_APP",
      mirrorCollection: "saldo_sgt_cache",
      mappingCollection: "mahasiswa", // dipakai saat login: cari NIM dari piUid
      mappingPiUidField: "auth.piNetworkUid",
      mappingPortalIdField: "auth.portalSagatamaUserId",
    },
    // Tambahkan aplikasi spoke lain di sini, cth:
    // "sagatama-mart": { projectId: "...", serviceAccountSecretName: "SA_SAGATAMA_MART", ... },
  };

  const config = registry[sourceApp];
  if (!config) return null;

  const secretValue = env[config.serviceAccountSecretName];
  if (!secretValue) return null;

  return { ...config, serviceAccountBase64: secretValue };
}

/** Cari config aplikasi berdasarkan Firebase project ID (dipakai untuk /ledger/ingest) */
export function getAppConfigByProjectId(projectId, env) {
  const allSourceApps = ["siakad-kampus-app"]; // tambah nama app lain di sini juga
  for (const sourceApp of allSourceApps) {
    const config = getAppConfig(sourceApp, env);
    if (config && config.projectId === projectId) {
      return { sourceApp, ...config };
    }
  }
  return null;
}
