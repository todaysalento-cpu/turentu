import admin from "firebase-admin";

let initialized = false;

function initFirebase() {
  if (initialized) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw) {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT mancante");
    return;
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(raw);
  } catch (e) {
    console.error("❌ JSON FIREBASE non valido");
    throw e;
  }

  if (!admin.apps || admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    console.log("🔥 Firebase inizializzato OK");
  }

  initialized = true;
}

initFirebase();

// =========================
// SEND PUSH
// =========================
export async function sendPush(token, title, body, data = {}) {
  if (!token) {
    console.warn("⚠️ token mancante");
    return null;
  }

  try {
    const message = {
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default" } } },
    };

    const response = await admin.messaging().send(message);

    return {
      success: true,
      id: response,
    };
  } catch (err) {
    console.error("❌ FCM ERROR:", err.message);

    return {
      success: false,
      error: err.message,
    };
  }
}