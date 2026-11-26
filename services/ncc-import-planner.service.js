
import {
  ottimizzaIbridoNcc
} from './ncc-ottimizzazione-ibrida.service.js';

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

const defaultParams = { tolleranzaMinuti: 20, obiettivoRiempimento: 75, prioritaVolo: true, costiVeicoli: {}, attesaMassimaMinuti: null, durataMassimaMissioneMinuti: null };
const paramColumns = `tolleranza_minuti AS "tolleranzaMinuti",
  obiettivo_riempimento AS "obiettivoRiempimento", priorita_volo AS "prioritaVolo", costi_veicoli AS "costiVeicoli", attesa_massima_minuti AS "attesaMassimaMinuti",
  durata_massima_missione_minuti AS "durataMassimaMissioneMinuti"`;

async function parametriPianificatore(client, operatore) {
  const { rows } = await client.query(
    `SELECT ${paramColumns} FROM public.ncc_parametri_pianificatore WHERE operatore_id = $1`, [operatore]
  );
  return rows[0] ?? defaultParams;
}

export async function salvaParametriPianificatore(pool, operatore, body) {
  const { tolleranzaMinuti, obiettivoRiempimento, prioritaVolo, costiVeicoli, attesaMassimaMinuti, durataMassimaMissioneMinuti } = body ?? {};
  if (durataMassimaMissioneMinuti != null &&
      (!Number.isInteger(durataMassimaMissioneMinuti) || durataMassimaMissioneMinuti < 1 || durataMassimaMissioneMinuti > 1440)) {
    throw invalid('La durata massima della missione deve essere tra 1 e 1440 minuti.');
  }
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
       (operatore_id, tolleranza_minuti, obiettivo_riempimento, priorita_volo, costi_veicoli, attesa_massima_minuti, durata_massima_missione_minuti)
     VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), $6, $8) ON CONFLICT (operatore_id) DO UPDATE SET
       tolleranza_minuti = EXCLUDED.tolleranza_minuti,
       obiettivo_riempimento = EXCLUDED.obiettivo_riempimento,
       priorita_volo = EXCLUDED.priorita_volo,
       costi_veicoli = COALESCE($5::jsonb, ncc_parametri_pianificatore.costi_veicoli),
       attesa_massima_minuti = CASE WHEN $7::boolean THEN EXCLUDED.attesa_massima_minuti
         ELSE ncc_parametri_pianificatore.attesa_massima_minuti END,
       durata_massima_missione_minuti = CASE WHEN $9::boolean THEN EXCLUDED.durata_massima_missione_minuti
         ELSE ncc_parametri_pianificatore.durata_massima_missione_minuti END
     RETURNING ${paramColumns}`,
    [operatore, tolleranzaMinuti, obiettivoRiempimento, prioritaVolo, costiVeicoli === undefined ? null : JSON.stringify(costiVeicoli),
      attesaMassimaMinuti ?? null, attesaMassimaMinuti !== undefined, durataMassimaMissioneMinuti ?? null, durataMassimaMissioneMinuti !== undefined]
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

async function candidati(client, operatore, ids = null, lock = false, giornoSimulazione = null) {
  return (await client.query(
    `SELECT p.id, p.origine, p.destinazione, p.prelievo_il, p.passeggeri, p.prezzo_centesimi, p.volo_numero,
        p.volo_direzione, p.volo_aeroporto, p.volo_programmato_il, p.volo_aggiornato_il, p.bagagli
     FROM public.ncc_prenotazioni_esterne p
     WHERE p.operatore_id = $1 AND p.annullata_il IS NULL AND (($3::date IS NULL AND p.prelievo_il > now()) OR ($3::date IS NOT NULL AND (p.prelievo_il AT TIME ZONE 'Europe/Rome')::date = $3::date))
       AND ($2::bigint[] IS NULL OR p.id = ANY($2))
       AND NOT EXISTS (SELECT 1 FROM public.ncc_gruppi_approvati g
         WHERE g.operatore_id = $1 AND p.id = ANY(g.prenotazioni))
     ORDER BY p.prelievo_il, p.id LIMIT 200
     ${lock ? 'FOR UPDATE OF p' : ''}`,
    [operatore, ids, giornoSimulazione]
  )).rows;
}

export async function pianificatore(pool, operatore, opzioni = {}) {
  const parametri = await parametriPianificatore(pool, operatore);
  const giorno = opzioni.giorno ?? null;
  const simulazione = opzioni.modalita === 'simulazione';
  if (simulazione && (typeof giorno !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(giorno) || !Number.isFinite(Date.parse(giorno)) || new Date(giorno).toISOString().slice(0, 10) !== giorno)) throw invalid('Giornata simulazione non valida.');
  const rows = await candidati(pool, operatore, null, false, simulazione ? giorno : null);
  const veicoli = await veicoliOperatore(pool, operatore);
  const capienza = veicoli.at(-1)?.posti_totali ?? 0;
  const groups = [];
  const tratta = creaTratte();
  const riferimento = simulazione ? Number((await pool.query("SELECT EXTRACT(EPOCH FROM ($1::date::timestamp AT TIME ZONE 'Europe/Rome')) * 1000 AS ms", [giorno])).rows[0].ms) : Date.now();
  const verifica = creaVerificaMultisalita(tratta, riferimento);
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
       AND (($2::date IS NULL AND dettaglio->'missione'->>'giorno' >= (now() AT TIME ZONE 'Europe/Rome')::date::text) OR ($2::date IS NOT NULL AND dettaglio->'missione'->>'giorno' = $2::date::text))`, [operatore, simulazione ? giorno : null]
  );
  const occupati = new Set(missioniSalvate.map(missione => missione.giorno + '/' + missione.veicolo));
  return { modalita: simulazione ? 'simulazione' : 'operativa', giorno: simulazione ? giorno : null, approvabile: !simulazione, totalePrenotazioni: rows.length, totalePasseggeri: totalePasseggeri(rows), parametri, proposte, veicoli, accorpamenti: await accorpaPerGiornata(proposte, tratta, veicoli, parametri.costiVeicoli, occupati, parametri.attesaMassimaMinuti, parametri.durataMassimaMissioneMinuti),
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


export async function simulazioneNccV2(pool, operatore, giorno, routing) {
  if (typeof giorno !== 'string' || !Number.isFinite(Date.parse(giorno)) || new Date(giorno).toISOString().slice(0,10) !== giorno) throw invalid('Giornata simulazione non valida.');
  const { aggregaPrenotazioniNcc } = await import('./ncc-aggregazione.service.js');
  const parametri = await parametriPianificatore(pool, operatore);
  const rows = await candidati(pool, operatore, null, false, giorno);
  const veicoli = await veicoliOperatore(pool, operatore);
  const riferimento = Number((await pool.query("SELECT EXTRACT(EPOCH FROM ($1::date::timestamp AT TIME ZONE 'Europe/Rome')) * 1000 AS ms", [giorno])).rows[0].ms);
  const { creaGeografiaSimulazioneNcc } = await import('./ncc-geografia-simulazione.service.js');
  const geografia = creaGeografiaSimulazioneNcc(pool);
  const utilizzabili = [];
  const escluseGeografia = [];
  const indicative = new Set();
  const registrate = new Map();
  const cacheGeo = new Map();
  async function valida(indirizzo, ruolo) {
    const k = JSON.stringify([indirizzo, ruolo]);
    if (!cacheGeo.has(k)) cacheGeo.set(k, geografia.validaPunto(indirizzo, ruolo));
    return cacheGeo.get(k);
  }
  for (const row of rows) {
    const origine = await valida(row.origine, 'origine');
    const destinazione = await valida(row.destinazione, 'destinazione');
    if (!origine.utilizzabileSimulazione || !destinazione.utilizzabileSimulazione) {
      escluseGeografia.push({ id: row.id, passeggeri: row.passeggeri, motivo: 'GEOGRAFIA_DA_VERIFICARE', origine: origine.stato, destinazione: destinazione.stato });
      continue;
    }
    const punti = [[row.origine, origine], [row.destinazione, destinazione]];
    const verifica = new Map(registrate);
    let conflitto = false;
    for (const [nome, geo] of punti) {
      const k = key(nome);
      const c = JSON.stringify([geo.lat, geo.lon]);
      if (verifica.has(k) && verifica.get(k) !== c) conflitto = true;
      verifica.set(k, c);
    }
    if (conflitto) {
      escluseGeografia.push({ id: row.id, passeggeri: row.passeggeri, motivo: 'CONFLITTO_COORDINATE' });
      continue;
    }
    for (const [nome, geo] of punti) {
      const k = key(nome);
      if (!registrate.has(k)) {
        routing.registraCoordinate(nome, geo);
        registrate.set(k, JSON.stringify([geo.lat, geo.lon]));
      }
    }
    if (origine.indicativo || destinazione.indicativo) indicative.add(String(row.id));
    utilizzabili.push(row);
  }
  const risultato = await aggregaPrenotazioniNcc(utilizzabili, routing, veicoli, parametri, riferimento);
  for (const proposta of risultato.proposte) {
    proposta.prenotazioniIndicative = proposta.prenotazioni.filter(id => indicative.has(String(id)));
    proposta.geografiaIndicativa = proposta.prenotazioniIndicative.length > 0;
    proposta.approvabile = false;
  }
  risultato.nonAssegnate = [...risultato.nonAssegnate, ...escluseGeografia];
  risultato.riepilogo.prenotazioniTotali = rows.length;
  risultato.riepilogo.prenotazioniNonAssegnate = risultato.nonAssegnate.length;
  risultato.riepilogo.prenotazioniEscluseGeografia = escluseGeografia.length;
  risultato.riepilogo.prenotazioniIndicative = indicative.size;
  risultato.riepilogo.proposteIndicative = risultato.proposte.filter(p => p.geografiaIndicativa).length;
  return { motore: 'V2', modalita: 'simulazione', approvabile: false, giorno, parametri, totalePrenotazioni: rows.length, totalePasseggeri: totalePasseggeri(rows), veicoli, ...risultato, geografia: { utilizzabili: utilizzabili.length, escluse: escluseGeografia.length, passeggeriUtilizzabili: totalePasseggeri(utilizzabili), passeggeriEsclusi: totalePasseggeri(escluseGeografia), dettaglioEscluse: escluseGeografia, diagnostica: geografia.diagnostica() }, routing: routing.diagnostica?.() ?? null };
}


// NCC_ORCHESTRATORE_V26

export async function simulazioneNccV26(
  pool,
  operatore,
  giorno,
  dipendenze = {}
) {

  if (
    typeof giorno !== 'string' ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(giorno) ||
    !Number.isFinite(Date.parse(giorno)) ||
    new Date(giorno).toISOString().slice(0, 10) !== giorno
  ) {
    throw invalid('Giornata simulazione non valida.');
  }

  const {
    creaSessionManagerNcc
  } = await import('./ncc-planner-session.service.js');

  const {
    creaRoutingNcc
  } = await import('./ncc-routing-matrix.service.js');

  const {
    creaGeografiaGuardNcc
  } = await import('./ncc-geografia-guard.service.js');

  const {
    creaGeografiaSimulazioneNcc
  } = await import('./ncc-geografia-simulazione.service.js');

  const {
    aggregaPrenotazioniNcc
  } = await import('./ncc-aggregazione.service.js');

  const {
    ottimizzaMissioniNcc
  } = await import('./ncc-ottimizzatore.service.js');

  const manager =
    dipendenze.manager ?? creaSessionManagerNcc();

  const esito = await manager.esegui(
    operatore,
    async sessione => {

      const verificaAttiva = sessione.verificaAttiva;

      verificaAttiva();

      async function protetto(fn) {
        verificaAttiva();
        const risultato = await fn();
        verificaAttiva();
        return risultato;
      }

      const parametri = await protetto(
        () => parametriPianificatore(pool, operatore)
      );

      const rows = await protetto(
        () => candidati(pool, operatore, null, false, giorno)
      );

      const flotta = await protetto(
        () => veicoliOperatore(pool, operatore)
      );

      const dataRiferimento = await protetto(
        () => pool.query(
          "SELECT EXTRACT(EPOCH FROM ($1::date::timestamp AT TIME ZONE 'Europe/Rome')) * 1000 AS ms",
          [giorno]
        )
      );

      const riferimento =
        Number(dataRiferimento.rows[0].ms);

      if (!Number.isFinite(riferimento)) {
        throw invalid('Riferimento temporale non valido.', 500);
      }

      const impegni = await protetto(
        () => pool.query(
          "SELECT dettaglio->'missione'->>'giorno' AS giorno, dettaglio->'missione'->>'veicoloId' AS veicolo FROM public.ncc_gruppi_approvati WHERE operatore_id = $1 AND dettaglio->'missione'->>'giorno' = $2::date::text",
          [operatore, giorno]
        )
      );

      const occupati = new Set(
        impegni.rows.map(
          m => m.giorno + '/' + m.veicolo
        )
      );

      const veicoli = [];
      const veicoliEsclusi = [];

      function coordinateValide(c) {
        return (
          Number.isFinite(c?.lat) &&
          Number.isFinite(c?.lon) &&
          Math.abs(c.lat) <= 90 &&
          Math.abs(c.lon) <= 180 &&
          (c.lat !== 0 || c.lon !== 0)
        );
      }

      for (const v of flotta) {

        verificaAttiva();

        if (!coordinateValide(v)) {
          veicoliEsclusi.push({
            id: v.id,
            motivo: 'BASE_NON_VALIDA'
          });
          continue;
        }

        if (occupati.has(giorno + '/' + v.id)) {
          veicoliEsclusi.push({
            id: v.id,
            motivo: 'VEICOLO_GIA_IMPEGNATO'
          });
          continue;
        }

        veicoli.push(v);
      }

      const guard = creaGeografiaGuardNcc({
        signal: sessione.signal,
        verificaAttiva,
        autorizzaDistribuita: sessione.autorizzaGeografia,
        autorizzazioneRigorosa: true
      });

      const geografia = (
        dipendenze.creaGeografia ??
        creaGeografiaSimulazioneNcc
      )(pool, { guard });

      if (geografia.guard !== guard) {
        throw new Error('NCC_GUARD_NON_CONDIVISO');
      }

      const utilizzabili = [];
      const escluseGeografia = [];
      const indicative = new Set();
      const registrate = new Map();
      const cacheGeo = new Map();

      async function valida(indirizzo, ruolo) {

        verificaAttiva();

        const k = JSON.stringify([indirizzo, ruolo]);

        if (!cacheGeo.has(k)) {
          cacheGeo.set(
            k,
            geografia.validaPunto(indirizzo, ruolo)
          );
        }

        const risultato = await cacheGeo.get(k);

        verificaAttiva();

        return risultato;
      }

      for (const row of rows) {

        verificaAttiva();

        const origine = await valida(
          row.origine,
          'origine'
        );

        const destinazione = await valida(
          row.destinazione,
          'destinazione'
        );

        if (
          !origine.utilizzabileSimulazione ||
          !destinazione.utilizzabileSimulazione ||
          !coordinateValide(origine) ||
          !coordinateValide(destinazione)
        ) {

          escluseGeografia.push({
            id: String(row.id),
            passeggeri: row.passeggeri,
            motivo: 'GEOGRAFIA_DA_VERIFICARE',
            origine: origine.stato,
            destinazione: destinazione.stato
          });

          continue;
        }

        const punti = [
          [row.origine, origine],
          [row.destinazione, destinazione]
        ];

        const verifica = new Map(registrate);

        let conflitto = false;

        for (const [nome, geo] of punti) {

          const k = key(nome);

          const precedente = verifica.get(k);

          if (
            precedente &&
            (
              precedente.lat !== geo.lat ||
              precedente.lon !== geo.lon
            )
          ) {
            conflitto = true;
          }

          verifica.set(k, {
            nome,
            lat: geo.lat,
            lon: geo.lon
          });
        }

        if (conflitto) {

          escluseGeografia.push({
            id: String(row.id),
            passeggeri: row.passeggeri,
            motivo: 'CONFLITTO_COORDINATE'
          });

          continue;
        }

        for (const [nome, geo] of punti) {

          const k = key(nome);

          if (!registrate.has(k)) {
            registrate.set(k, {
              nome,
              lat: geo.lat,
              lon: geo.lon
            });
          }
        }

        if (origine.indicativo || destinazione.indicativo) {
          indicative.add(String(row.id));
        }

        utilizzabili.push(row);
      }

      const diagnosticaGeografia =
        geografia.diagnostica();

      guard.interrompi('NCC_FASE_GEOGRAFICA_COMPLETATA');

      verificaAttiva();

      // Il deadline Routing parte dopo la geografia.

      const routing = (
        dipendenze.creaRouting ?? creaRoutingNcc
      )({
        signal: sessione.signal,
        verificaAttiva,
        autorizzaRouting: sessione.autorizzaRouting,
        autorizzazioneRigorosa: true,
        richiediAutorizzazione: true
      });

      for (const punto of registrate.values()) {

        verificaAttiva();

        routing.registraCoordinate(
          punto.nome,
          punto
        );
      }

      for (const v of veicoli) {

        verificaAttiva();

        const nome =
          '__BASE_NCC__' + v.lat + ',' + v.lon;

        const precedente = registrate.get(key(nome));

        // NCC_BASE_REGISTRATION_V26
        // Identificativo riservato alle basi.
        // La registrazione effettiva compete
        // esclusivamente all'ottimizzatore.

        if (precedente) {
          throw new Error('NCC_CONFLITTO_BASE');
        }
      }

      const aggregazione = await protetto(
        () => aggregaPrenotazioniNcc(
          veicoli.length ? utilizzabili : [],
          routing,
          veicoli,
          parametri,
          riferimento,
          {
            verificaAttiva,

            // NCC_ORCHESTRATORE_TEMPORALE_V27
            finestreTemporali:
              dipendenze.schedulazioneTemporale === true
          }
        )
      );

      if (!veicoli.length) {

        aggregazione.nonAssegnate =
          utilizzabili.map(row => ({
            id: String(row.id),
            motivo: 'NESSUN_VEICOLO_IDONEO'
          }));
      }

      for (const proposta of aggregazione.proposte) {

        verificaAttiva();

        proposta.prenotazioniIndicative =
          proposta.prenotazioni.filter(
            id => indicative.has(String(id))
          );

        proposta.geografiaIndicativa =
          proposta.prenotazioniIndicative.length > 0;

        proposta.approvabile = false;
      }

      const pianoOriginale = await protetto(
        () => ottimizzaMissioniNcc(
          aggregazione.proposte,
          veicoli,
          routing,
          parametri,
          occupati,
          {
            verificaAttiva,
            prefetch: false,
            schedulazioneTemporale:
              dipendenze.schedulazioneTemporale === true,

            // NCC_ORCHESTRATORE_V273
            reinserimentoDinamico:
              dipendenze.schedulazioneTemporale === true &&
              dipendenze.reinserimentoDinamico === true,

            // NCC_ORCHESTRATORE_V280
            aggregazioneAdattiva:
              dipendenze.schedulazioneTemporale === true &&
              dipendenze.aggregazioneAdattiva === true
          }
        )
      );


      // NCC_ORCHESTRATORE_V286G3

      let piano = pianoOriginale;

      let diagnosticaIbrida = null;

      if (
        dipendenze.cpsatAdattivo === true &&
        dipendenze.schedulazioneTemporale === true &&
        dipendenze.aggregazioneAdattiva === true
      ) {

        verificaAttiva();

        const esitoIbrido = await protetto(
          () => ottimizzaIbridoNcc({

            abilitato: true,

            pianoOriginale,
            aggregazione,

            prenotazioni: utilizzabili,

            veicoli,
            routing,
            parametri,
            riferimento,
            giorno,

            prenotazioniIndicative:
              [...indicative],

            signal: sessione.signal,

            verificaAttiva
          })
        );

        verificaAttiva();

        piano = esitoIbrido.piano;

        diagnosticaIbrida =
          esitoIbrido.diagnostica;
      }

      const idsInput = new Set(
        rows.map(row => String(row.id))
      );

      if (idsInput.size !== rows.length) {
        throw new Error('NCC_INPUT_DUPLICATO');
      }

      const idsAggregati = new Set();

      for (const proposta of aggregazione.proposte) {

        for (const id of proposta.prenotazioni) {

          const k = String(id);

          if (!idsInput.has(k) || idsAggregati.has(k)) {
            throw new Error('NCC_AGGREGAZIONE_NON_UNIVOCA');
          }

          idsAggregati.add(k);
        }
      }

      const idsPianificati = new Set();

      for (const missione of piano.missioni) {

        verificaAttiva();

        missione.approvabile = false;

        for (const gruppo of missione.gruppi) {

          for (const id of gruppo.prenotazioni) {

            const k = String(id);

            if (
              !idsAggregati.has(k) ||
              idsPianificati.has(k)
            ) {
              throw new Error('NCC_MISSIONI_NON_UNIVOCHE');
            }

            idsPianificati.add(k);
          }
        }
      }

      const esclusioni = new Map();

      for (const e of [
        ...escluseGeografia,
        ...aggregazione.nonAssegnate
      ]) {

        const k = String(e.id);

        if (
          !idsInput.has(k) ||
          idsAggregati.has(k) ||
          esclusioni.has(k)
        ) {
          throw new Error('NCC_ESCLUSIONI_INCOERENTI');
        }

        esclusioni.set(k, { ...e, id: k });
      }

      for (const id of idsInput) {

        if (idsPianificati.has(id)) continue;

        if (esclusioni.has(id)) continue;

        if (!idsAggregati.has(id)) {
          throw new Error('NCC_PRENOTAZIONE_DISPERSA');
        }

        esclusioni.set(id, {
          id,
          motivo: 'MISSIONE_NON_COMPATIBILE'
        });
      }

      if (
        idsPianificati.size + esclusioni.size !==
        idsInput.size
      ) {
        throw new Error('NCC_AUDIT_CONTEGGI_FALLITO');
      }

      verificaAttiva();

      const diagnosticaRouting =
        routing.diagnostica();

      if (diagnosticaRouting.interrotta) {
        throw new Error('NCC_ROUTING_INTERROTTO');
      }

      return {

        motore: 'V2',
        versioneOrchestratore: '2.6',
        modalita: 'simulazione',
        approvabile: false,

        giorno,
        parametri,

        totalePrenotazioni: rows.length,
        totalePasseggeri: totalePasseggeri(rows),

        veicoli,
        veicoliEsclusi,

        proposte: aggregazione.proposte,

        missioni: piano.missioni,

        ottimizzazione: piano.ottimizzazione,

        nonAssegnate: [...esclusioni.values()],

        riepilogo: {

          prenotazioniTotali: rows.length,

          prenotazioniAggregate:
            idsAggregati.size,

          prenotazioniPianificate:
            idsPianificati.size,

          prenotazioniNonAssegnate:
            esclusioni.size,

          prenotazioniEscluseGeografia:
            escluseGeografia.length,

          prenotazioniIndicative:
            indicative.size,

          missioni: piano.missioni.length
        },

        riepilogoAggregazione:
          aggregazione.riepilogo,

        riepilogoMissioni:
          piano.riepilogo,

        ...(piano.diagnosticaAdattiva
          ? {
              diagnosticaAdattiva:
                piano.diagnosticaAdattiva
            }
          : {}),

        ...(diagnosticaIbrida
          ? { diagnosticaIbrida }
          : {}),

        geografia: {
          utilizzabili: utilizzabili.length,
          escluse: escluseGeografia.length,
          dettaglioEscluse: escluseGeografia,
          diagnostica: diagnosticaGeografia
        },

        routing: diagnosticaRouting,

        audit: {
          univocitaPrenotazioni: true,
          conteggiCoerenti: true,
          bagagliVerificati: false,
          disponibilitaOrariaVerificata: false,
          disponibilitaConducentiVerificata: false
        }
      };
    }
  );

  if (!esito.consentito) {

    const errore = invalid(
      'Pianificatore temporaneamente non disponibile.',
      429
    );

    errore.code = esito.motivo;

    throw errore;
  }

  return {
    ...esito.risultato,
    simulazioneId: esito.simulazioneId,
    sessione: esito.sessione
  };
}
