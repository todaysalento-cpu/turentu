import { adattaMissioneFermate }
  from './popbus-stop-mission-adapter.service.js';

import { verificaCompatibilitaTemporaleFermate }
  from './popbus-stop-temporal.service.js';

import { verificaQualitaFermate }
  from './popbus-stop-quality.service.js';

import { validaFermateFisicheTransazionali }
  from './popbus-physical-stop-lock.js';

import { verificaDisponibilitaCicloFisico }
  from './popbus-physical-operational-preflight.js';

import { valutaEconomiaCiclo } from './cycle-pricing.js';

const fail = message => {
  throw new Error(`POPBUS_PHYSICAL_WRITER_V2: ${message}`);
};

// Valida il contratto economico del routing gia' calcolato dal selettore.
// Non effettua una nuova chiamata al provider stradale: LIVE resta disabilitato.
function movimentoFisico(movimento, nome, richiesto = true) {
  if (!richiesto && movimento == null) return {metres: 0, seconds: 0};
  if (!movimento || typeof movimento !== 'object' ||
      !Number.isFinite(Number(movimento.metres)) ||
      !Number.isFinite(Number(movimento.seconds)) ||
      Number(movimento.metres) < 0 || Number(movimento.seconds) < 0) {
    fail(`routing ${nome} assente o non valido`);
  }
  return {metres: Number(movimento.metres), seconds: Number(movimento.seconds)};
}

function numeroConfigurazione(valore, nome) {
  if (valore == null || valore === '' ||
      !Number.isFinite(Number(valore)) || Number(valore) < 0) {
    fail(`configurazione economica non valida: ${nome}`);
  }
  return Number(valore);
}

export function rivalidaEconomiaCicloFisicoV2({
  ciclo, richiesteBloccate, euroKm,
  costoAttesaOraEuro = 0, altriCostiEuro = 0, margineMinimoEuro = 0
} = {}) {
  if (!ciclo || !Array.isArray(ciclo.missioni) ||
      ciclo.missioni.length < 1 || ciclo.missioni.length > 2 ||
      !Array.isArray(richiesteBloccate) || !richiesteBloccate.length) {
    fail('input rivalidazione economica incompleto');
  }
  if (!Number.isFinite(Number(euroKm)) || Number(euroKm) <= 0) {
    fail('tariffa NCC standard non valida');
  }
  const routing = ciclo.routingFisico;
  if (!routing || typeof routing !== 'object') {
    fail('contratto routing fisico V2 mancante');
  }
  const approach = movimentoFisico(routing.approach, 'avvicinamento');
  const returnTrip = movimentoFisico(routing.returnTrip, 'ritorno base');
  const transfer = movimentoFisico(routing.transfer, 'trasferimento',
    ciclo.missioni.length === 2);
  if (ciclo.missioni.length === 1 && routing.transfer != null) {
    fail('trasferimento inatteso nel ciclo singolo');
  }
  const missioni = ciclo.missioni;
  let metriMissioni = 0;
  for (const missione of missioni) {
    if (!Array.isArray(missione.plan?.legs) || !missione.plan.legs.length) {
      fail('segmenti missione mancanti');
    }
    let metri = 0;
    for (const leg of missione.plan.legs) {
      if (!leg || !Number.isFinite(Number(leg.metres)) ||
          Number(leg.metres) < 0 || !Number.isFinite(Number(leg.seconds)) ||
          Number(leg.seconds) < 0) {
        fail('segmento economico missione non valido');
      }
      metri += Number(leg.metres);
    }
    if (!Number.isFinite(metri) ||
        !Number.isFinite(Number(missione.kmMissione)) ||
        Math.abs(metri / 1000 - Number(missione.kmMissione)) > 1e-6) {
      fail('kmMissione discordante dai segmenti fisici');
    }
    metriMissioni += metri;
  }
  const first = missioni[0];
  const last = missioni[missioni.length - 1];
  const start = Number(ciclo.partenzaBase);
  const end = Number(ciclo.ritornoBase);
  if (![start, end, first.departure, last.arrival].every(Number.isFinite) ||
      Math.abs(start + approach.seconds * 1000 - Number(first.departure)) > 1000 ||
      Math.abs(Number(last.arrival) + returnTrip.seconds * 1000 - end) > 1000) {
    fail('orari di avvicinamento o ritorno incoerenti');
  }
  let oreAttesa = 0;
  if (missioni.length === 2) {
    const gapMs = Number(missioni[1].departure) - Number(missioni[0].arrival);
    if (!Number.isFinite(gapMs) || gapMs < 0 ||
        gapMs + 1000 < transfer.seconds * 1000) {
      fail('trasferimento incompatibile con gli orari delle missioni');
    }
    oreAttesa = Math.max(0, gapMs - transfer.seconds * 1000) / 3600000;
  }
  if (!Number.isFinite(Number(routing.waitingHours)) ||
      Math.abs(Number(routing.waitingHours) - oreAttesa) > 1 / 3600) {
    fail('attesa fisica discordante');
  }
  const economia = valutaEconomiaCiclo({
    ricaviRichiesteEuro: richiesteBloccate.map(r => Number(r.prezzo)),
    kmAvvicinamento: approach.metres / 1000,
    kmMissioni: metriMissioni / 1000,
    kmTrasferimenti: transfer.metres / 1000,
    kmRitornoBase: returnTrip.metres / 1000,
    euroKm: Number(euroKm),
    oreAttesa,
    costoAttesaOraEuro: numeroConfigurazione(costoAttesaOraEuro, 'costoAttesaOraEuro'),
    altriCostiEuro: numeroConfigurazione(altriCostiEuro, 'altriCostiEuro'),
    margineMinimoEuro: numeroConfigurazione(margineMinimoEuro, 'margineMinimoEuro')
  });
  if (economia.economicamenteAttivabile !== true) {
    fail(`ciclo economicamente insufficiente: margine ${economia.margineEuro} EUR, soglia ${economia.margineMinimoEuro} EUR`);
  }
  return economia;
}

