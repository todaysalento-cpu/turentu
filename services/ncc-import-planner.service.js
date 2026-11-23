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

function compatible(a, b) {
  return key(a.origine) === key(b.origine) && key(a.destinazione) === key(b.destinazione) &&
    Math.abs(+a.prelievo_il - +b.prelievo_il) <= 20 * 60 * 1000 &&
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
  const rows = await candidati(pool, operatore);
  const veicoli = await veicoliOperatore(pool, operatore);
  const capienza = veicoli.at(-1)?.posti_totali ?? 0;
  const groups = [];
  for (const row of rows) {
    if (row.passeggeri > capienza) continue;
    const group = groups.find(item => compatible(item[0], row) && totalePasseggeri(item) + row.passeggeri <= capienza);
    if (group) group.push(row);
    else groups.push([row]);
  }
  const approvati = (await pool.query(
    `SELECT id, prenotazioni, approvato_il FROM public.ncc_gruppi_approvati
     WHERE operatore_id = $1 ORDER BY id DESC LIMIT 100`, [operatore]
  )).rows;
  return { proposte: groups.filter(group => group.length > 1).map(group => {
    const passeggeri = totalePasseggeri(group);
    const veicolo = veicoli.find(candidate => candidate.posti_totali >= passeggeri);
    return {
      prenotazioni: group.map(row => row.id), passeggeri,
      origine: group[0].origine, destinazione: group[0].destinazione,
      prelievoDal: group[0].prelievo_il, prelievoAl: group.at(-1).prelievo_il, volo: group[0].volo_numero,
      veicoloId: veicolo.id, posti: veicolo.posti_totali,
      riempimento: Math.round(100 * passeggeri / veicolo.posti_totali)
    };
  }).sort((a, b) => Number(Boolean(b.volo)) - Number(Boolean(a.volo)) ||
    Number(b.riempimento >= 75) - Number(a.riempimento >= 75) ||
    Date.parse(a.prelievoDal) - Date.parse(b.prelievoDal)), approvati };
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
    const rows = await candidati(client, operatore, ids, true);
    const veicoli = await veicoliOperatore(client, operatore);
    if (rows.length !== ids.length || !rows.every(row => compatible(rows[0], row)) ||
        !veicoli.some(veicolo => veicolo.posti_totali >= totalePasseggeri(rows))) {
      throw invalid('Il gruppo non è più disponibile. Aggiorna le proposte.', 409);
    }
    const { rows: [result] } = await client.query(
      'INSERT INTO public.ncc_gruppi_approvati (operatore_id, prenotazioni) VALUES ($1, $2) RETURNING id',
      [operatore, rows.map(row => row.id)]
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
