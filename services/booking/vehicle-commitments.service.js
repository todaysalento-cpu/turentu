/**
 * TURENTU - Vehicle Commitments - STEP 4.37.35
 * Lettura centralizzata degli impegni NCC, POPBUS e A/R.
 * NCC: ciclo operativo persistito quando disponibile; fallback storico
 * agli orari passeggeri per le corse precedenti (solo compatibilita' commerciale).
 * Per l'assegnazione dei conducenti il ciclo completo e' obbligatorio
 * e deve essere validato separatamente dal servizio assegnazioni.
 * Le concatenazioni con ciclo NCC esteso restano non verificabili
 * senza coordinate operative affidabili.
 * Non modifica il database. Il lock richiede una transazione del chiamante.
 *
 * Politica conservativa: POPBUS mantiene l'intervallo busyStart/busyEnd
 * fino all'adozione coordinata della continuita' operativa nel worker
 * e nell'acceptance. Le coordinate POPBUS si riferiscono invece al
 * percorso passeggeri: NON sono gli estremi del ciclo busy.
 */
import { calcolaTrasferimentoVeicolo } from './vehicle-routing.service.js';

function validId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('VEHICLE_ID_INVALID');
  return id;
}
function validDate(value) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function validCoord(lat, lon) {
  if (lat == null || lon == null) return null;
  const a = Number(lat), b = Number(lon);
  return Number.isFinite(a) && Number.isFinite(b) && a >= -90 && a <= 90 && b >= -180 && b <= 180
    ? { lat: a, lon: b } : null;
}
function exclusions(options) {
  return new Set((options.escludi ?? []).map(x => `${x.fonte}:${String(x.id)}`));
}
function isExcluded(item, excluded) {
  return excluded.has(`${item.fonte}:${String(item.riferimento_id)}`);
}
function getInterval(item) {
  const start = validDate(item.inizio), end = validDate(item.fine);
  return start && end && start < end ? { start, end } : null;
}
function missionInterval(missione) {
  const start = validDate(missione?.inizio), end = validDate(missione?.fine);
  if (!start || !end || start >= end) throw new Error('VEHICLE_MISSION_INVALID');
  return { start, end };
}

export async function caricaImpegniVeicolo(client, veicoloId) {
  const id = validId(veicoloId);
  const { rows } = await client.query(`
    SELECT 'NCC' AS fonte, c.id AS riferimento_id, c.veicolo_id, c.stato,
     COALESCE(
  c.inizio_ciclo_operativo,
  c.start_datetime
) AS inizio,
COALESCE(
  c.fine_ciclo_operativo,
  c.arrivo_datetime,
  c.start_datetime + c.durata
) AS fine,
      ST_Y(c.origine::geometry) AS origine_lat,
      ST_X(c.origine::geometry) AS origine_lon,
      ST_Y(c.destinazione::geometry) AS destinazione_lat,
      ST_X(c.destinazione::geometry) AS destinazione_lon,
      c.start_datetime AS inizio_missione,
      COALESCE(c.arrivo_datetime, c.start_datetime + c.durata) AS fine_missione
    FROM corse c
    WHERE c.veicolo_id = $1 AND c.stato IN ('prenotabile','da_attivare','in_corso')

    UNION ALL

    SELECT 'POPBUS' AS fonte, a.id AS riferimento_id, a.veicolo_id, a.stato,
      COALESCE(NULLIF(a.piano->>'busyStart','')::timestamptz, a.partenza) AS inizio,
      COALESCE(NULLIF(a.piano->>'busyEnd','')::timestamptz, a.arrivo) AS fine,
      NULL::double precision AS origine_lat,
      NULL::double precision AS origine_lon,
      NULL::double precision AS destinazione_lat,
      NULL::double precision AS destinazione_lon,
      a.partenza AS inizio_missione,
      a.arrivo AS fine_missione
    FROM popbus_attivazioni a
    WHERE a.veicolo_id = $1 AND a.stato IN ('in_attesa_autista','confermata')

    UNION ALL

    SELECT 'AR_PROVVISORIA' AS fonte, aa.id AS riferimento_id, aa.veicolo_id, aa.stato,
      p.start_datetime AS inizio, p.start_datetime + p.durata AS fine,
      ST_Y(p.origine::geometry) AS origine_lat,
      ST_X(p.origine::geometry) AS origine_lon,
      ST_Y(p.destinazione::geometry) AS destinazione_lat,
      ST_X(p.destinazione::geometry) AS destinazione_lon,
      NULL::timestamptz AS inizio_missione,
      NULL::timestamptz AS fine_missione
    FROM ar_accettazioni aa
    JOIN pending p ON p.id = aa.pending_id
    WHERE aa.veicolo_id = $1 AND aa.stato = 'provvisoria' AND aa.expires_at > NOW()
    ORDER BY inizio NULLS FIRST
  `, [id]);
  return rows;
}

/** Conserva il controllo sugli intervalli riservati, incluso busy POPBUS. */
export async function verificaSovrapposizioniVeicolo(client, veicoloId, inizio, fine, options = {}) {
  const { start, end } = missionInterval({ inizio, fine });
  const impegni = await caricaImpegniVeicolo(client, veicoloId);
  const excluded = exclusions(options);
  const conflitti = [], nonVerificabili = [];
  for (const impegno of impegni) {
    if (isExcluded(impegno, excluded)) continue;
    const interval = getInterval(impegno);
    if (!interval) { nonVerificabili.push(impegno); continue; }
    if (interval.start < end && interval.end > start) conflitti.push(impegno);
  }
  return { disponibile: !conflitti.length && !nonVerificabili.length,
    conflitti, nonVerificabili, impegniEsaminati: impegni.length };
}

