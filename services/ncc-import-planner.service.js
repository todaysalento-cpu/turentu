import { stimaGruppo, accorpaPerGiornata } from './ncc-economia.service.js';
import { createHash } from 'node:crypto';
import { resolveLocation } from '../routes/distanza.route.js';
import { getDurataDistanza } from '../utils/maps.util.js';
import { creaVerificaMultisalita } from './ncc-multisalita.service.js';
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
  Date.parse(a.volo_programmato_il) === Date.parse(b.volo_programmato_il));

const defaultParams = { tolleranzaMinuti: 20, obiettivoRiempimento: 75, prioritaVolo: true, costiVeicoli: {}, attesaMassimaMinuti: null };
const paramColumns = `tolleranza_minuti AS "tolleranzaMinuti",
  obiettivo_riempimento AS "obiettivoRiempimento", priorita_volo AS "prioritaVolo", costi_veicoli AS "costiVeicoli", attesa_massima_minuti AS "attesaMassimaMinuti"`;

async function parametriPianificatore(client, operatore) {
  const { rows } = await client.query(
    `SELECT ${paramColumns} FROM public.ncc_parametri_pianificatore WHERE operatore_id = $1`, [operatore]
  );
  return rows[0] ?? defaultParams;
}

export async function salvaParametriPianificatore(pool, operatore, body) {
  const { tolleranzaMinuti, obiettivoRiempimento, prioritaVolo, costiVeicoli, attesaMassimaMinuti } = body ?? {};
  if (attesaMassimaMinuti != null && (!Number.isInteger(attesaMassimaMinuti) || attesaMassimaMinuti < 0 || attesaMassimaMinuti > 1440)) {
    throw invalid('L’attesa massima deve essere tra 0 e 1440 minuti.');
  }
  if (costiVeicoli !== undefined) {
    const own = new Set((await veicoliOperatore(pool, operatore)).map(vehicle => String(vehicle.id)));
    if (!costiVeicoli || typeof costiVeicoli !== 'object' || Array.isArray(costiVeicoli) ||
        Object.entries(costiVeicoli).some(([id, value]) => !own.has(id) || !Number.isFinite(value) || value < 0 || value > 1000)) {
      throw invalid('Costo al km o veicolo non valido.');
    }
  }
  if (!Number.isInteger(tolleranzaMinuti) || tolleranzaMinuti < 0 || tolleranzaMinuti > 1440 ||
      !Number.isInteger(obiettivoRiempimento) || obiettivoRiempimento < 0 || obiettivoRiempimento > 100 ||
      typeof prioritaVolo !== 'boolean') {
    throw invalid('Inserisci una tolleranza tra 0 e 1440 minuti e un obiettivo tra 0 e 100%.');
  }
  const { rows } = await pool.query(
    `INSERT INTO public.ncc_parametri_pianificatore
       (operatore_id, tolleranza_minuti, obiettivo_riempimento, priorita_volo, costi_veicoli, attesa_massima_minuti)
     VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), $6) ON CONFLICT (operatore_id) DO UPDATE SET
       tolleranza_minuti = EXCLUDED.tolleranza_minuti,
       obiettivo_riempimento = EXCLUDED.obiettivo_riempimento,
       priorita_volo = EXCLUDED.priorita_volo,
       costi_veicoli = COALESCE($5::jsonb, ncc_parametri_pianificatore.costi_veicoli),
       attesa_massima_minuti = CASE WHEN $7::boolean THEN EXCLUDED.attesa_massima_minuti
         ELSE ncc_parametri_pianificatore.attesa_massima_minuti END
     RETURNING ${paramColumns}`,
    [operatore, tolleranzaMinuti, obiettivoRiempimento, prioritaVolo, costiVeicoli === undefined ? null : JSON.stringify(costiVeicoli),
      attesaMassimaMinuti ?? null, attesaMassimaMinuti !== undefined]
  );
  return rows[0];
}

function compatible(a, b, tolleranzaMinuti) {
  return key(a.origine) === key(b.origine) && key(a.destinazione) === key(b.destinazione) &&
    Math.abs(+a.prelievo_il - +b.prelievo_il) <= tolleranzaMinuti * 60 * 1000 &&
    ((!a.volo_numero && !b.volo_numero) || sameFlight(a, b));
}

function creaTratte() {
  const coordinates = new Map();
  const locate = name => {
    const id = key(name);
    if (!coordinates.has(id)) coordinates.set(id, resolveLocation(name));
    return coordinates.get(id);
  };
  const cache = new Map();
  const deadline = Date.now() + 12000;
  return (from, to) => {
    if (key(from) === key(to)) return Promise.resolve({ distanzaKm: 0, durataMs: 0 });
    const id = JSON.stringify([key(from), key(to)]);
    if (!cache.has(id)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || cache.size >= 64) return Promise.resolve(null);
      cache.set(id, new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), remaining);
        Promise.all([locate(from), locate(to)])
          .then(([origin, destination]) => {
            if (origin.lat === destination.lat && origin.lon === destination.lon) {
              return { distanzaKm: 0, durataMs: 0 };
            }
            return getDurataDistanza(origin, destination).then(route => route?.distanzaKm > 0 && route?.durataMs > 0 ? route : null);
          })
          .then(route => resolve(Number.isFinite(route?.distanzaKm) && route.distanzaKm >= 0 &&
            Number.isFinite(route?.durataMs) && route.durataMs >= 0 ? route : null), () => resolve(null))
          .finally(() => clearTimeout(timer));
      }));
    }
    return cache.get(id);
  };
}

