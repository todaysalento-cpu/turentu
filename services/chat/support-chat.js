export function registerSupportChat(router, authenticate, pool) {
  const handle = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error("[SUPPORT CHAT]", err.code ?? err.name);
      if (res.headersSent) return next(err);
      res.status(500).json({ message: "Assistenza temporaneamente non disponibile." });
    });
  };

  // Controlla il ruolo attuale ad ogni accesso, anche con un token ancora valido.
  const supportUser = async (req, res, next) => {
    const { rows: [user] } = await pool.query(
      "SELECT lower(btrim(tipo)) AS ruolo FROM public.utente WHERE id = $1 AND eliminato_il IS NULL",
      [req.user.id]
    );
    if (!user || !["admin", "cliente", "autista"].includes(user.ruolo)) {
      return res.status(403).json({ message: "Assistenza non disponibile per questo account." });
    }
    req.supportAdmin = user.ruolo === "admin";
    next();
  };

  router.get("/support", authenticate, handle(supportUser), handle(async (req, res) => {
    if (!req.supportAdmin) return res.sendStatus(403);
    const { rows } = await pool.query(
      "SELECT utente_id, max(id) AS ultimo_id FROM public.chat_assistenza_messaggi " +
      "GROUP BY utente_id ORDER BY ultimo_id DESC"
    );
    res.json(rows);
  }));

  const resolveThread = async (req, res, next) => {
    const target = req.params.userId;
    if (!req.supportAdmin && target === "me") {
      req.supportUserId = req.user.id;
      return next();
    }
    if (!req.supportAdmin) return res.sendStatus(403);
    if (!/^[1-9][0-9]{0,9}$/.test(target) || Number(target) > 2147483647) return res.sendStatus(400);
    const { rowCount } = await pool.query(
      "SELECT 1 FROM public.chat_assistenza_messaggi WHERE utente_id = $1 LIMIT 1", [target]
    );
    if (!rowCount) return res.sendStatus(404);
    req.supportUserId = Number(target);
    next();
  };
  const middleware = [authenticate, handle(supportUser), handle(resolveThread)];

  router.get("/support/:userId", ...middleware, handle(async (req, res) => {
    const before = req.query.before;
    if (before !== undefined && (typeof before !== "string" || !/^[1-9][0-9]{0,17}$/.test(before))) return res.sendStatus(400);
    const { rows } = await pool.query(
      "SELECT id, da_assistenza, testo, inviato_il FROM public.chat_assistenza_messaggi " +
      "WHERE utente_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT 50",
      [req.supportUserId, before ?? null]
    );
    res.json(rows.reverse());
  }));

  router.post("/support/:userId", ...middleware, handle(async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > 2000) return res.status(400).json({ message: "Scrivi un messaggio da 1 a 2000 caratteri." });
    const id = req.body?.id;
    if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) return res.sendStatus(400);
    const { rows: [message] } = await pool.query(
      "INSERT INTO public.chat_assistenza_messaggi (utente_id, da_assistenza, testo, richiesta_id) VALUES ($1, $2, $3, $4) " +
      "ON CONFLICT (richiesta_id) DO NOTHING RETURNING id, da_assistenza, testo, inviato_il",
      [req.supportUserId, req.supportAdmin, text, id]
    );
    if (message) return res.status(201).json(message);
    const { rows: [existing] } = await pool.query(
      "SELECT id, da_assistenza, testo, inviato_il FROM public.chat_assistenza_messaggi " +
      "WHERE richiesta_id = $1 AND utente_id = $2 AND da_assistenza = $3 AND testo = $4",
      [id, req.supportUserId, req.supportAdmin, text]
    );
    if (!existing) return res.sendStatus(409);
    res.json(existing);
  }));
}
