socket.on('send_message', async ({ corsa_id, cliente_id, text, sender_id }) => {
  try {
    // inserimento nel DB
    const { rows } = await pool.query(`
      INSERT INTO messaggi (corsa_id, cliente_id, sender_id, testo, read_status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, created_at AS timestamp
    `, [corsa_id, cliente_id, sender_id, text, JSON.stringify({ autista: false, cliente: false })]);

    const msg = {
      ...rows[0],
      corsa_id,
      cliente_id,
      sender_id,
      text,
      sender_name: 'autista', // da calcolare correttamente se necessario
      role: 'autista',
    };

    // invio messaggio via socket
    const room = `chat_${corsa_id}_${cliente_id}`;
    io.to(room).emit('new_message', msg);

    // -----------------------
    // PUSH NOTIFICATION
    // -----------------------
    const { rows: tokens } = await pool.query(`
      SELECT push_token
      FROM utente_push_tokens
      WHERE user_id != $1
        AND user_id IN (
          SELECT cliente_id FROM prenotazioni WHERE corsa_id=$2
          UNION
          SELECT driver_id FROM veicolo v
          JOIN corse c ON v.id = c.veicolo_id
          WHERE c.id=$2
        )
    `, [sender_id, corsa_id]);

    for (let t of tokens) {
      if (t.push_token) {
        await fetch('https://fcm.googleapis.com/fcm/send', {
          method: 'POST',
          headers: {
            'Authorization': `key=${process.env.FCM_SERVER_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: t.push_token,
            notification: {
              title: 'Nuovo messaggio',
              body: text,
              sound: 'default',
            },
            data: {
              corsa_id,
              cliente_id,
              message_id: msg.id,
            },
          }),
        });
      }
    }

  } catch (err) {
    console.error('❌ Errore send_message:', err);
  }
});