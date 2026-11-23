import { createHash } from 'node:crypto';
import { datiPrenotazione, creaPrenotazioneEsterna } from './gestionale-ncc.service.js';

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export async function importaPrenotazioni(pool, operatore, body) {
  const { righe, conferma } = body ?? {};
  if (!Array.isArray(righe) || !righe.length || righe.length > 100 || typeof conferma !== 'boolean') {
    throw invalid('Invia da 1 a 100 righe e specifica se confermare.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const records = [];
    const hashes = new Set();
    for (const [index, row] of righe.entries()) {
      const riga = index + 2;
      let hash;
      try {
        hash = createHash('sha256').update(JSON.stringify(datiPrenotazione(row))).digest('hex');
      } catch (error) {
        if (error.status !== 400) throw error;
        records.push({ riga, stato: 'da correggere', dettaglio: error.message });
        continue;
      }
      if (hashes.has(hash)) {
        records.push({ riga, stato: 'duplicata' });
        continue;
      }
      hashes.add(hash);
      if (conferma) {
        const result = await creaPrenotazioneEsterna(client, operatore, row, hash);
        records.push({ riga, stato: result ? 'importata' : 'duplicata' });
      } else {
        const { rowCount } = await client.query(
          'SELECT 1 FROM public.ncc_prenotazioni_esterne WHERE operatore_id = $1 AND import_hash = $2',
          [operatore, hash]
        );
        records.push({ riga, stato: rowCount ? 'duplicata' : 'pronta' });
      }
    }
    await client.query('COMMIT');
    return records;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const key = value => value.trim().replace(/\s+/g, ' ').toLowerCase();
const sameFlight = (a, b) => Boolean(a.volo_numero && a.volo_numero === b.volo_numero &&
  a.volo_aeroporto === b.volo_aeroporto && a.volo_direzione === b.volo_direzione &&
  +a.volo_programmato_il === +b.volo_programmato_il);

const defaultParams = { tolleranzaMinuti: 20, obiettivoRiempimento: 75, prioritaVolo: true };
const paramColumns = `tolleranza_minuti AS "tolleranzaMinuti",
  obiettivo_riempimento AS "obiettivoRiempimento", priorita_volo AS "prioritaVolo"`;

async function parametriPianificatore(client, operatore) {
  const { rows } = await client.query(
    `SELECT ${paramColumns} FROM public.ncc_parametri_pianificatore WHERE operatore_id = $1`, [operatore]
  );
  return rows[0] ?? defaultParams;
}

export async function salvaParametriPianificatore(pool, operatore, body) {
  const { tolleranzaMinuti, obiettivoRiempimento, prioritaVolo } = body ?? {};
  if (!Number.isInteger(tolleranzaMinuti) || tolleranzaMinuti < 0 || tolleranzaMinuti > 1440 ||
      !Number.isInteger(obiettivoRiempimento) || obiettivoRiempimento < 0 || obiettivoRiempimento > 100 ||
      typeof prioritaVolo !== 'boolean') {
    throw invalid('Inserisci una tolleranza tra 0 e 1440 minuti e un obiettivo tra 0 e 100%.');
  }
  const { rows } = await pool.query(
    `INSERT INTO public.ncc_parametri_pianificatore
       (operatore_id, tolleranza_minuti, obiettivo_riempimento, priorita_volo)
     VALUES ($1, $2, $3, $4) ON CONFLICT (operatore_id) DO UPDATE SET
       tolleranza_minuti = EXCLUDED.tolleranza_minuti,
       obiettivo_riempimento = EXCLUDED.obiettivo_riempimento,
       priorita_volo = EXCLUDED.priorita_volo
     RETURNING ${paramColumns}`,
    [operatore, tolleranzaMinuti, obiettivoRiempimento, prioritaVolo]
  );
  return rows[0];
}

function compatible(a, b, tolleranzaMinuti) {
  return key(a.origine) === key(b.origine) && key(a.destinazione) === key(b.destinazione) &&
    Math.abs(+a.prelievo_il - +b.prelievo_il) <= tolleranzaMinuti * 60 * 1000 &&
    ((!a.volo_numero && !b.volo_numero) || sameFlight(a, b));
}

async function veicoliOperatore(client, operatore) {
  return (await client.query(
    `SELECT id, posti_totali FROM public.veicolo
     WHERE driver_id = $1 AND stato IS DISTINCT FROM 'eliminato' AND posti_totali > 0
     ORDER BY posti_totali, id`, [operatore]
  )).rows;
}

const totalePasseggeri = rows => rows.reduce((total, row) => total + row.passeggeri, 0);

function dettaglioGruppo(rows, veicoli) {
  if (!rows.length) return null;
  const passeggeri = totalePasseggeri(rows);
  const veicolo = veicoli.find(candidate => candidate.posti_totali >= passeggeri);
  return {
    passeggeri, origine: rows[0].origine, destinazione: rows[0].destinazione,
    prelievoDal: rows[0].prelievo_il, prelievoAl: rows.at(-1).prelievo_il,
    volo: rows[0].volo_numero,
    veicoloId: veicolo?.id ?? null, posti: veicolo?.posti_totali ?? null,
    riempimento: veicolo ? Math.round(100 * passeggeri / veicolo.posti_totali) : null
  };
}

async function candidati(client, operatore, ids = null, lock = false) {
  return (await client.query(
    `SELECT p.id, p.origine, p.destinazione, p.prelievo_il, p.passeggeri, p.volo_numero,
        p.volo_direzione, p.volo_aeroporto, p.volo_programmato_il
     FROM public.ncc_prenotazioni_esterne p
     WHERE p.operatore_id = $1 AND p.annullata_il IS NULL AND p.prelievo_il > now()
       AND ($2::bigint[] IS NULL OR p.id = ANY($2))
       AND NOT EXISTS (SELECT 1 FROM public.ncc_gruppi_approvati g
         WHERE g.operatore_id = $1 AND p.id = ANY(g.prenotazioni))
     ORDER BY p.prelievo_il, p.id LIMIT 200
     ${lock ? 'FOR UPDATE OF p' : ''}`,
    [operatore, ids]
  )).rows;
}

export async function pianificatore(pool, operatore) {
  const parametri = await parametriPianificatore(pool, operatore);
  const rows = await candidati(pool, operatore);
  const veicoli = await veicoliOperatore(pool, operatore);
  const capienza = veicoli.at(-1)?.posti_totali ?? 0;
  const groups = [];
  for (const row of rows) {
    if (row.passeggeri > capienza) continue;
    const group = groups.find(item => compatible(item[0], row, parametri.tolleranzaMinuti) &&
      totalePasseggeri(item) + row.passeggeri <= capienza);
    if (group) group.push(row);
    else groups.push([row]);
  }
  const approvati = (await pool.query(
    `SELECT g.id, g.prenotazioni, g.approvato_il, g.dettaglio,
       ARRAY(SELECT p.id::text FROM public.ncc_prenotazioni_esterne p
         WHERE p.operatore_id = g.operatore_id AND p.id = ANY(g.prenotazioni)
           AND p.annullata_il IS NOT NULL ORDER BY p.id) AS annullate,
       CASE WHEN g.dettaglio IS NULL THEN (
         SELECT jsonb_agg(jsonb_build_object(
           'origine', p.origine, 'destinazione', p.destinazione,
           'prelievo_il', p.prelievo_il, 'passeggeri', p.passeggeri,
           'volo_numero', p.volo_numero
         ) ORDER BY p.prelievo_il, p.id)
         FROM public.ncc_prenotazioni_esterne p
         WHERE p.operatore_id = g.operatore_id AND p.id = ANY(g.prenotazioni)
       ) END AS dati_storici
     FROM public.ncc_gruppi_approvati g
     WHERE g.operatore_id = $1 ORDER BY g.id DESC LIMIT 100`, [operatore]
  )).rows;
  return { parametri, proposte: groups.filter(group => group.length > 1).map(group => ({
    prenotazioni: group.map(row => row.id), ...dettaglioGruppo(group, veicoli)
  })).sort((a, b) => (parametri.prioritaVolo ? Number(Boolean(b.volo)) - Number(Boolean(a.volo)) : 0) ||
    Number(b.riempimento >= parametri.obiettivoRiempimento) - Number(a.riempimento >= parametri.obiettivoRiempimento) ||
    Date.parse(a.prelievoDal) - Date.parse(b.prelievoDal)),
    approvati: approvati.map(({ dettaglio, dati_storici, ...group }) => ({
      ...group,
      dettaglio: dettaglio ?? dettaglioGruppo(dati_storici ?? [], veicoli),
      storico: dettaglio == null
    }))
  };
}

export async function approvaGruppo(pool, operatore, ids) {
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 200 ||
      new Set(ids).size !== ids.length ||
      !ids.every(id => typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n)) {
    throw invalid('Seleziona almeno due prenotazioni valide.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(22022, $1::integer)', [operatore]);
    const parametri = await parametriPianificatore(client, operatore);
    const rows = await candidati(client, operatore, ids, true);
    const veicoli = await veicoliOperatore(client, operatore);
    if (rows.length !== ids.length || !rows.every(row => compatible(rows[0], row, parametri.tolleranzaMinuti)) ||
        !veicoli.some(veicolo => veicolo.posti_totali >= totalePasseggeri(rows))) {
      throw invalid('Il gruppo non è più disponibile. Aggiorna le proposte.', 409);
    }
    const { rows: [result] } = await client.query(
      'INSERT INTO public.ncc_gruppi_approvati (operatore_id, prenotazioni, dettaglio) VALUES ($1, $2, $3::jsonb) RETURNING id',
      [operatore, rows.map(row => row.id), JSON.stringify(dettaglioGruppo(rows, veicoli))]
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function eliminaGruppo(pool, operatore, id) {
  if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    throw invalid('ID gruppo non valido.');
  }
  const { rows } = await pool.query(
    'DELETE FROM public.ncc_gruppi_approvati WHERE operatore_id = $1 AND id = $2 RETURNING id',
    [operatore, id]
  );
  if (!rows.length) throw invalid('Gruppo approvato non trovato.', 404);
  return rows[0];
}
