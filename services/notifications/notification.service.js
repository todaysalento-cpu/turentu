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
  if (!token) {
    console.warn('⚠️ sendPush: token mancante');
    return;
  }

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: token,
        sound: 'default',
        title,
        body,
        data,
      }),
    });

    const result = await response.json();

    if (result?.data?.status === 'error') {
      console.error('❌ Push error:', result);
    } else {
      console.log('📲 Push inviata:', result);
    }

    return result;
  } catch (err) {
    console.error('❌ sendPush error:', err.message);
  }
}