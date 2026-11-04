
const fs = require("fs");

const file = "routes/chat.routes.js";
const originalBackup = file + ".bak-before-media-idempotency";
const backup = file + ".bak-media-idempotency-v1";

if (!fs.existsSync(originalBackup)) {
  throw new Error("Backup originale non trovato");
}

let source = fs.readFileSync(file, "utf8");

const start = source.indexOf(
  'chatRouter.post("/messages/media"'
);
const end = source.indexOf(
  '/* ================= MARK AS READ ================= */',
  start
);

if (start < 0 || end < 0) {
  throw new Error("Blocco media non trovato");
}

const oldBlock = source.slice(start, end);

if (oldBlock.includes("MEDIA_IDEMPOTENCY_V1")) {
  throw new Error("Patch gia applicata");
}

const replacement = String.raw`chatRouter.post("/messages/media", authMiddleware, upload.single("audio"), requireChatAccess, async (req, res) => {
  const { client_msg_id, tipo_messaggio, text, lat, lng, audio_base64, media_base64 } = req.body;
  const corsa_id = Number(req.body.corsa_id);
  const cliente_id = Number(req.body.cliente_id);
  const duration = parseFloat(req.body.duration) || 0;
  const sender_id = Number(req.user.id);
  const sender_role = req.user.role;

  // MEDIA_IDEMPOTENCY_V1
  const clientMsgId = String(client_msg_id || "").trim();

  if (
    !clientMsgId ||
    clientMsgId.length > 200 ||
    !Number.isSafeInteger(corsa_id) || corsa_id <= 0 ||
    !Number.isSafeInteger(cliente_id) || cliente_id <= 0 ||
    !Number.isSafeInteger(sender_id) || sender_id <= 0
  ) {
    return res.status(400).json({ message: "Dati messaggio non validi" });
  }

  let dbClient = null;
  let transactionOpen = false;

  try {
    dbClient = await pool.connect();

    await dbClient.query("BEGIN");
    transactionOpen = true;

    // Serializza le richieste con lo stesso identificativo.
    await dbClient.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [clientMsgId]
    );

    // Retry: restituisce il messaggio originale senza nuovo upload.
    const existingResult = await dbClient.query(
      "SELECT *, EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms FROM messaggi WHERE client_msg_id = $1 LIMIT 1",
      [clientMsgId]
    );

    if (existingResult.rows.length) {
      const existing = existingResult.rows[0];

      const sameOwner =
        Number(existing.corsa_id) === corsa_id &&
        Number(existing.cliente_id) === cliente_id &&
        Number(existing.sender_id) === sender_id;

      await dbClient.query("COMMIT");
      transactionOpen = false;

      if (!sameOwner) {
        log("MEDIA_IDEMPOTENCY_CONFLICT", {
          sender_id,
          client_msg_id: clientMsgId
        });
        return res.status(409).json({
          message: "Identificativo messaggio gia utilizzato"
        });
      }

      log("MEDIA_IDEMPOTENCY_REPLAY", {
        messageId: existing.id,
        sender_id
      });

      return res.json({
        ...existing,
        duration: Number(existing.duration || 0)
      });
    }

    let mediaUrl = null;
    let audioUrl = null;
    let content = text || (tipo_messaggio === "audio" ? "Audio" : null);

    const uploadToCloudinary = (buffer) =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { resource_type: "auto" },
          (err, result) =>
            err ? reject(err) : resolve(result.secure_url)
        );

        streamifier.createReadStream(buffer).pipe(stream);
      });

    if (req.file) {
      log("CLOUDINARY_UPLOAD_MULTER", {
        size: req.file.buffer.length
      });

      const secureUrl = await uploadToCloudinary(req.file.buffer);

      if (tipo_messaggio === "audio") {
        audioUrl = secureUrl;
      } else {
        mediaUrl = secureUrl;
      }
    } else if (tipo_messaggio === "audio" && audio_base64) {
      const base64Data = audio_base64.replace(
        /^data:audio\/\w+;base64,/,
        ""
      );

      audioUrl = await uploadToCloudinary(
        Buffer.from(base64Data, "base64")
      );
    } else if (tipo_messaggio !== "audio" && media_base64) {
      const base64Data = media_base64.replace(
        /^data:\w+\/\w+;base64,/,
        ""
      );

      mediaUrl = await uploadToCloudinary(
        Buffer.from(base64Data, "base64")
      );
    }

    if (tipo_messaggio === "location") {
      content = JSON.stringify({ lat, lng });
    }

    const insertResult = await dbClient.query(
      "INSERT INTO messaggi (corsa_id, cliente_id, sender_id, tipo_messaggio, testo, media_url, audio_url, client_msg_id, duration) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (client_msg_id) DO NOTHING RETURNING *, EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms",
      [
        corsa_id,
        cliente_id,
        sender_id,
        tipo_messaggio,
        content,
        mediaUrl,
        audioUrl,
        clientMsgId,
        duration
      ]
    );

    if (!insertResult.rows.length) {
      // Protezione aggiuntiva contro conflitti esterni.
      const conflictResult = await dbClient.query(
        "SELECT * FROM messaggi WHERE client_msg_id = $1 LIMIT 1",
        [clientMsgId]
      );

      await dbClient.query("COMMIT");
      transactionOpen = false;

      const existing = conflictResult.rows[0];

      if (
        !existing ||
        Number(existing.corsa_id) !== corsa_id ||
        Number(existing.cliente_id) !== cliente_id ||
        Number(existing.sender_id) !== sender_id
      ) {
        return res.status(409).json({
          message: "Conflitto identificativo messaggio"
        });
      }

      return res.json({
        ...existing,
        duration: Number(existing.duration || 0)
      });
    }

    const msg = insertResult.rows[0];
    const formattedDuration = Number(msg.duration || 0);

    const socketMessage = {
      id: msg.id,
      sender_id: Number(msg.sender_id),
      text: msg.testo ?? "",
      audio_url: msg.audio_url ?? null,
      media_url: msg.media_url ?? null,
      tipo_messaggio: msg.tipo_messaggio,
      duration: formattedDuration,
      corsa_id: Number(msg.corsa_id),
      cliente_id: Number(msg.cliente_id),
      created_at: Number(msg.created_at_ms || Date.now()),
      client_msg_id: msg.client_msg_id
    };

    await dbClient.query("COMMIT");
    transactionOpen = false;

    // Le notifiche non devono trasformare un salvataggio riuscito in HTTP 500.
    try {
      const { getIO } = await import("../socket.js");

      getIO()
        .to("chat_" + corsa_id + "_" + cliente_id)
        .emit("new_message", socketMessage);

      log("SOCKET_MESSAGE_EMITTED", { msgId: msg.id });
    } catch (socketErr) {
      log("MEDIA_SOCKET_NOTIFY_FAILED", {
        error: socketErr.message,
        msgId: msg.id
      });
    }

    try {
      const recipientId =
        sender_role === "autista"
          ? cliente_id
          : await getDriverIdByCorsa(corsa_id);

      if (recipientId) {
        await notifyUser(recipientId, {
          type: "chat",
          message:
            tipo_messaggio === "text"
              ? text || "Nuovo messaggio"
              : "Hai ricevuto un file",
          role: sender_role === "autista" ? "cliente" : "autista",
          data: { corsa_id, cliente_id }
        });
      }
    } catch (fcmErr) {
      log("FCM_NOTIFICATION_FAILED", {
        error: fcmErr.message,
        msgId: msg.id
      });
    }

    return res.json({
      ...msg,
      duration: formattedDuration
    });

  } catch (err) {
    if (dbClient && transactionOpen) {
      try {
        await dbClient.query("ROLLBACK");
      } catch (rollbackErr) {
        log("MEDIA_ROLLBACK_FAILED", {
          error: rollbackErr.message
        });
      }
    }

    log("UPLOAD_MEDIA_FAILED", { error: err.message });

    return res.status(500).json({
      message: "Errore invio"
    });
  } finally {
    if (dbClient) dbClient.release();
  }
});

`;

fs.copyFileSync(file, backup);

fs.writeFileSync(
  file,
  source.slice(0, start) +
  replacement +
  source.slice(end)
);

console.log("OK: idempotenza media V1 implementata");
console.log("Backup:", backup);
