
import { verificaPagamento } from './acceptance.js';
import { pool } from '../../../db/db.js';
import { getIO } from '../../../socket.js';
import {
  generaCandidate,
  valutaRichieste,
  scegliAttivazioni
} from './model.js';
import { pianifica, leg } from './planner.js';

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function minute(t) {
  const p = fmt.formatToParts(new Date(t));
  return Number(p.find(x => x.type === 'hour').value) * 60 +
    Number(p.find(x => x.type === 'minute').value);
}

function turno(v, a, b) {
  if ((v.giorni_esclusi || []).length ||
      (v.inattivita || []).length) return false;

  if (v.manual) {
    return new Date(v.start).getTime() <= a &&
      new Date(v.fine).getTime() >= b;
  }

  const s = minute(v.start);
  const e = minute(v.fine);

  for (let t = a; t < b; t += 60000) {
    const m = minute(t);
    if (!(s < e ? m >= s && m < e :
          s > e ? m >= s || m < e : false)) return false;
  }
  return true;
}

async function movement(a, b) {
  if (
    Math.abs(Number(a.lat) - Number(b.lat)) < 1e-7 &&
    Math.abs(Number(a.lon) - Number(b.lon)) < 1e-7
  ) return { metres: 0, seconds: 0 };

  return leg(a, b);
}

function fingerprint(r) {
  return JSON.stringify([
    r.start_node_id,
    r.end_node_id,
    new Date(r.start_datetime).toISOString(),
    r.posti_richiesti,
    String(r.prezzo),
    r.classe
  ]);
}

let cicliAttivi = 0;
let numeroCiclo = 0;

