// ======================= PUSH SERVICE (EXPO) =======================

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export async function sendPush(token, title, body, data = {}) {
  if (!token) {
    console.warn("⚠️ [PUSH] sendPush abortito: token mancante");
    return null;
  }

  console.log("=================================");
  console.log("🚀 [PUSH] INVIO PUSH");
  console.log("📱 Token:", token);
  console.log("📌 Title:", title);
  console.log("📌 Body:", body);
  console.log("📦 Data:", JSON.stringify(data, null, 2));
  console.log("=================================");

  try {
    const payload = {
      to: token,
      sound: "default",
      title,
      body,
      data,
      priority: "high",
      channelId: "default",
    };

    console.log(
      "📤 [PUSH] Payload Expo:",
      JSON.stringify(payload, null, 2)
    );

    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log("📡 [PUSH] HTTP STATUS:", response.status);

    const result = await response.json();

    console.log(
      "📥 [PUSH] RAW RESPONSE:",
      JSON.stringify(result, null, 2)
    );

    // Compatibilità Expo vecchia e nuova
    let ticket = null;

    if (Array.isArray(result?.data)) {
      ticket = result.data[0];
    } else if (result?.data) {
      ticket = result.data;
    }

    console.log(
      "🎫 [PUSH] Ticket:",
      JSON.stringify(ticket, null, 2)
    );

    if (!ticket) {
      console.warn("⚠️ [PUSH] Nessun ticket restituito da Expo");
      return result;
    }

    if (ticket.status === "ok") {
      console.log("✅ [PUSH] INVIATA CORRETTAMENTE");
      console.log("🆔 Ticket ID:", ticket.id);
    } else if (ticket.status === "error") {
      console.error("❌ [PUSH] ERRORE EXPO");
      console.error("📌 Message:", ticket.message);
      console.error(
        "📌 Details:",
        JSON.stringify(ticket.details, null, 2)
      );

      if (ticket.details?.error === "DeviceNotRegistered") {
        console.warn(
          "🗑️ [PUSH] Token non registrato sul device"
        );
      }

      if (ticket.details?.error === "MessageTooBig") {
        console.warn(
          "⚠️ [PUSH] Payload troppo grande"
        );
      }

      if (ticket.details?.error === "InvalidCredentials") {
        console.warn(
          "⚠️ [PUSH] Credenziali FCM/APNS non valide"
        );
      }
    }

    return result;
  } catch (err) {
    console.error("❌ [PUSH] ERRORE CRITICO");
    console.error(err);
    throw err;
  }
}