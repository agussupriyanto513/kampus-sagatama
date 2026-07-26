// src/lib/ledger.js

import { getGoogleAccessToken, parseServiceAccount } from "./googleServiceAccount.js";
import {
  getDoc,
  setDoc,
  queryWhereEquals,
  runBalanceTransaction,
  FIRESTORE_SCOPE,
} from "./firestoreRest.js";

const HUB_PROJECT_ID = "portal-sagatama"; // ganti sesuai project ID Firebase hub Anda asli

/**
 * @param {object} params
 * @param {string} params.sourceApp
 * @param {string} params.portalSagatamaUserId
 * @param {"earn"|"spend"} params.type
 * @param {number} params.amountSgt
 * @param {string} params.reason
 * @param {string} params.reasonDetail
 * @param {string} params.refId
 * @param {string} params.idempotencyKey
 * @param {object} params.hubServiceAccountJson
 * @param {object} params.spokeAppConfig
 * @returns {Promise<{txId:string, status:string}>}
 */
export async function processLedgerTransaction(params) {
  const {
    sourceApp,
    portalSagatamaUserId,
    type,
    amountSgt,
    reason,
    reasonDetail,
    refId,
    idempotencyKey,
    hubServiceAccountJson,
    spokeAppConfig,
  } = params;

  const hubToken = await getGoogleAccessToken(hubServiceAccountJson, [FIRESTORE_SCOPE]);

  // 1. Cek idempotency
  const existing = await queryWhereEquals(
    HUB_PROJECT_ID,
    hubToken,
    "ledger_transactions",
    "idempotencyKey",
    idempotencyKey,
    1
  );
  if (existing.length > 0) {
    return { txId: existing[0].id, status: existing[0].data.status };
  }

  // 2. Update saldo secara atomik (transaksi read-modify-write)
  const balanceDocPath = `user_balances/${portalSagatamaUserId}`;
  let finalStatus = "confirmed";
  let newBalance = 0;

  await runBalanceTransaction(HUB_PROJECT_ID, hubToken, balanceDocPath, (current) => {
    const currentBalance = current?.balance ?? 0;

    if (type === "earn") {
      newBalance = currentBalance + amountSgt;
    } else {
      if (currentBalance < amountSgt) {
        finalStatus = "rejected";
        newBalance = currentBalance; // tidak berubah
        return { balance: currentBalance, lastUpdated: new Date() };
      }
      newBalance = currentBalance - amountSgt;
    }
    return { balance: newBalance, lastUpdated: new Date() };
  });

  // 3. Catat dokumen ledger (audit trail) dengan status akhir
  const txId = crypto.randomUUID();
  await setDoc(HUB_PROJECT_ID, hubToken, `ledger_transactions/${txId}`, {
    txId,
    source_app: sourceApp,
    portalSagatamaUserId,
    type,
    amountSgt,
    reason,
    reasonDetail: reasonDetail ?? "",
    refId,
    idempotencyKey,
    status: finalStatus,
    createdAt: new Date(),
  });

  if (finalStatus === "rejected") {
    return { txId, status: "rejected" };
  }

  // 4. Mirror saldo terbaru balik ke Firestore project spoke
  const spokeServiceAccount = parseServiceAccount(spokeAppConfig.serviceAccountBase64);
  const spokeToken = await getGoogleAccessToken(spokeServiceAccount, [FIRESTORE_SCOPE]);
  await setDoc(
    spokeAppConfig.projectId,
    spokeToken,
    `${spokeAppConfig.mirrorCollection}/${portalSagatamaUserId}`,
    { balance: newBalance, lastUpdated: new Date() },
    { merge: true }
  );

  return { txId, status: "confirmed" };
}

/**
 * Alur login: cari NIM berdasarkan piUid yang SUDAH TERVERIFIKASI ke Pi Platform API
 * di caller (lihat src/index.js), lalu ambil portalSagatamaUserId-nya.
 */
export async function findMappingByPiUid(spokeAppConfig, piUid) {
  const serviceAccount = parseServiceAccount(spokeAppConfig.serviceAccountBase64);
  const token = await getGoogleAccessToken(serviceAccount, [FIRESTORE_SCOPE]);

  const [collection, field] = [spokeAppConfig.mappingCollection, spokeAppConfig.mappingPiUidField];
  const results = await queryWhereEquals(spokeAppConfig.projectId, token, collection, field, piUid, 1);

  if (results.length === 0) return null;

  return {
    docId: results[0].id, // NIM
    portalSagatamaUserId: getNestedField(results[0].data, spokeAppConfig.mappingPortalIdField),
  };
}

/** Ambil nilai nested field pakai path "auth.portalSagatamaUserId" */
function getNestedField(obj, path) {
  return path.split(".").reduce((acc, key) => acc?.[key], obj);
}