export async function processaProposteDinamicheV2() {
  const ciclo = ++numeroCiclo;
  const inizio = Date.now();
  cicliAttivi++;

  const log = (fase, ...args) =>
    console.log(`[POPBUS V2 #${ciclo}] [${fase}]`, ...args);

  const stats = {
    richieste: 0,
    pagamentiScartati: 0,
    candidate: 0,
    pianiValidi: 0,
    erroriPercorso: 0,
    valutazioniScartate: 0,
    veicoliCapienza: 0,
    erroriAvvicinamento: 0,
    veicoliTurno: 0,
    veicoliCosto: 0,
    veicoliConflitto: 0,
    fattibili: 0,
    selezionate: 0,
    scartiRivalidazione: 0,
    scartiPrenotazione: 0,
    scartiVeicolo: 0,
    scartiOccupato: 0,
    attivazioni: 0
  };

  log('START',
    `PID=${process.pid} attivi=${cicliAttivi} ora=${new Date().toISOString()}`
  );

  if (cicliAttivi > 1) {
    log('ATTENZIONE',
      `Esecuzioni sovrapposte nello stesso processo: ${cicliAttivi}`
    );
  }

  let client;
  let tx = false;
  const events = [];

  try {
    const tConn = Date.now();
    client = await pool.connect();

    log('DB',
      `Connessione ottenuta in ${Date.now() - tConn} ms`
    );

    await client.query('BEGIN');
    tx = true;

    const tLock1 = Date.now();
    await client.query(
      'SELECT pg_advisory_xact_lock(734021,1)'
    );

    log('LOCK',
      `Lock iniziale ottenuto in ${Date.now() - tLock1} ms`
    );

    const { rows: expired } = await client.query(`
      UPDATE popbus_attivazioni
      SET stato='scaduta'
      WHERE stato='in_attesa_autista'
        AND expires_at<=NOW()
      RETURNING id
    `);

    log('SCADENZE',
      `Attivazioni scadute: ${expired.length}`
    );

    for (const a of expired) {
      await client.query(
        `UPDATE popbus_attivazione_richieste
         SET attiva=false
         WHERE attivazione_id=$1`,
        [a.id]
      );

      await client.query(
        `UPDATE offerte_autisti
         SET stato='scaduta'
         WHERE attivazione_id=$1 AND stato='inviata'`,
        [a.id]
      );

      await client.query(
        `UPDATE richieste_pop_bus r
         SET stato='in_attesa'
         FROM popbus_attivazione_richieste ar
         WHERE ar.attivazione_id=$1
           AND ar.richiesta_id=r.id
           AND r.stato='in_lavorazione'
           AND r.corsa_id IS NULL`,
        [a.id]
      );
    }

    await client.query('COMMIT');
    tx = false;
    log('DB', 'Pulizia scadenze completata');

    // Routing fuori transazione.
    // Snapshot rivalidato prima della riserva.

    const { rows: rawRequests } = await client.query(`
      SELECT r.*
      FROM richieste_pop_bus r
      WHERE r.stato='in_attesa'
        AND r.start_datetime>NOW()
        AND r.corsa_id IS NULL
        AND NOT EXISTS(
          SELECT 1
          FROM popbus_attivazione_richieste ar
          WHERE ar.richiesta_id=r.id
            AND ar.attiva
        )
      ORDER BY r.start_datetime,r.id
      LIMIT 201
    `);

    stats.richieste = rawRequests.length;
    log('RICHIESTE', `Trovate: ${rawRequests.length}`);

    if (rawRequests.length > 200) {
      throw new Error(
        'Più di 200 richieste: suddividere per area e data prima del lancio'
      );
    }

    const requests = [];

    for (const r of rawRequests) {
      try {
        await verificaPagamento(client, r);
        requests.push(r);
      } catch (e) {
        stats.pagamentiScartati++;
        log('PAGAMENTO',
          `Richiesta ${r.id} scartata: ${e.message}`
        );
      }
    }

    log('PAGAMENTI',
      `Valide: ${requests.length}; scartate: ${stats.pagamentiScartati}`
    );

    if (!requests.length) {
      log('STOP', 'Nessuna richiesta valida');
      return;
    }

    const nodeIds = [
      ...new Set(
        requests.flatMap(r => [
          r.start_node_id,
          r.end_node_id
        ])
      )
    ];

    const { rows: nodes } = await client.query(`
      SELECT
        id,
        nome_nodo,
        ST_Y(posizione::geometry) AS lat,
        ST_X(posizione::geometry) AS lon
      FROM nodi_direttrice
      WHERE id=ANY($1::int[])
    `, [nodeIds]);

    const nodeMap = new Map(
      nodes.map(n => [Number(n.id), n])
    );

    const { rows: vehicles } = await client.query(`
      SELECT
        v.id,
        v.driver_id,
        v.posti_totali,
        t.euro_km,
        dv.start,
        dv.fine,
        dv.manual,
        dv.giorni_esclusi,
        dv.inattivita,
        ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,
        ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon
      FROM veicolo v
      JOIN disponibilita_veicolo dv
        ON dv.veicolo_id=v.id
      JOIN LATERAL(
        SELECT MIN(euro_km) AS euro_km
        FROM tariffe
        WHERE veicolo_id=v.id
          AND tipo='standard'
          AND euro_km>0
      ) t ON t.euro_km IS NOT NULL
      WHERE v.driver_id IS NOT NULL
        AND v.posti_totali>0
        AND COALESCE(dv.coord,v.coord) IS NOT NULL
      ORDER BY t.euro_km,v.id
    `);

    log('RISORSE',
      `Nodi: ${nodes.length}/${nodeIds.length}; veicoli: ${vehicles.length}`
    );

    const feasible = [];
    const plans = [];

    for (const c of generaCandidate(requests)) {
      stats.candidate++;

      log('CANDIDATA',
        `#${stats.candidate} classe=${c.classe} seeds=${JSON.stringify(c.seeds)}`
      );

      let plan;

      try {
        plan = await pianifica(c, nodes);
      } catch (e) {
        stats.erroriPercorso++;
        log('ROUTE ERROR', e.message);
        continue;
      }

      const evaluation = valutaRichieste(
        plan,
        requests.filter(
          r => (r.classe || 'STANDARD') === c.classe
        ),
        c.seeds
      );

      if (
        !evaluation ||
        evaluation.departure <= Date.now()
      ) {
        stats.valutazioniScartate++;
        log('VALUTAZIONE',
          'Assente o partenza già passata'
        );
        continue;
      }

      stats.pianiValidi++;

      log('PIANO',
        `nodi=${plan.nodes.join('>')} peak=${evaluation.peak} ricavo=${evaluation.revenue} partenza=${new Date(evaluation.departure).toISOString()}`
      );

      plans.push({ plan, evaluation });

      for (const vehicle of vehicles) {
        if (
          Number(vehicle.posti_totali) <
          evaluation.peak
        ) {
          stats.veicoliCapienza++;
          continue;
        }

        let approach;
        let returnTrip;

        try {
          approach = await movement(
            vehicle,
            nodeMap.get(plan.nodes[0])
          );

          returnTrip = await movement(
            nodeMap.get(plan.nodes.at(-1)),
            vehicle
          );
        } catch (e) {
          stats.erroriAvvicinamento++;
          log('MOVIMENTO ERROR',
            `veicolo=${vehicle.id}: ${e.message}`
          );
          continue;
        }

        const busyStart =
          evaluation.departure -
          approach.seconds * 1000;

        const busyEnd =
          evaluation.arrival +
          returnTrip.seconds * 1000;

        // =====================================================
        // DIAGNOSTICA DISPONIBILITÀ VEICOLO
        // =====================================================

        const adesso = Date.now();

        const partenzaImpossibile = busyStart <= adesso;

        const turnoValido = partenzaImpossibile
          ? null
          : turno(vehicle, busyStart, busyEnd);

        if (partenzaImpossibile || !turnoValido) {
          stats.veicoliTurno++;

          const motivi = [];

          if (partenzaImpossibile) {
            motivi.push('AVVICINAMENTO NON COMPLETABILE IN TEMPO');
          }

          if (turnoValido === false) {
            motivi.push('TURNO NON COMPATIBILE');
          }

          if ((vehicle.giorni_esclusi || []).length > 0) {
            motivi.push('GIORNI ESCLUSI PRESENTI');
          }

          if ((vehicle.inattivita || []).length > 0) {
            motivi.push('PERIODI INATTIVITA PRESENTI');
          }

          log('SCARTO TURNO', {
            candidata: stats.candidate,
            classe: c.classe,
            seeds: c.seeds,
            percorso: plan.nodes.join('>'),

            veicolo: vehicle.id,
            autista: vehicle.driver_id,
            postiDisponibili: vehicle.posti_totali,
            postiRichiesti: evaluation.peak,

            manual: vehicle.manual,
            turnoStart: vehicle.start,
            turnoFine: vehicle.fine,
            giorniEsclusi: vehicle.giorni_esclusi,
            inattivita: vehicle.inattivita,

            partenzaRichiesta:
              new Date(evaluation.departure).toISOString(),

            busyStart:
              new Date(busyStart).toISOString(),

            busyEnd:
              new Date(busyEnd).toISOString(),

            avvicinamentoMinuti:
              Math.round(approach.seconds / 60),

            ritornoMinuti:
              Math.round(returnTrip.seconds / 60),

            partenzaImpossibile,
            turnoValido:
              turnoValido === null ? 'NON VALUTATO' : turnoValido,

            motivi
          });

          continue;
        }

        // =====================================================
        // COSTO OPERATIVO COMPLETO
        // AVVICINAMENTO + PERCORSO + RITORNO
        // =====================================================

        const metriPercorso = plan.legs.reduce(
          (sum, l) => sum + l.metres, 0
        );

        const metriAvvicinamento = approach.metres;
        const metriRitorno = returnTrip.metres;

        const metriTotali =
          metriPercorso + metriAvvicinamento + metriRitorno;

        const tariffaEuroKm = Number(vehicle.euro_km);

        // Formula originale invariata.
        const cost = Math.ceil(
          metriTotali / 1000 * tariffaEuroKm * 100
        ) / 100;

        const ricavo = Number(evaluation.revenue);

        const arrotonda = (n, cifre = 2) =>
          Number(Number(n).toFixed(cifre));

        const km = m =>
          arrotonda(Number(m) / 1000, 3);

        const euro = m =>
          arrotonda(Number(m) / 1000 * tariffaEuroKm);

        // =====================================================
        // NUOVO LOG DIAGNOSTICO COSTI
        // =====================================================

        log('COSTO DETTAGLIO', {
          candidata: stats.candidate,
          classe: c.classe,
          seeds: c.seeds,
          percorso: plan.nodes.join('>'),

          veicolo: vehicle.id,
          autista: vehicle.driver_id,

          origineVeicolo: {
            lat: Number(vehicle.lat),
            lon: Number(vehicle.lon)
          },

          nodoPartenza: nodeMap.get(plan.nodes[0]),
          nodoArrivo: nodeMap.get(plan.nodes.at(-1)),

          avvicinamento: {
            km: km(metriAvvicinamento),
            minuti: arrotonda(approach.seconds / 60, 1),
            costoEuroNonArrotondato: euro(metriAvvicinamento)
          },

          percorsoCommerciale: {
            km: km(metriPercorso),
            minuti: arrotonda(
              plan.legs.reduce(
                (sum, l) => sum + l.seconds, 0
              ) / 60,
              1
            ),
            costoEuroNonArrotondato: euro(metriPercorso)
          },

          ritornoAllaBase: {
            km: km(metriRitorno),
            minuti: arrotonda(returnTrip.seconds / 60, 1),
            costoEuroNonArrotondato: euro(metriRitorno)
          },

          kmTotali: km(metriTotali),
          tariffaEuroKm,

          ricavoEuro: ricavo,
          costoTotaleEuro: cost,
          margineEuro: arrotonda(ricavo - cost),

          coperturaCostoPercentuale:
            cost > 0
              ? arrotonda(ricavo / cost * 100, 1)
              : null,

          sogliaSuperata: ricavo >= cost,

          busyStart: new Date(busyStart).toISOString(),
          busyEnd: new Date(busyEnd).toISOString()
        });

        if (evaluation.revenue < cost) {
          stats.veicoliCosto++;

          log('SCARTO COSTO',
            `candidata=${stats.candidate} ` +
            `seeds=${JSON.stringify(c.seeds)} ` +
            `veicolo=${vehicle.id} ` +
            `ricavo=${ricavo} ` +
            `costo=${cost} ` +
            `differenza=${arrotonda(ricavo - cost)} ` +
            `(inclusi avvicinamento, percorso e ritorno)`
          );

          continue;
        }

        // =====================================================
        // CONTROLLO CONFLITTI
        // =====================================================

        const { rows: conflicts } = await client.query(`
          SELECT 1
          FROM popbus_attivazioni a
          WHERE
            (a.veicolo_id=$1 OR a.autista_id=$2)
            AND a.stato IN (
              'in_attesa_autista','confermata'
            )
            AND (a.piano->>'busyStart')::timestamptz
                < $4::timestamptz
            AND (a.piano->>'busyEnd')::timestamptz
                > $3::timestamptz

          UNION ALL

          SELECT 1
          FROM corse c
          JOIN veicolo v ON v.id=c.veicolo_id
          WHERE
            (v.id=$1 OR v.driver_id=$2)
            AND c.stato IN (
              'prenotabile','in_corso','da_attivare'
            )
         AND c.start_datetime < $4::timestamptz
AND (
  c.arrivo_datetime IS NULL
  OR c.arrivo_datetime > $3::timestamptz
)

          UNION ALL

          SELECT 1
          FROM direttrici_virtuali d
          JOIN veicolo v ON v.id=d.veicolo_id
          WHERE
            (v.id=$1 OR v.driver_id=$2)
            AND d.stato IN (
              'in_attesa_autista','attivo','confermata'
            )
        `, [
          vehicle.id,
          vehicle.driver_id,
          new Date(busyStart),
          new Date(busyEnd)
        ]);

       if (conflicts.length) {

  log('SCARTO CONFLITTO DETTAGLIO', {
    candidata: stats.candidate,
    classe: c.classe,
    seeds: c.seeds,
    percorso: plan.nodes.join('>'),

    veicolo: vehicle.id,
    autista: vehicle.driver_id,

    postiVeicolo: Number(vehicle.posti_totali),
    postiRichiesti: evaluation.peak,

    ricavoEuro: Number(evaluation.revenue),
    costoEuro: cost,

    busyStart: new Date(busyStart).toISOString(),
    busyEnd: new Date(busyEnd).toISOString(),

    numeroConflitti: conflicts.length,

    conflitti: conflicts.map((conflict, index) => ({
      numero: index + 1,
      ...conflict
    }))
  });

  stats.veicoliConflitto++;
  continue;
}

        feasible.push({
          plan,
          evaluation,
          vehicle,
          cost,
          approach,
          returnTrip,
          busyStart,
          busyEnd
        });

        stats.fattibili++;

        log('FATTIBILE',
          `veicolo=${vehicle.id} costo=${cost} ricavo=${evaluation.revenue}`
        );
      }
    }

    log('MATCHING', JSON.stringify(stats));

    const chosen = scegliAttivazioni(feasible);
    stats.selezionate = chosen.length;

    log('SCELTA',
      `Selezionate: ${chosen.length}`
    );

    if (!chosen.length) {
      log('STOP', 'Nessuna attivazione selezionata');
      return;
    }

    // =====================================================
    // RIVALIDAZIONE E ATTIVAZIONE
    // =====================================================

    await client.query('BEGIN');
    tx = true;

    const tLock2 = Date.now();

    await client.query(
      'SELECT pg_advisory_xact_lock(734021,1)'
    );

    log('LOCK',
      `Lock finale ottenuto in ${Date.now() - tLock2} ms`
    );

    for (const c of chosen) {
      const ids = c.evaluation.requests.map(r => r.id);

      const { rows: locked } = await client.query(`
        SELECT *
        FROM richieste_pop_bus
        WHERE id=ANY($1::int[])
        ORDER BY id
        FOR UPDATE
      `, [ids]);

      if (
        locked.length !== ids.length ||
        locked.some(
          r =>
            r.stato !== 'in_attesa' ||
            r.corsa_id != null ||
            fingerprint(r) !== fingerprint(
              requests.find(x => x.id === r.id)
            )
        )
      ) {
        stats.scartiRivalidazione++;
        log('RIVALIDAZIONE',
          `Richieste modificate: ${ids.join(',')}`
        );
        continue;
      }

      const { rows: reservations } = await client.query(`
        SELECT 1
        FROM popbus_attivazione_richieste
        WHERE richiesta_id=ANY($1::int[])
          AND attiva
      `, [ids]);

      if (reservations.length) {
        stats.scartiPrenotazione++;
        log('RISERVAZIONE',
          `Richieste già riservate: ${ids.join(',')}`
        );
        continue;
      }

      await client.query(
        'SELECT id FROM utente WHERE id=$1 FOR UPDATE',
        [c.vehicle.driver_id]
      );

      const { rows: stillFree } = await client.query(`
        SELECT id
        FROM veicolo
        WHERE id=$1
          AND driver_id=$2
          AND posti_totali >= $3
        FOR UPDATE
      `, [
        c.vehicle.id,
        c.vehicle.driver_id,
        c.evaluation.peak
      ]);

      if (!stillFree.length) {
        stats.scartiVeicolo++;
        log('VEICOLO',
          `Non più disponibile: ${c.vehicle.id}`
        );
        continue;
      }

      const { rows: busy } = await client.query(`
        SELECT 1
        FROM popbus_attivazioni
        WHERE
          (veicolo_id=$1 OR autista_id=$2)
          AND stato IN (
            'in_attesa_autista','confermata'
          )
          AND (piano->>'busyStart')::timestamptz
              < $4::timestamptz
          AND (piano->>'busyEnd')::timestamptz
              > $3::timestamptz
      `, [
        c.vehicle.id,
        c.vehicle.driver_id,
        new Date(c.busyStart),
        new Date(c.busyEnd)
      ]);

      if (busy.length) {
        stats.scartiOccupato++;
        log('CONFLITTO',
          `Veicolo/autista occupato: ${c.vehicle.id}`
        );
        continue;
      }

      // Contenitore: percorso più ampio
      // che include la candidata senza riordino.
      const containers = plans.filter(
        p =>
          p.plan.classe === c.plan.classe &&
          c.plan.nodes.every((n, i) => {
            const start = p.plan.nodes.indexOf(
              c.plan.nodes[0]
            );
            return start >= 0 &&
              p.plan.nodes[start + i] === n;
          })
      ).sort(
        (a, b) =>
          b.plan.nodes.length - a.plan.nodes.length
      );

      const container = containers[0] || c;

      const prefix = container.plan.nodes.indexOf(
        c.plan.nodes[0]
      );

      const dirDeparture =
        c.evaluation.departure -
        container.plan.legs.slice(0, prefix).reduce(
          (s, l) => s + l.seconds * 1000, 0
        );

      const { rows: dirs } = await client.query(`
        INSERT INTO direttrici_virtuali(
          stato,
          partenza_prevista,
          start_node_id,
          end_node_id,
          tipo_servizio
        )
        VALUES (
          'in_formazione',$1,$2,$3,$4
        )
        ON CONFLICT(
          start_node_id,
          end_node_id,
          partenza_prevista
        )
        DO NOTHING
        RETURNING id
      `, [
        new Date(dirDeparture),
        container.plan.nodes[0],
        container.plan.nodes.at(-1),
        `${c.plan.classe}_V2`
      ]);

      let dirId = dirs[0]?.id;

      if (!dirId) {
        const { rows: d } = await client.query(`
          SELECT id
          FROM direttrici_virtuali
          WHERE start_node_id=$1
            AND end_node_id=$2
            AND partenza_prevista=$3
            AND tipo_servizio=$4
          FOR UPDATE
        `, [
          container.plan.nodes[0],
          container.plan.nodes.at(-1),
          new Date(dirDeparture),
          `${c.plan.classe}_V2`
        ]);

        dirId = d[0]?.id;
      }

      if (!dirId) {
        throw new Error(
          'Collisione con direttrice legacy: nessuna sovrascrittura'
        );
      }

      const { rows: existingSegments } = await client.query(`
        SELECT *
        FROM segmenti
        WHERE direttrice_id=$1
        ORDER BY ordine_sequenziale
      `, [dirId]);

      const segs = [];
      let t = dirDeparture;

      if (
        existingSegments.length &&
        (
          existingSegments.length !==
            container.plan.legs.length ||
          existingSegments.some(
            (s, i) =>
              Number(s.start_node_id) !==
                container.plan.nodes[i] ||
              Number(s.end_node_id) !==
                container.plan.nodes[i + 1]
          )
        )
      ) {
        throw new Error(
          'Versione percorso diversa: segmenti esistenti preservati'
        );
      }

      for (let i = 0; i < container.plan.legs.length; i++) {
        if (existingSegments.length) {
          segs.push(existingSegments[i]);
        } else {
          const { rows: s } = await client.query(`
            INSERT INTO segmenti(
              direttrice_id,
              start_node_id,
              end_node_id,
              ordine_sequenziale,
              tempo_stimato,
              start_datetime,
              stato
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,'in_attesa'
            )
            RETURNING id
          `, [
            dirId,
            container.plan.nodes[i],
            container.plan.nodes[i + 1],
            i + 1,
            Math.ceil(
              container.plan.legs[i].seconds / 60
            ),
            new Date(t)
          ]);

          segs.push(s[0]);
        }

        t += container.plan.legs[i].seconds * 1000;
      }

      const piano = {
        ...c.plan,
        requestSnapshot: locked.map(r => ({
          id: r.id,
          fingerprint: fingerprint(r)
        })),
        coordinates: c.plan.nodes.map(
          n => nodeMap.get(n)
        ),
        evaluation: c.evaluation,
        approach: c.approach,
        returnTrip: c.returnTrip,
        busyStart: new Date(c.busyStart).toISOString(),
        busyEnd: new Date(c.busyEnd).toISOString()
      };

      const { rows: as } = await client.query(`
        INSERT INTO popbus_attivazioni(
          direttrice_id,
          veicolo_id,
          autista_id,
          stato,
          partenza,
          arrivo,
          costo,
          ricavo,
          tariffa,
          piano,
          expires_at
        )
        VALUES(
          $1,$2,$3,'in_attesa_autista',
          $4,$5,$6,$7,$8,$9::jsonb,
          LEAST(
            NOW()+INTERVAL '10 minutes',
            $10::timestamptz
          )
        )
        RETURNING id,expires_at
      `, [
        dirId,
        c.vehicle.id,
        c.vehicle.driver_id,
        new Date(c.evaluation.departure),
        new Date(c.evaluation.arrival),
        c.cost,
        c.evaluation.revenue,
        c.vehicle.euro_km,
        JSON.stringify(piano),
        new Date(c.busyStart)
      ]);

      const act = as[0];
      stats.attivazioni++;

      log('ATTIVAZIONE',
        `id=${act.id} direttrice=${dirId} veicolo=${c.vehicle.id} richieste=${ids.join(',')} scadenza=${act.expires_at}`
      );

      for (const r of c.evaluation.requests) {
        await client.query(`
          INSERT INTO popbus_attivazione_richieste(
            attivazione_id,
            richiesta_id,
            indice_salita,
            indice_discesa
          )
          VALUES($1,$2,$3,$4)
        `, [
          act.id,
          r.id,
          r.start,
          r.end
        ]);
      }

      for (let i = 0; i < c.plan.legs.length; i++) {
        await client.query(`
          INSERT INTO popbus_attivazione_segmenti(
            attivazione_id,
            segmento_id,
            ordine
          )
          VALUES($1,$2,$3)
        `, [
          act.id,
          segs[prefix + i].id,
          i + 1
        ]);
      }

      await client.query(`
        UPDATE richieste_pop_bus
        SET stato='in_lavorazione',
            direttrice_id=$2
        WHERE id=ANY($1::int[])
      `, [ids, dirId]);

      const { rows: offers } = await client.query(`
        INSERT INTO offerte_autisti(
          direttrice_id,
          autista_id,
          attivazione_id,
          stato,
          expires_at
        )
        VALUES($1,$2,$3,'inviata',$4)
        RETURNING id
      `, [
        dirId,
        c.vehicle.driver_id,
        act.id,
        act.expires_at
      ]);

      events.push({
        driver: c.vehicle.driver_id,
        payload: {
          id: offers[0].id,
          attivazione_id: act.id,
          direttrice_id: dirId,
          veicolo_id: c.vehicle.id,
          classe: c.plan.classe,
          posti_richiesti: c.evaluation.peak,
          oraPartenza: new Date(
            c.evaluation.departure
          ).toISOString(),
          start_node_id: c.plan.nodes[0],
          end_node_id: c.plan.nodes.at(-1)
        }
      });
    }

    await client.query('COMMIT');
    tx = false;

    log('COMMIT',
      `Attivazioni create: ${stats.attivazioni}; eventi socket: ${events.length}`
    );

    for (const e of events) {
      try {
        getIO()
          .to(`autista_${e.driver}`)
          .emit('nuova_proposta_popbus', e.payload);
      } catch (err) {
        console.error(
          '[V2 SOCKET POSTCOMMIT]',
          err.message
        );
      }
    }

  } catch (err) {
    log('ERRORE', err.stack || err.message);

    if (tx && client) {
      try {
        await client.query('ROLLBACK');
        log('ROLLBACK', 'Eseguito');
      } catch (e) {
        log('ROLLBACK ERROR', e.message);
      }
    }

    throw err;

  } finally {
    if (client) client.release();

    cicliAttivi--;

    log('FINE',
      `durata=${Date.now() - inizio} ms attivi=${cicliAttivi} riepilogo=${JSON.stringify(stats)}`
    );
  }
}
