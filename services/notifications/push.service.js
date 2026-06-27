import admin from "firebase-admin";

let initialized = false;

function initFirebase() {
  if (initialized) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  console.log("🔍 [INIT] Verifico variabile d'ambiente FIREBASE_SERVICE_ACCOUNT...");

  if (!raw) {
    console.warn("⚠️ [INIT] FIREBASE_SERVICE_ACCOUNT mancante! Controlla le impostazioni di Render.");
    return;
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(raw);
    console.log("✅ [INIT] JSON parsato correttamente.");
    console.log("🆔 [INIT] Project ID:", serviceAccount.project_id);
  } catch (e) {
    console.error("❌ [INIT] Errore critico: JSON non valido o malformato.");
    console.error("DEBUG - Valore ricevuto (primi 50 caratteri):", raw.substring(0, 50));
    throw e;
  }

  try {
    // Verifica se admin è importato correttamente
    if (!admin) {
      throw new Error("Il modulo firebase-admin è undefined.");
    }

    if (!admin.apps || admin.apps.length === 0) {
      console.log("⚙️ [INIT] Tentativo di admin.initializeApp...");
      
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });

      console.log("🔥 [INIT] Firebase inizializzato con successo!");
    } else {
      console.log("ℹ️ [INIT] Firebase era già inizializzato.");
    }
  } catch (err) {
    console.error("❌ [INIT] Fallimento in initializeApp:", err.message);
    throw err;
  }

  initialized = true;
}

// Inizializzazione al caricamento del modulo
try {
  initFirebase();
} catch (err) {
  console.error("❌ [INIT] Errore fatale durante l'avvio del modulo:", err);
}

// =========================
// SEND PUSH
// =========================
export async function sendPush(token, title, body, data = {}) {
  if (!token) {
    console.warn("⚠️ [FCM] Token mancante, invio abortito.");
    return null;
  }

  try {
    // Verifica che admin sia pronto
    if (!admin.apps || admin.apps.length === 0) {
      throw new Error("Firebase Admin non è inizializzato.");
    }

    const message = {
      token,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default" } } },
    };

    console.log(`📨 [FCM] Invio notifica a token: ${token.substring(0, 10)}...`);

    const response = await admin.messaging().send(message);

    console.log("✅ [FCM] Notifica inviata con ID:", response);
    return { success: true, id: response };
  } catch (err) {
    console.error("❌ [FCM] Errore nell'invio:", err.message);
    return { success: false, error: err.message };
  }
}