/**
 * STEP 4.37.35: verifica sovrapposizioni su tutti gli impegni;
 * routing solo con il predecessore e il successore immediati.
 * Se la sequenza preesistente presenta sovrapposizioni, non si puo'
 * dimostrare che bastino i soli vicini: fail closed.
 * POPBUS resta non concatenabile in questo step (fail closed).
 */
export async function verificaTrasferimentiVeicolo(client, veicoloId, missione, options = {}) {
  const { start, end } = missionInterval(missione);
  const origine = validCoord(missione?.origine?.lat, missione?.origine?.lon ?? missione?.origine?.lng);
  const destinazione = validCoord(missione?.destinazione?.lat, missione?.destinazione?.lon ?? missione?.destinazione?.lng);
  if (!origine || !destinazione) throw new Error('VEHICLE_MISSION_INVALID');
  const impegni = await caricaImpegniVeicolo(client, veicoloId);
  const excluded = exclusions(options);
  const movement = options.movement ?? calcolaTrasferimentoVeicolo;
  const conflitti = [], nonVerificabili = [];
  const precedenti = [], successivi = [];
  const validi = [];

  for (const impegno of impegni) {
    if (isExcluded(impegno, excluded)) continue;
    const interval = getInterval(impegno);
    if (!interval) {
      nonVerificabili.push({ impegno, motivo: 'INTERVALLO_NON_VALIDO' });
      continue;
    }
    const { start: a, end: b } = interval;
    validi.push({ impegno, start: a, end: b });
    if (a < end && b > start) {
      conflitti.push({ impegno, motivo: 'SOVRAPPOSIZIONE' });
      continue;
    }
    if (impegno.fonte === 'POPBUS') {
      nonVerificabili.push({ impegno, motivo: 'POPBUS_ESTREMI_BUSY_NON_VERIFICATI' });
      continue;
    }
    // Gli estremi geografici NCC rappresentano il servizio passeggeri,
    // non gli estremi del ciclo riservato (base -> cliente -> base).
    // Senza coordinate del ciclo completo non e' sicuro calcolare il
    // trasferimento dai punti passeggeri: rifiuta la concatenazione.
    if (impegno.fonte === 'NCC') {
      const servizio = {
        start: validDate(impegno.inizio_missione),
        end: validDate(impegno.fine_missione)
      };
      if (!servizio.start || !servizio.end ||
          servizio.start.getTime() !== a.getTime() ||
          servizio.end.getTime() !== b.getTime()) {
        nonVerificabili.push({ impegno, motivo: 'NCC_ESTREMI_CICLO_NON_VERIFICATI' });
        continue;
      }
    }
    const o = validCoord(impegno.origine_lat, impegno.origine_lon);
    const d = validCoord(impegno.destinazione_lat, impegno.destinazione_lon);
    if (!o || !d) {
      nonVerificabili.push({ impegno, motivo: 'COORDINATE_MANCANTI' });
      continue;
    }
    if (b <= start) precedenti.push({ impegno, end: b, punto: d });
    else if (a >= end) successivi.push({ impegno, start: a, punto: o });
  }

  // Non si possono dedurre vicini affidabili da una sequenza gia'
  // sovrapposta. Evita di autorizzare nuove missioni in tale situazione.
  validi.sort((x, y) => x.start - y.start || x.end - y.end);
  for (let i = 1; i < validi.length; i++) {
    if (validi[i].start < validi[i - 1].end) {
      nonVerificabili.push({
        impegno: validi[i].impegno,
        motivo: 'SEQUENZA_ESISTENTE_SOVRAPPOSTA'
      });
    }
  }

  if (conflitti.length || nonVerificabili.length) {
    return { compatibile: false, conflitti, nonVerificabili,
      impegniEsaminati: impegni.length };
  }

  precedenti.sort((x, y) => y.end - x.end);
  successivi.sort((x, y) => x.start - y.start);
  const vicini = [];
  if (precedenti.length) vicini.push({
    ...precedenti[0], da: precedenti[0].punto, aPunto: origine,
    disponibileMs: start - precedenti[0].end
  });
  if (successivi.length) vicini.push({
    ...successivi[0], da: destinazione, aPunto: successivi[0].punto,
    disponibileMs: successivi[0].start - end
  });

  for (const vicino of vicini) {
    try {
      const percorso = await movement(vicino.da, vicino.aPunto, options.routing ?? {});
      if (!Number.isFinite(percorso?.seconds) || percorso.seconds < 0)
        throw Object.assign(new Error('Routing non verificabile'), { code: 'VEHICLE_TRANSFER_UNVERIFIED' });
      const necessarioMs = percorso.seconds * 1000;
      if (necessarioMs > vicino.disponibileMs) conflitti.push({
        impegno: vicino.impegno,
        motivo: 'TRASFERIMENTO_IMPOSSIBILE',
        minutiNecessari: necessarioMs / 60000,
        minutiDisponibili: vicino.disponibileMs / 60000
      });
    } catch (error) {
      nonVerificabili.push({ impegno: vicino.impegno, motivo: error?.code ?? 'ROUTING_ERROR' });
    }
  }
  return { compatibile: !conflitti.length && !nonVerificabili.length,
    conflitti, nonVerificabili, impegniEsaminati: impegni.length };
}

/** Richiede BEGIN del chiamante; lock mantenuto fino a COMMIT/ROLLBACK. */
export async function bloccaVeicoloPerAssegnazione(client, veicoloId) {
  const id = validId(veicoloId);
  const { rows } = await client.query('SELECT id FROM veicolo WHERE id = $1 FOR UPDATE', [id]);
  if (rows.length !== 1) throw new Error('VEHICLE_NOT_FOUND');
  return id;
}