export async function verificaCicloFisicoTransazionale({
  pool,
  ciclo,
  mode = 'ROLLBACK_ONLY',
  costoAttesaOraEuro = process.env.POPBUS_PIXEL_COSTO_ATTESA_ORA_EURO ?? 0,
  altriCostiEuro = process.env.POPBUS_PIXEL_ALTRI_COSTI_EURO ?? 0,
  margineMinimoEuro = process.env.POPBUS_PIXEL_MARGINE_MINIMO_EURO ?? 0
} = {}) {
  if (mode !== 'ROLLBACK_ONLY') fail('LIVE non abilitato');
  if (!pool || typeof pool.connect !== 'function') {
    fail('pool PostgreSQL mancante');
  }
  if (!ciclo || !Array.isArray(ciclo.missioni) ||
      ciclo.missioni.length < 1 || ciclo.missioni.length > 2) {
    fail('ciclo fisico non valido');
  }

  const vehicleId = Number(ciclo.vehicleId);
  if (!Number.isSafeInteger(vehicleId) || vehicleId <= 0 ||
      ciclo.missioni.some(m => Number(m.vehicleId) !== vehicleId)) {
    fail('veicolo del ciclo non valido o discordante');
  }

  const ids = ciclo.missioni.flatMap(m => {
    if (m?.schemaVersion !== 2 ||
        m?.tipoItinerario !== 'FERMATE_FISICHE' ||
        !Array.isArray(m.evaluation?.requests) ||
        !m.evaluation.requests.length) {
      fail('contratto missione fisica V2 incompleto');
    }
    return m.evaluation.requests.map(r => Number(r.id));
  }).sort((a, b) => a - b);

  if (!ids.length ||
      ids.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(ids).size !== ids.length) {
    fail('identificativi richieste invalidi o duplicati');
  }

  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '90s'");

    // Stesso advisory lock del percorso PIXEL esistente.
    await client.query('SELECT pg_advisory_xact_lock(734021,1)');

    const { rows: reserved } = await client.query(
      `SELECT richiesta_id
       FROM popbus_attivazione_richieste
       WHERE richiesta_id = ANY($1::integer[])
         AND attiva = TRUE
       LIMIT 1`,
      [ids]
    );
    if (reserved.length) fail('richiesta gia riservata');

    const { rows: vehicles } = await client.query(
      `SELECT id, driver_id, posti_totali
       FROM veicolo
       WHERE id = $1
       FOR UPDATE`,
      [vehicleId]
    );
    const vehicle = vehicles[0];
    if (!vehicle ||
        !Number.isSafeInteger(Number(vehicle.driver_id)) ||
        Number(vehicle.driver_id) <= 0 ||
        !Number.isSafeInteger(Number(vehicle.posti_totali)) ||
        Number(vehicle.posti_totali) <= 0) {
      fail('veicolo o titolare non valido');
    }

    // Rivalidazione della disponibilita' operativa sotto transazione.
    // Si bloccano le righe esistenti per evitare modifiche concorrenti
    // alla configurazione del turno durante questo preflight.
    const { rows: disponibilitaRows } = await client.query(
      `SELECT
         dv.veicolo_id,
         dv.start,
         dv.fine,
         dv.giorni_esclusi,
         dv.inattivita,
         ST_Y(COALESCE(dv.coord, v.coord)::geometry) AS lat,
         ST_X(COALESCE(dv.coord, v.coord)::geometry) AS lon
       FROM disponibilita_veicolo dv
       JOIN veicolo v ON v.id = dv.veicolo_id
       WHERE dv.veicolo_id = $1
         AND COALESCE(dv.coord, v.coord) IS NOT NULL
       ORDER BY dv.start, dv.fine
       FOR UPDATE OF dv`,
      [vehicleId]
    );

    const busyStart = Number(ciclo.partenzaBase);
    const busyEnd = Number(ciclo.ritornoBase);
    if (!Number.isFinite(busyStart) || !Number.isFinite(busyEnd) ||
        busyEnd <= busyStart) {
      fail('intervallo operativo del ciclo non valido');
    }

    const baseOperativa = ciclo.baseOperativa;
    if (!baseOperativa ||
        !Number.isFinite(Number(baseOperativa.lat)) ||
        !Number.isFinite(Number(baseOperativa.lon)) ||
        Math.abs(Number(baseOperativa.lat)) > 90 ||
        Math.abs(Number(baseOperativa.lon)) > 180) {
      fail('base operativa del ciclo assente o non valida');
    }

    const disponibilita = disponibilitaRows.map(row => ({
      ...row,
      lat: Number(row.lat),
      lon: Number(row.lon)
    }));

    if (!verificaDisponibilitaCicloFisico({
      disponibilita,
      baseOperativa: {
        lat: Number(baseOperativa.lat),
        lon: Number(baseOperativa.lon)
      },
      busyStart,
      busyEnd
    })) {
      fail('veicolo non disponibile per l’intero ciclo operativo o base discordante');
    }

    // Verifica gli impegni gia' presenti sullo stesso veicolo per tutto
    // l'intervallo base-partenza -> rientro-base. Il controllo viene eseguito
    // dopo l'advisory lock condiviso con il percorso PIXEL.
    const { rows: conflitti } = await client.query(
      `SELECT 1 AS found
       FROM popbus_attivazioni a
       WHERE a.veicolo_id = $1
         AND a.stato IN ('in_attesa_autista', 'confermata')
         AND COALESCE((a.piano->>'busyStart')::timestamptz, a.partenza) < $3
         AND COALESCE((a.piano->>'busyEnd')::timestamptz, a.arrivo) > $2
       UNION ALL
       SELECT 1 AS found
       FROM corse c
       WHERE c.veicolo_id = $1
         AND c.stato IN ('prenotabile', 'in_corso', 'da_attivare')
         AND c.start_datetime < $3
         AND (c.arrivo_datetime IS NULL OR c.arrivo_datetime > $2)
       LIMIT 1`,
      [vehicleId, new Date(busyStart), new Date(busyEnd)]
    );
    if (conflitti.length) {
      fail('conflitto con un altro impegno del veicolo nell’intero ciclo operativo');
    }

    const operativita = {
      ok: true,
      busyStart,
      busyEnd,
      disponibilitaVerificate: disponibilita.length,
      conflitti: 0
    };

    const { rows: locked } = await client.query(
      `SELECT *
       FROM richieste_pop_bus
       WHERE id = ANY($1::integer[])
       ORDER BY id
       FOR UPDATE`,
      [ids]
    );
    if (locked.length !== ids.length) {
      fail('richieste non trovate');
    }

    for (const r of locked) {
      if (r.stato !== 'in_attesa' ||
          r.corsa_id != null ||
          !Number.isSafeInteger(Number(r.cliente_id)) ||
          Number(r.cliente_id) <= 0 ||
          !Number.isSafeInteger(Number(r.posti_richiesti)) ||
          Number(r.posti_richiesti) <= 0 ||
          r.prezzo == null ||
          !Number.isFinite(Number(r.prezzo)) ||
          Number(r.prezzo) < 0 ||
          !r.payment_intent_id ||
          !Number.isFinite(new Date(r.start_datetime).getTime())) {
        fail(`richiesta non prenotabile: ${r.id}`);
      }
    }

    // Le richieste A/R vincolate devono essere presenti entrambe.
    for (const r of locked.filter(x => x.ar_vincolata === true)) {
      if (!r.ar_group_id) fail('A/R senza gruppo');
      const group = locked.filter(
        x => String(x.ar_group_id) === String(r.ar_group_id)
      );
      if (group.length !== 2 ||
          !group.some(x => x.ar_tratta === 'andata') ||
          !group.some(x => x.ar_tratta === 'ritorno')) {
        fail('A/R incompleta nel ciclo');
      }
    }

    const fermate = await validaFermateFisicheTransazionali({
      client,
      missioni: ciclo.missioni
    });
    if (fermate.ok !== true) {
      fail('rivalidazione fermate fallita');
    }

    const rivalidazione = rivalidaMissioniFisicheV2({
      ciclo,
      richiesteBloccate: locked
    });
    if (rivalidazione.ok !== true) {
      fail('rivalidazione operativa fallita');
    }

    // La tariffa e' riletta nel medesimo snapshot transazionale delle richieste.
    // Il lock sul veicolo e il lock della riga tariffaria sono gia' attivi.
    const { rows: tariffe } = await client.query(
      `SELECT euro_km FROM tariffe
       WHERE veicolo_id = $1 AND tipo = 'standard' AND euro_km > 0
       ORDER BY euro_km LIMIT 1 FOR SHARE`,
      [vehicleId]
    );
    if (!tariffe.length) fail('tariffa NCC standard assente');
    const economia = rivalidaEconomiaCicloFisicoV2({
      ciclo,
      richiesteBloccate: locked,
      euroKm: Number(tariffe[0].euro_km),
      costoAttesaOraEuro,
      altriCostiEuro,
      margineMinimoEuro
    });

    await client.query('ROLLBACK');
    transactionOpen = false;

    return {
      ok: true,
      percorso: 'POPBUS_PHYSICAL_V2_TRANSACTION_PREFLIGHT',
      fermate,
      rivalidazione,
      operativita,
      economia,
      veicoloId: vehicleId,
      numeroMissioni: ciclo.missioni.length,
      numeroRichieste: ids.length,
      dbWrites: 0,
      persistita: false,
      attivabile: false
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export function rivalidaMissioniFisicheV2({ ciclo, richiesteBloccate } = {}) {
  if (!ciclo || !Array.isArray(ciclo.missioni) ||
      ciclo.missioni.length < 1 || ciclo.missioni.length > 2) {
    fail('ciclo fisico non valido');
  }
  if (!Array.isArray(richiesteBloccate) || !richiesteBloccate.length) {
    fail('richieste bloccate assenti');
  }

  const byId = new Map();
  for (const richiesta of richiesteBloccate) {
    const id = Number(richiesta?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || byId.has(id)) {
      fail('richiesta duplicata o non valida');
    }
    byId.set(id, richiesta);
  }

  const utilizzate = new Set();
  const risultati = [];

  for (const missione of ciclo.missioni) {
    if (missione?.schemaVersion !== 2 ||
        missione?.tipoItinerario !== 'FERMATE_FISICHE') {
      fail('contratto missione V2 non valido');
    }
    const alternativa = missione.validazioneFisica;
    const itinerario = alternativa?.itinerario;
    if (!itinerario?.ok || itinerario.routingVerificato !== true ||
        !Array.isArray(itinerario.visite) ||
        !Array.isArray(itinerario.legs) ||
        !Array.isArray(missione.plan?.nodes) ||
        !Array.isArray(missione.plan?.legs)) {
      fail('itinerario fisico certificato assente');
    }
    if (alternativa?.sequenza?.ok !== true) {
      fail('sequenza fisica non validata');
    }

    const refs = missione.evaluation?.requests;
    if (!Array.isArray(refs) || !refs.length) {
      fail('richieste missione assenti');
    }
    const richieste = refs.map(ref => {
      const id = Number(ref?.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        fail('id richiesta missione non valido');
      }
      if (utilizzate.has(id)) fail(`richiesta duplicata nel ciclo: ${id}`);
      const richiesta = byId.get(id);
      if (!richiesta) fail(`richiesta non bloccata: ${id}`);
      const posti = Number(richiesta.posti_richiesti);
      if (!Number.isSafeInteger(posti) || posti <= 0) {
        fail(`posti richiesta non validi: ${id}`);
      }
      utilizzate.add(id);
      return richiesta;
    });

    // Controlla eventi sulle VISITE FISICHE, non sugli indici operativi.
    const eventiPerRichiesta = new Map(refs.map(ref => [Number(ref.id), {
      salita: null, discesa: null
    }]));
    for (let i = 0; i < itinerario.visite.length; i++) {
      const visita = itinerario.visite[i];
      if (!Array.isArray(visita?.eventi) || !visita.eventi.length) {
        fail(`eventi fermata mancanti: ${i}`);
      }
      for (const evento of visita.eventi) {
        const id = Number(evento?.richiesta_id);
        const stato = eventiPerRichiesta.get(id);
        if (!stato) fail(`evento richiesta estranea: ${id}`);
        if (Number(evento.posti) !== Number(byId.get(id).posti_richiesti)) {
          fail(`posti evento discordanti: ${id}`);
        }
        if (evento.tipo !== 'salita' && evento.tipo !== 'discesa') {
          fail(`evento sconosciuto: ${id}`);
        }
        if (stato[evento.tipo] !== null) {
          fail(`evento duplicato: ${id}`);
        }
        stato[evento.tipo] = i;
      }
    }
    for (const [id, stato] of eventiPerRichiesta) {
      if (stato.salita === null || stato.discesa === null ||
          stato.salita >= stato.discesa) {
        fail(`eventi incompleti o fuori ordine: ${id}`);
      }
    }

    // Rivalida usando i dati delle richieste bloccate, non gli esiti SHADOW.
    const temporale = verificaCompatibilitaTemporaleFermate({
      itinerario, richieste
    });
    if (temporale.ok !== true) {
      fail(`compatibilita temporale fallita: ${temporale.motivo}`);
    }
    const qualita = verificaQualitaFermate({ itinerario, richieste });
    if (qualita.ok !== true) {
      fail(`qualita fermate fallita: ${qualita.motivo}`);
    }

    // L'adapter inserisce i nodi di attesa: gli indici sono OPERATIVI.
    let ricostruita;
    try {
      ricostruita = adattaMissioneFermate({
        alternativa: { ...alternativa, temporale, qualita },
        richieste,
        corridorId: missione.corridoioPixelId ?? null
      });
    } catch (error) {
      fail(`ricostruzione piano fisico fallita: ${error.message}`);
    }
    if (ricostruita.ok !== true) fail('ricostruzione piano fisico fallita');
    const piano = ricostruita.missione;
    const nodes = missione.plan.nodes;
    const legs = missione.plan.legs;
    if (nodes.length !== piano.nodes.length ||
        legs.length !== piano.legs.length ||
        nodes.length !== legs.length + 1) {
      fail('struttura piano operativo discordante');
    }
    for (let i = 0; i < nodes.length; i++) {
      if (!Number.isSafeInteger(Number(nodes[i])) ||
          Number(nodes[i]) !== Number(piano.nodes[i])) {
        fail(`fermata operativa discordante: ${i}`);
      }
    }
    for (let i = 0; i < legs.length; i++) {
      const a = legs[i];
      const b = piano.legs[i];
      if (!a || !b || !Number.isFinite(Number(a.metres)) ||
          !Number.isFinite(Number(a.seconds)) ||
          Number(a.metres) !== Number(b.metres) ||
          Number(a.seconds) !== Number(b.seconds) ||
          a.polyline !== b.polyline ||
          (a.attesa === true) !== (b.attesa === true) ||
          (a.roadCoincident === true) !== (b.roadCoincident === true)) {
        fail(`segmento operativo discordante: ${i}`);
      }
    }
    const ricostruite = new Map(piano.requests.map(r => [Number(r.id), r]));
    if (ricostruite.size !== refs.length) fail('mapping richieste incompleto');
    for (const ref of refs) {
      const id = Number(ref.id);
      const attesa = ricostruite.get(id);
      if (!attesa || !Number.isSafeInteger(Number(ref.start)) ||
          !Number.isSafeInteger(Number(ref.end)) ||
          Number(ref.start) !== attesa.start ||
          Number(ref.end) !== attesa.end ||
          (ref.posti_richiesti != null &&
           Number(ref.posti_richiesti) !== attesa.posti_richiesti)) {
        fail(`mapping operativo richiesta discordante: ${id}`);
      }
    }
    if (Number(missione.departure) !== Number(piano.departure) ||
        Number(missione.arrival) !== Number(piano.arrival)) {
      fail('orari piano operativo discordanti');
    }

    risultati.push({
      pixelOpportunitaId: missione.pixelOpportunitaId,
      richiesteIds: richieste.map(r => Number(r.id)),
      temporale, qualita,
      occorrenzeOperative: nodes.length,
      visiteFisiche: itinerario.visite.length
    });
  }
  if (utilizzate.size !== byId.size) {
    fail('richieste bloccate non interamente utilizzate');
  }
  return {
    ok: true,
    numeroMissioni: risultati.length,
    numeroRichieste: utilizzate.size,
    risultati,
    attivabile: false
  };
}
