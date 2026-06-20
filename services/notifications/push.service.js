// ======================= PUSH SERVICE (EXPO) =======================

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export async function sendPush(token, title, body, data = {}) {
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
        priority: 'high', 
        channelId: 'default', // FONDAMENTALE: collega la notifica al canale Android
      }),
    });

    const result = await response.json();
    
    // CORREZIONE: Expo restituisce result.data come ARRAY di ticket
    const ticket = result.data ? result.data[0] : null;
    
    if (ticket && ticket.status === 'error') {
      console.error('❌ [PUSH] Errore da Expo API:', ticket.message);
      
      // Gestione automatica token non più validi
      if (ticket.details && ticket.details.error === 'DeviceNotRegistered') {
        console.warn('🗑️ [PUSH] Token non più valido, necessario rimuoverlo dal DB');
        // Qui dovresti chiamare una funzione per eliminare il token dal DB
      }
    } else if (ticket && ticket.status === 'ok') {
      console.log(`✅ [PUSH] Inviato con successo! TicketID: ${ticket.id}`);
    } else {
      console.log('📡 [PUSH] Risposta inattesa da Expo:', JSON.stringify(result));
    }

    return result;
  } catch (err) {
    console.error('❌ [PUSH] Errore critico nel servizio sendPush:', err.message);
    throw err;
  }
}