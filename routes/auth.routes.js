// ===================== OTP =====================

// INVIO OTP
router.post('/otp/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ message: 'Numero mancante' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minuti

  try {
    const userRes = await pool.query('SELECT id FROM utente WHERE phone=$1', [phone]);

    if (userRes.rows.length) {
      // aggiorna OTP per utente esistente
      await pool.query(
        'UPDATE utente SET otp_code=$1, otp_expires=$2 WHERE phone=$3',
        [otp, expiresAt, phone]
      );
    } else {
      // crea nuovo utente OTP temporaneo
      const tempEmail = `otp_${phone}@example.com`; // email fittizia unica
      const tempPassword = crypto.randomBytes(16).toString('hex');

      await pool.query(
        `INSERT INTO utente (nome, email, password, tipo, phone, otp_code, otp_expires)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['Utente OTP', tempEmail, tempPassword, 'cliente', phone, otp, expiresAt]
      );
    }

    await twilioClient.messages.create({
      body: `Il tuo codice OTP è: ${otp}`,
      from: process.env.TWILIO_PHONE,
      to: phone,
    });

    res.json({ success: true, message: 'OTP inviato' });
  } catch (err) {
    console.error('❌ OTP send error:', err);
    res.status(500).json({ message: 'Errore invio OTP' });
  }
});

// VERIFICA OTP
router.post('/otp/verify', async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ message: 'Dati mancanti' });

  try {
    const result = await pool.query(
      'SELECT id, tipo, nome, otp_expires FROM utente WHERE phone=$1 AND otp_code=$2',
      [phone, otp]
    );

    if (result.rows.length === 0)
      return res.status(400).json({ message: 'OTP non valido' });

    const user = result.rows[0];

    if (new Date(user.otp_expires) < new Date())
      return res.status(400).json({ message: 'OTP scaduto' });

    // pulisce OTP dal DB
    await pool.query(
      'UPDATE utente SET otp_code=NULL, otp_expires=NULL WHERE id=$1',
      [user.id]
    );

    const jwtPayload = {
      id: user.id,
      role: user.tipo,
      nome: user.nome,
      phone,
    };
    const jwtToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', jwtToken, cookieOptions);
    res.json({ ...jwtPayload, token: jwtToken });
  } catch (err) {
    console.error('❌ OTP verify error:', err);
    res.status(500).json({ message: 'Errore server' });
  }
});