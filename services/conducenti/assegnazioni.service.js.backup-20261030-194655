// Turentu — assegnazioni conducenti, indipendente da PIXEL e POPBUS.
// Richiede un client pg con transazione BEGIN già aperta dal chiamante.
// Non effettua COMMIT/ROLLBACK: il chiamante conferma o annulla l'intera operazione.

const idValido = (v, nome) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${nome} non valido`);
  return n;
};

function intervallo(inizio, fine) {
  // Richiedere timestamp ISO con offset esplicito per evitare ambiguità di fuso.
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/i;
  if (typeof inizio !== 'string' || typeof fine !== 'string' || !iso.test(inizio) || !iso.test(fine)) {
    throw new Error('Usare date ISO 8601 con fuso orario esplicito');
  }
  const da = new Date(inizio), a = new Date(fine);
  if (!Number.isFinite(+da) || !Number.isFinite(+a) || a <= da) throw new Error('Intervallo operativo non valido');
  if (+a - +da > 31 * 86400000) throw new Error('Intervallo superiore a 31 giorni');
  return [da.toISOString(), a.toISOString()];
}

async function verificaVeicolo(client, operatoreId, veicoloId) {
  const { rows } = await client.query(
    'SELECT id FROM veicolo WHERE id=$1 AND driver_id=$2 FOR SHARE',
    [veicoloId, operatoreId]
  );
  if (!rows.length) throw new Error('Veicolo non appartenente all’operatore');
}

async function rapporto(client, operatoreId, conducenteId, { automatico = false } = {}) {
  if (operatoreId === conducenteId) return { titolare: true };
  const { rows } = await client.query(
    `SELECT id FROM conducenti_operatori
      WHERE operatore_id=$1 AND conducente_id=$2 AND stato='attivo'
        AND ($3::boolean = false OR assegnabile_automaticamente=true)
      FOR SHARE`,
    [operatoreId, conducenteId, automatico]
  );
  if (!rows.length) throw new Error('Conducente non associato, non attivo o non abilitato');
  return { titolare: false, rapportoId: rows[0].id };
}

// Verifica copertura completa del periodo, considerando turni settimanali ed eccezioni.
// Le indisponibilità hanno sempre precedenza. Le disponibilità straordinarie
// aggiungono copertura; i turni devono essere definiti in Europe/Rome.
async function verificaCopertura(client, rapportoId, da, a) {
  const { rows } = await client.query(`
    WITH giorni AS (
      SELECT generate_series(
        ($2::timestamptz AT TIME ZONE 'Europe/Rome')::date - 1,
        ($3::timestamptz AT TIME ZONE 'Europe/Rome')::date + 1,
        interval '1 day'
      )::date AS giorno
    ), fasce AS (
      SELECT tstzrange(
        (g.giorno + t.ora_inizio) AT TIME ZONE 'Europe/Rome',
        (g.giorno + t.ora_fine) AT TIME ZONE 'Europe/Rome', '[)'
      ) AS fascia
      FROM giorni g JOIN turni_conducenti t
        ON t.rapporto_id=$1 AND t.attivo=true
       AND t.giorno_settimana=EXTRACT(ISODOW FROM g.giorno)
       AND t.fuso_orario='Europe/Rome'
      UNION ALL
      SELECT intervallo FROM eccezioni_turni_conducenti
       WHERE rapporto_id=$1 AND tipo='disponibile'
    ), copertura AS (
      SELECT COALESCE(range_agg(fascia), '{}'::tstzmultirange) AS intervalli FROM fasce
    ), assenze AS (
      SELECT COALESCE(range_agg(intervallo), '{}'::tstzmultirange) AS intervalli
      FROM eccezioni_turni_conducenti
      WHERE rapporto_id=$1 AND tipo='indisponibile'
    )
    SELECT ((copertura.intervalli - assenze.intervalli)
              @> tstzrange($2::timestamptz,$3::timestamptz,'[)')) AS coperto
    FROM copertura CROSS JOIN assenze`, [rapportoId, da, a]
  );
  return rows[0]?.coperto === true;
}

async function verificaTarget(client, { corsaId, attivazioneId, veicoloId, operatoreId }) {
  if ((corsaId == null) === (attivazioneId == null)) throw new Error('Specificare solo corsaId oppure attivazioneId');
  if (corsaId != null) {
    const { rows } = await client.query(
      `SELECT c.id FROM corse c WHERE c.id=$1 AND c.veicolo_id=$2 FOR SHARE`,
      [corsaId, veicoloId]
    );
    if (!rows.length) throw new Error('Corsa inesistente o non associata al veicolo');
  } else {
    const { rows } = await client.query(
      `SELECT a.id FROM popbus_attivazioni a
       WHERE a.id=$1 AND a.veicolo_id=$2 AND a.autista_id=$3 FOR SHARE`,
      [attivazioneId, veicoloId, operatoreId]
    );
    if (!rows.length) throw new Error('Attivazione inesistente o non appartenente all’operatore');
  }
}

/**
 * Assegna manualmente o automaticamente un conducente a una missione già esistente.
 * Il chiamante deve aver aperto una transazione su client pg (non pool.query).
 * Per il titolare: modalita='titolare', conducenteId=operatoreId.
 * Per automatico: omettere conducenteId; seleziona solo rapporti abilitati.
 * Gli intervalli sono forniti dal chiamante e devono comprendere TUTTO il ciclo operativo.
 */
export async function assegnaConducente(client, input) {
  if (!client || typeof client.query !== 'function') throw new Error('Client PostgreSQL richiesto');
  const operatoreId = idValido(input.operatoreId, 'operatoreId');
  const veicoloId = idValido(input.veicoloId, 'veicoloId');
  const corsaId = input.corsaId == null ? null : idValido(input.corsaId, 'corsaId');
  const attivazioneId = input.attivazioneId == null ? null : idValido(input.attivazioneId, 'attivazioneId');
  // L'endpoint NCC manuale deriva l'intervallo esclusivamente dal DB.
  const usaCicloPersistito = input.usaCicloPersistito === true;
  if (usaCicloPersistito && input.attivazioneId != null) {
    throw new Error('Assegnazione POPBUS non abilitata da questo endpoint');
  }
  let [da, a] = usaCicloPersistito ? [null, null] : intervallo(input.inizio, input.fine);
  const modalita = input.modalita;
  const confermaDeroga = input.confermaDeroga === true;
  const motivoDeroga = typeof input.motivoDeroga === 'string' ? input.motivoDeroga.trim() : '';
  const autorizzatoreId = input.autorizzatoreId == null ? null : idValido(input.autorizzatoreId, 'autorizzatoreId');
  if (!['manuale', 'automatica', 'titolare'].includes(modalita)) throw new Error('Modalità non valida');
  if (input.confermaDeroga != null && typeof input.confermaDeroga !== 'boolean') throw new Error('Conferma deroga non valida');
  if (confermaDeroga && modalita !== 'manuale') throw new Error('Deroga consentita solo in manuale');
  if (confermaDeroga && (motivoDeroga.length < 5 || motivoDeroga.length > 500)) throw new Error('Motivazione deroga richiesta (5-500 caratteri)');
  if (confermaDeroga && autorizzatoreId !== operatoreId) throw new Error('Autorizzatore deroga non valido');
  if (!confermaDeroga && (motivoDeroga || autorizzatoreId != null)) throw new Error('Dati deroga senza conferma');
  if (modalita === 'automatica' && input.conducenteId != null) throw new Error('In automatica non specificare conducenteId');
  if (modalita !== 'automatica' && input.conducenteId == null) throw new Error('Specificare conducenteId');

  // Serializza le assegnazioni per operatore; il vincolo GiST tutela anche
  // contro concorrenza tra operatori diversi sul medesimo conducente.
  await client.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [731904, operatoreId]);
  await verificaVeicolo(client, operatoreId, veicoloId);
  await verificaTarget(client, { corsaId, attivazioneId, veicoloId, operatoreId });

  if (usaCicloPersistito) {
    if (modalita !== 'manuale' || corsaId == null || attivazioneId != null) {
      throw new Error('Endpoint abilitato soltanto per assegnazioni manuali NCC');
    }
    // La riga e' protetta da FOR SHARE in verificaTarget: impedisce
    // modifiche concorrenti agli orari fino al termine della transazione.
    const { rows: corse } = await client.query(`
      SELECT stato, tipo_corsa, inizio_ciclo_operativo, fine_ciclo_operativo
      FROM public.corse WHERE id=$1 AND veicolo_id=$2 FOR SHARE
    `, [corsaId, veicoloId]);
    const corsa = corse[0];
    if (!corsa || !['privata', 'condivisa'].includes(corsa.tipo_corsa) ||
        !['prenotabile', 'da_attivare'].includes(corsa.stato)) {
      throw new Error('Corsa NCC non assegnabile nello stato attuale');
    }
    const start = corsa.inizio_ciclo_operativo;
    const end = corsa.fine_ciclo_operativo;
    if (!(start instanceof Date) || !(end instanceof Date) ||
        !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) ||
        start >= end || start <= new Date()) {
      throw new Error('Ciclo operativo completo e futuro obbligatorio');
    }
    [da, a] = intervallo(start.toISOString(), end.toISOString());
  }

  // Impedisce due conducenti diversi sulla stessa missione o sullo
  // stesso veicolo durante intervalli operativi sovrapposti.
  const { rows: veicoloOccupato } = await client.query(`
    SELECT id FROM assegnazioni_conducenti
    WHERE veicolo_id=$1 AND stato='assegnata'
      AND (corsa_id=$2 OR
           intervallo_operativo && tstzrange($3::timestamptz,$4::timestamptz,'[)'))
    LIMIT 1
  `, [veicoloId, corsaId, da, a]);
  if (veicoloOccupato.length) {
    const err = new Error('Veicolo o corsa gia assegnati nel periodo');
    err.status = 409;
    throw err;
  }

  let candidati;
  if (modalita === 'automatica') {
    const { rows } = await client.query(
      `SELECT conducente_id, id AS rapporto_id
       FROM conducenti_operatori
       WHERE operatore_id=$1 AND stato='attivo' AND assegnabile_automaticamente=true
       ORDER BY conducente_id`, [operatoreId]
    );
    candidati = rows.map(r => ({ id: Number(r.conducente_id), rapportoId: r.rapporto_id }));
    // Titolare non incluso automaticamente: attivazione esplicita con modalita=titolare.
  } else {
    const conducenteId = idValido(input.conducenteId, 'conducenteId');
    if (modalita === 'titolare' && conducenteId !== operatoreId) throw new Error('Titolare diverso dall’operatore');
    if (modalita === 'manuale' && conducenteId === operatoreId) throw new Error('Usare modalità titolare');
    const r = await rapporto(client, operatoreId, conducenteId);
    candidati = [{ id: conducenteId, rapportoId: r.rapportoId }];
  }

  for (const candidato of candidati) {
    const coperto = candidato.rapportoId == null
      ? true
      : await verificaCopertura(client, candidato.rapportoId, da, a);
    if (!coperto) {
      if (modalita === 'automatica') continue;
      if (!confermaDeroga) {
        const err = new Error('Conferma esplicita richiesta per assegnazione fuori turno');
        err.code = 'CONDUCENTE_DEROGA_RICHIESTA';
        err.status = 409;
        throw err;
      }
    }
    const { rows: conflitti } = await client.query(
      `SELECT id FROM assegnazioni_conducenti
       WHERE conducente_id=$1 AND stato='assegnata'
         AND intervallo_operativo && tstzrange($2::timestamptz,$3::timestamptz,'[)')
       LIMIT 1`, [candidato.id, da, a]
    );
    if (conflitti.length) {
      if (modalita !== 'automatica') throw new Error('Conducente già impegnato nel periodo');
      continue;
    }
    const { rows } = await client.query(
      `INSERT INTO assegnazioni_conducenti
        (operatore_id,conducente_id,veicolo_id,corsa_id,attivazione_id,intervallo_operativo,modalita,
          deroga_turno,deroga_motivo,deroga_autorizzata_da,deroga_autorizzata_il)
       VALUES ($1,$2,$3,$4,$5,tstzrange($6::timestamptz,$7::timestamptz,'[)'),$8,
                $9,$10,$11,CASE WHEN $9::boolean THEN NOW() ELSE NULL END)
       RETURNING id,operatore_id,conducente_id,veicolo_id,corsa_id,attivazione_id,
                 lower(intervallo_operativo) AS inizio,upper(intervallo_operativo) AS fine,
                  modalita,stato,deroga_turno,deroga_motivo,deroga_autorizzata_da,deroga_autorizzata_il`,
      [operatoreId, candidato.id, veicoloId, corsaId, attivazioneId, da, a, modalita,
        !coperto, !coperto ? motivoDeroga : null, !coperto ? autorizzatoreId : null]
    );
    return rows[0];
  }
  throw new Error('Nessun conducente disponibile per l’intero ciclo operativo');
}

// Elenco delle missioni del conducente autenticato.
// La visibilità è limitata alle proprie assegnazioni ancora attive.
// Il titolare-operatore può essere assegnato a sé stesso senza un rapporto
// in conducenti_operatori; gli altri conducenti richiedono un rapporto attivo.
export async function elencoAssegnazioniConducente(client, conducenteId) {
  const id = idValido(conducenteId, 'conducenteId');

  const { rows } = await client.query(
    `SELECT
        ac.id,
        ac.operatore_id,
        ac.conducente_id,
        ac.veicolo_id,
        ac.corsa_id,
        ac.attivazione_id,
        lower(ac.intervallo_operativo) AS inizio,
        upper(ac.intervallo_operativo) AS fine,
        ac.modalita,
        ac.stato,
        ac.creata_il,
        u.nome AS nome_operatore
     FROM assegnazioni_conducenti ac
     LEFT JOIN utente u ON u.id = ac.operatore_id
     WHERE ac.conducente_id = $1
       AND ac.stato = 'assegnata'
       AND (
         ac.operatore_id = ac.conducente_id
         OR EXISTS (
           SELECT 1
             FROM conducenti_operatori co
            WHERE co.operatore_id = ac.operatore_id
              AND co.conducente_id = ac.conducente_id
              AND co.stato = 'attivo'
         )
       )
     ORDER BY lower(ac.intervallo_operativo) ASC
     LIMIT 200`,
    [id]
  );

  return rows;
}

export async function elencoAssegnazioni(client, { operatoreId, conducenteId = null }) {
  const op = idValido(operatoreId, 'operatoreId');
  const cond = conducenteId == null ? null : idValido(conducenteId, 'conducenteId');
  const { rows } = await client.query(
    `SELECT id, operatore_id, conducente_id, veicolo_id, corsa_id, attivazione_id,
            lower(intervallo_operativo) AS inizio, upper(intervallo_operativo) AS fine,
            modalita, stato, creata_il
       FROM assegnazioni_conducenti
      WHERE operatore_id=$1 AND ($2::integer IS NULL OR conducente_id=$2)
      ORDER BY lower(intervallo_operativo) DESC LIMIT 200`, [op, cond]
  );
  return rows;
}

// Il chiamante deve validare il diritto di annullare la missione e gestire
// lo stato commerciale della corsa; questa funzione modifica solo l'assegnazione.
export async function annullaAssegnazione(client, { operatoreId, assegnazioneId }) {
  const op = idValido(operatoreId, 'operatoreId');
  const id = idValido(assegnazioneId, 'assegnazioneId');
  const { rows } = await client.query(
    `UPDATE assegnazioni_conducenti
        SET stato='annullata', aggiornata_il=now()
      WHERE id=$1 AND operatore_id=$2 AND stato='assegnata'
      RETURNING id,stato`, [id, op]
  );
  if (!rows.length) throw new Error('Assegnazione attiva non trovata');
  return rows[0];
}

