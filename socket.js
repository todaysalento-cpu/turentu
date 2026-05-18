socket.on("mark_as_read", async ({ corsa_id, cliente_id }) => {
  try {
    const corsaId = Number(corsa_id);
    const clienteId = Number(cliente_id);
    const userId = socket.user.id;

    if (!corsaId || !clienteId || !userId) return;

    const room = `chat_${corsaId}_${clienteId}`;

    // =========================
    // 1. UPDATE READ RECEIPTS
    // =========================
    await pool.query(
      `
      UPDATE message_receipts mr
      SET read_at = NOW()
      FROM messaggi m
      WHERE m.id = mr.message_id
        AND m.corsa_id = $1
        AND m.cliente_id = $2
        AND mr.user_id = $3
        AND mr.read_at IS NULL
      `,
      [corsaId, clienteId, userId]
    );

    // =========================
    // 2. GET ONLY NEWLY READ IDS
    // =========================
    const { rows } = await pool.query(
      `
      SELECT m.id
      FROM messaggi m
      JOIN message_receipts mr
        ON mr.message_id = m.id
      WHERE m.corsa_id = $1
        AND m.cliente_id = $2
        AND mr.user_id = $3
        AND mr.read_at IS NOT NULL
      `,
      [corsaId, clienteId, userId]
    );

    const messageIds = rows.map(r => String(r.id));

    // =========================
    // 3. EMIT TO ROOM
    // =========================
    io.to(room).emit("message_read", {
      corsa_id: corsaId,
      cliente_id: clienteId,
      message_ids: messageIds,
      reader_id: userId,
      read_at: Date.now(),
    });

    // =========================
    // 4. LOG DEBUG (IMPORTANT)
    // =========================
    console.log("📖 MARK_AS_READ", {
      room,
      count: messageIds.length,
      userId,
    });

  } catch (err) {
    console.error("❌ READ_FAILED", {
      message: err.message,
      corsa_id,
      cliente_id,
    });
  }
});