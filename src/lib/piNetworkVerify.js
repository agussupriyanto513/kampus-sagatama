// src/lib/piNetworkVerify.js
//
// Memverifikasi bahwa piAccessToken yang dikirim client memang valid & memang
// milik piUid yang diklaim — dengan bertanya LANGSUNG ke server Pi Network,
// bukan percaya begitu saja pada data dari client.

const PI_PLATFORM_API_ME = "https://api.minepi.com/v2/me";

/**
 * @param {string} piAccessToken
 * @returns {Promise<{piUid:string, username:string}>}
 */
export async function verifyPiAccessToken(piAccessToken) {
  const res = await fetch(PI_PLATFORM_API_ME, {
    headers: { Authorization: `Bearer ${piAccessToken}` },
  });

  if (!res.ok) {
    throw new Error("piAccessToken tidak valid atau sudah kedaluwarsa.");
  }

  const data = await res.json();
  return { piUid: data.uid, username: data.username };
}
