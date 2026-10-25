// services/pixel/pixel-stop-validation-pipeline.service.js
// PIXEL V4.2 - pipeline diagnostica READ ONLY, con riserva candidati in output.
// Google Places discovery -> selezione comunale -> validazione V2 -> Google road access.
// NON registra, non ammette, non attiva e non rende prenotabili fermate.
// Non usa OSM/HYBRID. Il routing NON certifica sosta, sicurezza o carico/scarico.

import { pool } from '../../db/db.js';
import { discoverPixelComuneCandidates } from './pixel-stop-selection-comune.service.js';
import { validatePixelStopCandidates } from './pixel-stop-validation.service.js';
import { checkPixelStopRoadAccess } from './pixel-stop-road-access.service.js';

function codiceComune(value) {
  if (!/^\d{6}$/.test(String(value))) throw new Error('PIXEL V4.2: codice ISTAT comunale non valido');
  return String(value);
}

function limiteRichieste(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new Error('PIXEL V4.2: maxRoadChecks deve essere un intero fra 0 e 100');
  }
  return value;
}

/**
 * Esegue la pipeline senza scritture. Opzioni:
 * - database: pool/client PostgreSQL (default pool)
 * - roadAccess: funzione iniettabile (default checkPixelStopRoadAccess)
 * - maxRoadChecks: tetto alle chiamate di routing (default 20, 0 = nessuna)
 * - roadOptions: opzioni per il servizio Google Road Access
 * - radiusMeters: raggio della discovery e della validazione (default 3000)
 *
 * ATTENZIONE: la discovery Google e il routing possono avere costi API.
 */
export async function runPixelStopValidationPipeline(codiceIstat, options = {}) {
  const comune = codiceComune(codiceIstat);
  const database = options.database ?? pool;
  const roadAccess = options.roadAccess ?? checkPixelStopRoadAccess;
  const maxRoadChecks = limiteRichieste(options.maxRoadChecks ?? 20);
  const radiusMeters = options.radiusMeters ?? 3000;
  const distanzaMinimaMetri = options.distanzaMinimaMetri ?? 500;
  if (typeof roadAccess !== 'function') throw new Error('PIXEL V4.2: roadAccess non valido');
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 50000) {
    throw new Error('PIXEL V4.2: radiusMeters non valido');
  }

  const { rows } = await database.query(`
    SELECT id,
           ST_Y(posizione::geometry) AS lat,
           ST_X(posizione::geometry) AS lon
      FROM public.nodi_territoriali
     WHERE codice_istat_comune = $1 AND attivo = TRUE
     ORDER BY id
  `, [comune]);
  const centri = rows.map(r => ({ id: String(r.id), lat: Number(r.lat), lon: Number(r.lon) }));
  if (!centri.length) throw new Error(`PIXEL V4.2: nessun nodo attivo per il comune ${comune}`);
  if (centri.some(c => !Number.isFinite(c.lat) || !Number.isFinite(c.lon))) {
    throw new Error('PIXEL V4.2: coordinate dei nodi territoriali non valide');
  }

  // La selezione comunale gestisce gia' budget e deduplicazione rispetto al catalogo.
  // Source GOOGLE esplicito: il ramo legacy HYBRID non viene utilizzato.
  const discovery = await discoverPixelComuneCandidates(comune, {
    source: 'GOOGLE',
    radiusMeters,
    ...(options.discoveryOptions ?? {}),
    distanzaMinimaMetri,
    database,
    source: 'GOOGLE', // forza GOOGLE anche se discoveryOptions contiene source
  });

  const valutazione = validatePixelStopCandidates(discovery.selezionati ?? [], {
    centri,
    raggioMetri: radiusMeters,
  });

  let chiamateRoad = 0;
  const risultati = [];
  for (const candidato of valutazione.risultati) {
    let accesso = {
      stato: 'non_valutato',
      raggiungibile: null,
      motivo: candidato.stato === 'scartata' ? 'candidato_scartato' : 'limite_chiamate',
      distanza_m: null,
      durata_s: null,
    };
    if (candidato.stato !== 'scartata' && candidato.nodo_id !== null && chiamateRoad < maxRoadChecks) {
      const centro = centri.find(n => n.id === String(candidato.nodo_id));
      if (centro) {
        chiamateRoad += 1;
        try {
          accesso = await roadAccess(centro, candidato, options.roadOptions ?? {});
          if (!accesso || !['raggiungibile', 'non_raggiungibile', 'non_valutabile'].includes(accesso.stato)) {
            accesso = { stato: 'non_valutabile', raggiungibile: null, motivo: 'risposta_road_non_valida', distanza_m: null, durata_s: null };
          }
        } catch (error) {
          accesso = { stato: 'non_valutabile', raggiungibile: null, motivo: 'errore_road_service', distanza_m: null, durata_s: null };
        }
      } else {
        accesso.motivo = 'centro_non_trovato';
      }
    }

    // Qualificazione esclusivamente tecnica. Il routing non certifica l'uso NCC.
    const statoPipeline = candidato.stato === 'scartata' ? 'scartata'
      : accesso.stato === 'non_raggiungibile' ? 'scartata_per_routing'
      : accesso.stato === 'raggiungibile' ? 'qualificata_tecnicamente'
      : 'da_approfondire';

    risultati.push({
      ...candidato,
      accesso_stradale: accesso,
      stato_pipeline: statoPipeline,
      verifica_ncc: 'non_eseguita',
      prenotabile: false,
      idoneita_legale_certificata: false,
    });
  }

  return {
    comune,
    modalita: 'sola_lettura',
    fonte_discovery: 'GOOGLE',
    stato_discovery: discovery.stato,
    budget: { limite: discovery.limite, censite: discovery.censite, residue: discovery.residue },
    centri,
    candidati_selezionati: risultati.length,
    candidati_distinti: discovery.candidati_distinti ?? risultati.length,
    distanza_minima_m: discovery.distanza_minima_m ?? distanzaMinimaMetri,
    // Riserva non persiste nel DB: il chiamante deve salvarla se vuole conservarla tra esecuzioni.
    riserva: discovery.riserva ?? [],
    totale_riserva: discovery.totale_riserva ?? 0,
    esclusi_vicinanza: discovery.esclusi_vicinanza ?? [],
    riconciliazioni_non_operative: discovery.riconciliazioni_non_operative ?? [],
    validazione: {
      validate_algoritmicamente: valutazione.validate_algoritmicamente,
      da_approfondire: valutazione.da_approfondire,
      scartate: valutazione.scartate,
    },
    routing: {
      chiamate: chiamateRoad,
      raggiungibili: risultati.filter(r => r.accesso_stradale.stato === 'raggiungibile').length,
      non_raggiungibili: risultati.filter(r => r.accesso_stradale.stato === 'non_raggiungibile').length,
      non_valutabili: risultati.filter(r => r.accesso_stradale.stato === 'non_valutabile').length,
      non_valutati: risultati.filter(r => r.accesso_stradale.stato === 'non_valutato').length,
    },
    qualificati_tecnicamente: risultati.filter(r => r.stato_pipeline === 'qualificata_tecnicamente').length,
    qualificati_geograficamente: risultati.filter(r => r.stato_pipeline === 'qualificata_tecnicamente').length,
    errori_discovery: discovery.errori ?? [],
    risultati,
    avvertenza: 'Verifica NCC non eseguita. La riserva e restituita in memoria, non salvata nel database. Nessuna fermata e stata attivata.',
  };
}
