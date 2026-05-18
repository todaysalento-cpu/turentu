socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
  const userId = socket.user?.id;
  const role = socket.user?.role;

  if (!corsa_id || !cliente_id) {
    console.warn("🟥 JOIN_CHAT INVALID PARAMS", { corsa_id, cliente_id });
    return;
  }

  const room = `chat_${corsa_id}_${cliente_id}`;
  socket.join(room);

  console.log("🟦 JOIN_CHAT", {
    userId,
    role,
    room,
    corsa_id,
    cliente_id,
  });

  try {
    const { rows } = await pool.query(
      `
      SELECT 
        m.id,
        m.corsa_id,
        m.cliente_id,
        m.sender_id,
        m.testo AS text,
        m.client_msg_id,
        m.created_at,

        mr.delivered_at,
        mr.read_at

      FROM messaggi m
      LEFT JOIN message_receipts mr
        ON mr.message_id = m.id
       AND mr.user_id = $3

      WHERE m.corsa_id=$1 AND m.cliente_id=$2
      ORDER BY m.created_at ASC
      `,
      [corsa_id, cliente_id, userId]
    );

    const messages = rows.map((m) => ({
      id: String(m.id),
      corsa_id: Number(m.corsa_id),
      cliente_id: Number(m.cliente_id),
      sender_id: Number(m.sender_id),
      text: m.text ?? "",
      client_msg_id: m.client_msg_id ?? null,
      created_at: Number(new Date(m.created_at)),

      status: {
        sent: true,
        delivered: !!m.delivered_at,
        read: !!m.read_at,
      },
    }));

    // 🔥 LOG SUMMARY STATO MESSAGGI
    const stats = {
      total: messages.length,
      sent: messages.length,
      delivered: messages.filter(m => m.status.delivered).length,
      read: messages.filter(m => m.status.read).length,
      unread: messages.filter(
        m => m.sender_id !== userId && !m.status.read
      ).length,
    };

    console.log("🟨 INIT_CHAT_STATS", {
      room,
      ...stats,
    });

    console.log("🟩 INIT_CHAT_FIRST_3_MESSAGES", messages.slice(0, 3));

    socket.emit("init_chat", {
      corsa_id,
      cliente_id,
      messages,
    });

  } catch (err) {
    console.error("🟥 INIT_CHAT_FAILED", {
      error: err.message,
      corsa_id,
      cliente_id,
    });
  }
});