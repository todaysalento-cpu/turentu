import * as firebaseAdmin from "firebase-admin";

// Forza il caricamento corretto del modulo
const admin = firebaseAdmin.default || firebaseAdmin;

let initialized = false;

function initFirebase() {
  if (initialized) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  console.log("🔍 [INIT] Verifico variabile d'ambiente FIREBASE_SERVICE_ACCOUNT...");

  if (!raw) {
    console.warn("⚠️ [INIT] FIREBASE_SERVICE_ACCOUNT mancante!");
    return;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
    console.log("✅ [INIT] JSON parsato. Project ID:", serviceAccount.project_id);
  } catch (e) {
    console.error("❌ [INIT] Errore critico: JSON non valido.");
    throw e;
  }

  try {
    // Controllo specifico per l'esistenza di credential
    if (!admin.credential) {
      throw new Error("admin.credential è undefined. Il modulo non è caricato correttamente.");
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

// Inizializzazione
try {
  initFirebase();
} catch (err) {
  console.error("❌ [INIT] Errore fatale:", err);
}

// =========================
// SEND PUSH
// =========================
export async function sendPush(token, title, body, data = {}) {
  if (!token) {
    console.warn("⚠️ [FCM] Token mancante.");
    return null;
  }

  try {
    // Verifica stato inizializzazione
    if (!admin.apps || admin.apps.length === 0) {
      throw new Error("Firebase non è pronto.");
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

    const response = await admin.messaging().send(message);
    return { success: true, id: response };
    
  } catch (err) {
    console.error("❌ [FCM] Errore invio:", err.message);
    return { success: false, error: err.message };
  }
}