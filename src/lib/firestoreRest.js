// src/lib/firestoreRest.js
//
// Wrapper tipis di atas Firestore REST API. Dipakai karena Cloudflare Workers
// tidak bisa memakai Firebase Admin SDK (itu Node-only). Semua fungsi di sini
// butuh access token dari googleServiceAccount.js.

const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";

function baseUrl(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

/** Konversi objek JS biasa -> format Firestore REST "fields" */
function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    fields[key] = toFirestoreValue(value);
  }
  return fields;
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "boolean") return { booleanValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: toFirestoreFields(value) } };
  }
  throw new Error(`Tipe data tidak didukung untuk Firestore REST: ${typeof value}`);
}

/** Konversi format Firestore REST "fields" -> objek JS biasa */
function fromFirestoreFields(fields = {}) {
  const obj = {};
  for (const [key, value] of Object.entries(fields)) {
    obj[key] = fromFirestoreValue(value);
  }
  return obj;
}

function fromFirestoreValue(value) {
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return new Date(value.timestampValue);
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(fromFirestoreValue);
  if ("mapValue" in value) return fromFirestoreFields(value.mapValue.fields);
  return null;
}

/** Ambil satu dokumen. Return null kalau tidak ada. */
export async function getDoc(projectId, accessToken, path) {
  const res = await fetch(`${baseUrl(projectId)}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore getDoc gagal: ${await res.text()}`);
  const data = await res.json();
  return fromFirestoreFields(data.fields);
}

/** Set (overwrite/merge) satu dokumen. */
export async function setDoc(projectId, accessToken, path, data, { merge = false } = {}) {
  const url = new URL(`${baseUrl(projectId)}/${path}`);
  if (merge) {
    for (const key of Object.keys(data)) {
      url.searchParams.append("updateMask.fieldPaths", key);
    }
  }
  const res = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: toFirestoreFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore setDoc gagal: ${await res.text()}`);
  return res.json();
}

/** Query sederhana: WHERE field == value, LIMIT n */
export async function queryWhereEquals(projectId, accessToken, collectionId, field, value, limitCount = 1) {
  const res = await fetch(`${baseUrl(projectId)}:runQuery`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath: field },
            op: "EQUAL",
            value: toFirestoreValue(value),
          },
        },
        limit: limitCount,
      },
    }),
  });
  if (!res.ok) throw new Error(`Firestore query gagal: ${await res.text()}`);
  const rows = await res.json();
  return rows
    .filter((r) => r.document)
    .map((r) => ({
      id: r.document.name.split("/").pop(),
      data: fromFirestoreFields(r.document.fields),
    }));
}

export { FIRESTORE_SCOPE };

/**
 * Transaksi atomik read-modify-write, dipakai khusus untuk update saldo
 * supaya aman dari race condition (2 transaksi SGT untuk user yang sama
 * masuk hampir bersamaan). Memakai endpoint resmi Firestore REST:
 * beginTransaction -> get (dengan transaction id) -> commit (dengan writes).
 *
 * @param {string} projectId
 * @param {string} accessToken
 * @param {string} docPath  cth "user_balances/abc123"
 * @param {(current:object|null) => object} updateFn  terima data saat ini, return data baru
 * @returns {Promise<object>} data baru yang berhasil ditulis
 */
export async function runBalanceTransaction(projectId, accessToken, docPath, updateFn) {
  const MAX_RETRY = 5;

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    // 1. Mulai transaksi
    const beginRes = await fetch(`${baseUrl(projectId)}:beginTransaction`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!beginRes.ok) throw new Error(`beginTransaction gagal: ${await beginRes.text()}`);
    const { transaction } = await beginRes.json();

    // 2. Baca dokumen DALAM transaksi ini
    const getRes = await fetch(`${baseUrl(projectId)}/${docPath}?transaction=${transaction}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    let currentData = null;
    if (getRes.status === 200) {
      const doc = await getRes.json();
      currentData = fromFirestoreFields(doc.fields);
    } else if (getRes.status !== 404) {
      throw new Error(`Baca dokumen dalam transaksi gagal: ${await getRes.text()}`);
    }

    const newData = updateFn(currentData);

    // 3. Commit dengan write ini terikat ke transaction id yang sama.
    // Kalau ada write lain yang menyerempet dokumen ini di antara step 2 & 3,
    // Firestore akan menolak commit ini (HTTP 409) -> kita retry dari awal.
    const commitRes = await fetch(`${baseUrl(projectId)}:commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        transaction,
        writes: [
          {
            update: {
              name: `projects/${projectId}/databases/(default)/documents/${docPath}`,
              fields: toFirestoreFields(newData),
            },
          },
        ],
      }),
    });

    if (commitRes.ok) return newData;

    if (commitRes.status === 409 && attempt < MAX_RETRY - 1) {
      continue; // konflik konkurensi -> coba lagi
    }
    throw new Error(`commit transaksi saldo gagal: ${await commitRes.text()}`);
  }

  throw new Error("Gagal update saldo setelah beberapa kali percobaan (terlalu banyak konflik).");
}
