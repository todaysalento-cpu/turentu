import * as admin from "firebase-admin";

// ===============================
// SAFE INIT (Render + ESM SAFE)
// ===============================
function getServiceAccount() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT missing");
  }

  try {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error("❌ Invalid FIREBASE_SERVICE_ACCOUNT JSON");
    throw err;
  }
}

// init only once (FIX IMPORTANTISSIMO)
if (!admin.apps || admin.apps.length === 0) {
  const serviceAccount = getServiceAccount();

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log("🔥 [FCM] Firebase Admin initialized");
}

// ===============================
// SEND PUSH
// ===============================
export async function sendPush(token, title, body, data = {}) {
  if (!token) {
    console.warn("⚠️ [FCM] token mancante");
    return null;
  }

  console.log("=================================");
  console.log("🚀 [FCM] INVIO PUSH");
  console.log("📱 Token:", token);
  console.log("📌 Title:", title);
  console.log("📌 Body:", body);
  console.log("📦 Data:", JSON.stringify(data, null, 2));
  console.log("=================================");

  try {
    const message = {
      token,
      notification: {
        title,
        body,
      },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: "high",
      },
      apns: {
        payload: {
          aps: {
            sound: "default",
          },
        },
      },
    };

    const response = await admin.messaging().send(message);

    console.log("✅ [FCM] PUSH INVIATA");
    console.log("🆔 Message ID:", response);

    return {
      success: true,
      id: response,
    };

  } catch (err) {
    console.error("❌ [FCM] ERRORE INVIO PUSH");
    console.error("📌 Message:", err.message);

    return {
      success: false,
      error: err.message,
    };
  }
}