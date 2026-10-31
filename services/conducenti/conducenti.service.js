// Turentu - modulo conducenti indipendente (ES modules)
// Tutte le funzioni ricevono un client/pool pg gi├á configurato.
// Nessuna dipendenza da PIXEL, POPBUS o dai loro worker.

const STATI = new Set(['invitato', 'attivo', 'sospeso', 'rifiutato']);

function interoPositivo(value, nome) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${nome} deve essere un intero positivo`);
  }
  return n;
}

function verificaDb(db) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('Client PostgreSQL non valido');
  }
}

export async function elencoConducenti(db, operatoreId) {
  verificaDb(db);
  const id = interoPositivo(operatoreId, 'operatoreId');
  const { rows } = await db.query(
    `SELECT co.id, co.operatore_id, co.conducente_id,
            co.stato, co.assegnabile_automaticamente, co.sempre_disponibile,
            co.creato_il, co.aggiornato_il,
            u.nome, u.email
       FROM conducenti_operatori co
       JOIN utente u ON u.id = co.conducente_id
      WHERE co.operatore_id = $1
      ORDER BY u.nome NULLS LAST, co.id`,
    [id]
  );
  return rows;
}

// L'associazione nasce come invito: non autorizza ancora il conducente.
// Il controller deve verificare prima che il richiedente sia l'operatore.
export async function invitaConducente(db, { operatoreId, conducenteId }) {
  verificaDb(db);
  const operatore = interoPositivo(operatoreId, 'operatoreId');
  const conducente = interoPositivo(conducenteId, 'conducenteId');
  if (operatore === conducente) {
    throw new Error('Il titolare va gestito con il percorso dedicato');
  }
  const { rows } = await db.query(
    `INSERT INTO conducenti_operatori
       (operatore_id, conducente_id, stato, assegnabile_automaticamente)
     VALUES ($1, $2, 'invitato', false)
     ON CONFLICT (operatore_id, conducente_id)
     DO UPDATE SET
       stato = 'invitato',
       assegnabile_automaticamente = false,
       sempre_disponibile = true,
        creato_il = now(),
       aggiornato_il = now()
     WHERE conducenti_operatori.stato = 'rifiutato'
     RETURNING *`,
    [operatore, conducente]
  );
  if (!rows[0]) {
    throw new Error('Associazione gi├á esistente: verificare lo stato prima di procedere');
  }
  return rows[0];
}

// Deve essere invocata da un endpoint autenticato come conducente invitato.
// Un operatore NON pu├▓ accettare l'invito al posto del conducente.
export async function accettaInvitoConducente(db, { rapportoId, conducenteId }) {
  verificaDb(db);
  const rapporto = interoPositivo(rapportoId, 'rapportoId');
  const conducente = interoPositivo(conducenteId, 'conducenteId');
  const { rows } = await db.query(
    `UPDATE conducenti_operatori
        SET stato = 'attivo', aggiornato_il = now()
      WHERE id = $1 AND conducente_id = $2 AND stato = 'invitato'
      RETURNING *`,
    [rapporto, conducente]
  );
  if (!rows[0]) throw new Error('Invito non trovato o non pi├╣ accettabile');
  return rows[0];
}

// Il conducente autenticato pu├▓ rifiutare esclusivamente un proprio invito pendente.
export async function rifiutaInvitoConducente(db, { rapportoId, conducenteId }) {
  verificaDb(db);
  const rapporto = interoPositivo(rapportoId, 'rapportoId');
  const conducente = interoPositivo(conducenteId, 'conducenteId');

  const { rows } = await db.query(
    `UPDATE conducenti_operatori
        SET stato = 'rifiutato',
            assegnabile_automaticamente = false,
            aggiornato_il = now()
      WHERE id = $1
        AND conducente_id = $2
        AND stato = 'invitato'
      RETURNING *`,
    [rapporto, conducente]
  );

  if (!rows[0]) {
    throw new Error('Invito non trovato o non pi├╣ rifiutabile');
  }
  return rows[0];
}

// Restituisce i rapporti attivi del conducente autenticato.
// La lista evita di nascondere eventuali associazioni multiple preesistenti.
export async function rapportoAttivoConducente(db, conducenteId) {
  verificaDb(db);
  const id = interoPositivo(conducenteId, 'conducenteId');

  const { rows } = await db.query(
    `SELECT co.id AS rapporto_id,
            co.operatore_id,
            co.conducente_id,
            co.stato,
            co.assegnabile_automaticamente,
            co.creato_il,
            u.nome AS nome_operatore,
            u.email AS email_operatore
       FROM conducenti_operatori co
       JOIN utente u ON u.id = co.operatore_id
      WHERE co.conducente_id = $1
        AND co.stato = 'attivo'
      ORDER BY co.creato_il DESC, co.id DESC`,
    [id]
  );

  return rows;
}

// Riservata al titolare dell'operatore, con autorizzazione nel controller.
export async function sospendiConducente(db, { operatoreId, rapportoId }) {
  verificaDb(db);
  const operatore = interoPositivo(operatoreId, 'operatoreId');
  const rapporto = interoPositivo(rapportoId, 'rapportoId');
  const { rows } = await db.query(
    `UPDATE conducenti_operatori
        SET stato = 'sospeso', assegnabile_automaticamente = false,
            aggiornato_il = now()
      WHERE id = $1 AND operatore_id = $2 AND stato <> 'sospeso'
      RETURNING *`,
    [rapporto, operatore]
  );
  if (!rows[0]) throw new Error('Associazione non trovata o gi├á sospesa');
  return rows[0];
}

export async function impostaAssegnazioneAutomatica(db, {
  operatoreId, rapportoId, abilitata
}) {
  verificaDb(db);
  const operatore = interoPositivo(operatoreId, 'operatoreId');
  const rapporto = interoPositivo(rapportoId, 'rapportoId');
  if (typeof abilitata !== 'boolean') throw new Error('abilitata deve essere boolean');
  const { rows } = await db.query(
    `UPDATE conducenti_operatori
        SET assegnabile_automaticamente = $3, aggiornato_il = now()
      WHERE id = $1 AND operatore_id = $2 AND stato = 'attivo'
      RETURNING *`,
    [rapporto, operatore, abilitata]
  );
  if (!rows[0]) throw new Error('Conducente non trovato o non attivo');
  return rows[0];
}

// Solo l'operatore proprietario puo modificare la disponibilita del rapporto attivo.
// Non modifica l'abilitazione alle assegnazioni automatiche.
export async function impostaSempreDisponibile(db, { operatoreId, rapportoId, sempreDisponibile }) {
  verificaDb(db);
  const operatore = interoPositivo(operatoreId, 'operatoreId');
  const rapporto = interoPositivo(rapportoId, 'rapportoId');
  if (typeof sempreDisponibile !== 'boolean') {
    throw new Error('sempreDisponibile deve essere booleano');
  }
  const { rows } = await db.query(
    `UPDATE conducenti_operatori
        SET sempre_disponibile = $3, aggiornato_il = now()
      WHERE id = $1 AND operatore_id = $2 AND stato = 'attivo'
      RETURNING id, operatore_id, conducente_id, stato,
                sempre_disponibile, assegnabile_automaticamente, aggiornato_il`,
    [rapporto, operatore, sempreDisponibile]
  );
  if (!rows[0]) throw new Error('Conducente non trovato o non attivo');
  return rows[0];
}

export async function elencoInvitiConducente(db, conducenteId) {
  verificaDb(db);
  const id = interoPositivo(conducenteId, 'conducenteId');
  const { rows } = await db.query(
    `SELECT co.id, co.operatore_id, co.stato, co.creato_il,
            u.nome AS nome_operatore
       FROM conducenti_operatori co
       JOIN utente u ON u.id = co.operatore_id
      WHERE co.conducente_id = $1 AND co.stato = 'invitato'
      ORDER BY co.creato_il DESC`,
    [id]
  );
  return rows;
}
