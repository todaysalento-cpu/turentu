import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

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
    // getApps() restituisce un array delle app inizializzate
    if (getApps().length === 0) {
      console.log("⚙️ [INIT] Tentativo di inizializzazione con cert()...");
      
      initializeApp({
        credential: cert(serviceAccount)
      });

      console.log("🔥 [INIT] Firebase inizializzato con successo!");
    } else {
      console.log("ℹ️ [INIT] Firebase era già inizializzato.");
    }
    
    initialized = true;
  } catch (err) {
    console.error("❌ [INIT] Fallimento in initializeApp:", err.message);
    throw err;
  }
}

// Esecuzione immediata dell'init
try {
  initFirebase();
} catch (err) {
  console.error("❌ [INIT] Errore fatale:", err.message);
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
    // Verifica che ci sia almeno un'app inizializzata
    if (getApps().length === 0) {
      throw new Error("Firebase non è inizializzato. Controlla i log di avvio.");
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

    console.log(`📨 [FCM] Tentativo invio a token: ${token.substring(0, 10)}...`);

    // Utilizziamo getMessaging() per ottenere l'istanza del servizio
    const response = await getMessaging().send(message);

    console.log("✅ [FCM] Notifica inviata con ID:", response);
    return { success: true, id: response };
    
  } catch (err) {
    console.error("❌ [FCM] Errore invio:", err.message);
    return { success: false, error: err.message };
  }
}