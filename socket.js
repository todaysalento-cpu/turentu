socket.on("join_chat", async ({ corsa_id, cliente_id }) => {
  if (!corsa_id || !cliente_id) return;

  const room = `chat_${corsa_id}_${cliente_id}`;
  socket.join(room);

  try {
    const { rows } = await pool.query(
      `
      SELECT id, corsa_id, cliente_id, sender_id,
             testo AS text,
             client_msg_id,
             created_at
      FROM messaggi
      WHERE corsa_id=$1 AND cliente_id=$2
      ORDER BY created_at ASC
      `,
      [corsa_id, cliente_id]
    );

    socket.emit("init_chat", {
      corsa_id,
      cliente_id,
      messages: rows,
    });
  } catch (err) {
    log("ERROR", "INIT_CHAT_FAILED", { message: err.message });
  }
});