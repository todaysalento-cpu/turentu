import admin from "firebase-admin";

// inizializza Firebase Admin UNA SOLA VOLTA nel progetto
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
  });
}

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
  console.log("📦 Data:", data);
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
    console.error(err);

    return {
      success: false,
      error: err.message,
    };
  }
}