async function valutaGruppo(rows, parametri, verifica) {
  const first = rows[0];
  if (rows.every(row => key(row.origine) === key(first.origine))) {
    return rows.every(row => compatible(first, row, parametri.tolleranzaMinuti)) ? {} : null;
  }
  if (first.volo_direzione !== 'partenza' ||
      !rows.every(row => sameFlight(first, row) && key(row.destinazione) === key(first.destinazione))) return null;
  const itinerary = await verifica(rows, parametri.tolleranzaMinuti);
  return itinerary ? { itinerario: itinerary } : null;
}

async function veicoliOperatore(client, operatore) {
  return (await client.query(
    `SELECT id, posti_totali, marca, modello, targa, localita,
       ST_Y(coord::geometry) AS lat, ST_X(coord::geometry) AS lon FROM public.veicolo
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
    `SELECT p.id, p.origine, p.destinazione, p.prelievo_il, p.passeggeri, p.prezzo_centesimi, p.volo_numero,
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
  const tratta = creaTratte();
  const verifica = creaVerificaMultisalita(tratta);
  for (const row of rows) {
    if (row.passeggeri > capienza) continue;
    let added = false;
    for (const group of groups) {
      if (totalePasseggeri(group.rows) + row.passeggeri > capienza) continue;
      const next = [...group.rows, row];
      const detail = await valutaGruppo(next, parametri, verifica);
      if (!detail) continue;
      group.rows = next;
      group.detail = detail;
      added = true;
      break;
    }
    if (!added) groups.push({ rows: [row], detail: {} });
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
  const proposte = await Promise.all(groups.filter(group => group.rows.length > 1).map(({ rows, detail }) =>
    stimaGruppo({ prenotazioni: rows.map(row => row.id), ...dettaglioGruppo(rows, veicoli), ...detail },
      rows, parametri.costiVeicoli, tratta)));
  proposte.sort((a, b) => (parametri.prioritaVolo ? Number(Boolean(b.volo)) - Number(Boolean(a.volo)) : 0) ||
    Number(b.riempimento >= parametri.obiettivoRiempimento) - Number(a.riempimento >= parametri.obiettivoRiempimento) ||
    Date.parse(a.prelievoDal) - Date.parse(b.prelievoDal));
  const { rows: missioniSalvate } = await pool.query(
    `SELECT dettaglio->'missione'->>'giorno' AS giorno, dettaglio->'missione'->>'veicoloId' AS veicolo
     FROM public.ncc_gruppi_approvati WHERE operatore_id = $1
       AND dettaglio->'missione'->>'giorno' >= (now() AT TIME ZONE 'Europe/Rome')::date::text`, [operatore]
  );
  const occupati = new Set(missioniSalvate.map(missione => missione.giorno + '/' + missione.veicolo));
  return { parametri, proposte, veicoli, accorpamenti: await accorpaPerGiornata(proposte, tratta, veicoli, parametri.costiVeicoli, occupati, parametri.attesaMassimaMinuti),
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
    if (rows.length !== ids.length ||
        !veicoli.some(veicolo => veicolo.posti_totali >= totalePasseggeri(rows))) {
      throw invalid('Il gruppo non è più disponibile. Aggiorna le proposte.', 409);
    }
    const tratta = creaTratte();
    const detail = await valutaGruppo(rows, parametri, creaVerificaMultisalita(tratta));
    if (!detail) throw invalid('Itinerario non disponibile o fuori dai vincoli. Aggiorna le proposte.', 409);
    const snapshot = await stimaGruppo({ ...dettaglioGruppo(rows, veicoli), ...detail }, rows, parametri.costiVeicoli, tratta);
    const { rows: [result] } = await client.query(
      'INSERT INTO public.ncc_gruppi_approvati (operatore_id, prenotazioni, dettaglio) VALUES ($1, $2, $3::jsonb) RETURNING id',
      [operatore, rows.map(row => row.id), JSON.stringify(snapshot)]
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

export async function approvaMissione(pool, operatore, body) {
  const { giorno, veicoloId, gruppi } = body ?? {};
  if (typeof giorno !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(giorno) ||
      !Number.isSafeInteger(veicoloId) || veicoloId < 1 || !Array.isArray(gruppi) ||
      !gruppi.length || gruppi.length > 100 ||
      gruppi.some(group => !Array.isArray(group) || group.length < 2 || group.length > 200)) {
    throw invalid('Missione non valida.');
  }
  const ids = gruppi.flat();
  if (ids.length > 200 || new Set(ids).size !== ids.length ||
      !ids.every(id => typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n)) {
    throw invalid('Prenotazioni della missione non valide.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(22022, $1::integer)', [operatore]);
    const rows = await candidati(client, operatore, ids, true);
    if (rows.length !== ids.length) throw invalid('Missione cambiata. Ricalcola le proposte.', 409);
    const { accorpamenti } = await pianificatore(client, operatore);
    const requested = JSON.stringify(gruppi);
    const missione = accorpamenti.find(item => item.giorno === giorno && Number(item.veicoloId) === veicoloId &&
      JSON.stringify(item.gruppi.map(group => group.prenotazioni)) === requested);
    if (!missione) throw invalid('Missione cambiata. Ricalcola le proposte.', 409);
    const { rows: [result] } = await client.query(
      'INSERT INTO public.ncc_gruppi_approvati (operatore_id, prenotazioni, dettaglio) VALUES ($1, $2, $3::jsonb) RETURNING id',
      [operatore, ids, JSON.stringify({ missione })]
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
