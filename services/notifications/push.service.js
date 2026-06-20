// ======================= PUSH SERVICE (EXPO) =======================

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Invia una push notification tramite Expo Push API
 *
 * @param {string} token - Expo Push Token (ExponentPushToken[...])
 * @param {string} title - Titolo notifica
 * @param {string} body - Corpo messaggio
 * @param {object} data - Dati extra (deep link, id, ecc.)
 */
export async function sendPush(token, title, body, data = {}) {
  // 1. Validazione del token
  if (!token) {
    console.warn('⚠️ [PUSH] sendPush abortito: token mancante');
    return;
  }

  console.log(`🔍 [PUSH] Tentativo invio a: ${token.substring(0, 20)}...`);

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: token,
        sound: 'default',
        title: title,
        body: body,
        data: data,
        // Aggiunta priorità per massimizzare la consegna
        priority: 'high', 
      }),
    });

    const result = await response.json();
    
    /**
     * Log di diagnostica dettagliata
     * Expo restituisce un oggetto che contiene informazioni sull'invio
     */
    if (result?.data?.status === 'error') {
      console.error('❌ [PUSH] Errore da Expo API:', JSON.stringify(result, null, 2));
    } else if (result?.data?.status === 'ok') {
      console.log(`✅ [PUSH] Inviato con successo! TicketID: ${result.data.id}`);
    } else {
      console.log('📡 [PUSH] Risposta inattesa da Expo:', result);
    }

    return result;
  } catch (err) {
    // Log in caso di errori di rete o DNS
    console.error('❌ [PUSH] Errore critico nel servizio sendPush:', err.message);
    throw err; // Rilanciamo l'errore per gestirlo nel chiamante (notification.service.js)
  }
}