// NCC_AGGREGAZIONE_COMPATIBILITA_V2902E2E1

import {
  restrizioniPrenotazioneNcc,
  restrizioniGruppoNcc,
  veicoliCompatibiliNcc
} from './ncc-compatibilita-veicoli.service.js';


export const NCC_V2_PARAMS = Object.freeze({
  raggioKm: 5,
  deviazioneMassima: 0.25,
  tempoAggiuntivoMinuti: 15,
  maxFermate: 6,
  multisalita: true,
  multidiscesa: true,
  serviziSingoli: true,
  stessoVolo: false,
  anticipoAeroportoMinuti: 90,
  durataFermataMinuti: 2
});

// NCC_AGGREGAZIONE_SESSION_V26
const MIN = 60000;

const key = value =>
  String(value).trim().replace(/\s+/g, ' ').toLowerCase();

function validRoute(route) {
  return route &&
    Number.isFinite(route.distanzaKm) &&
    Number.isFinite(route.durataMs) &&
    route.distanzaKm >= 0 &&
    route.durataMs >= 0;
}

export async function verificaItinerarioNcc(
  rows,
  routing,
  capienza,
  parametri = {},
  riferimento = Date.now(),
  opzioni = {}
) {
  const verificaAttiva =
    opzioni.verificaAttiva ?? (() => {});

  verificaAttiva();
  const p = {
    ...NCC_V2_PARAMS,
    tolleranzaMinuti: 20,
    ...parametri
  };

  if (!rows.length || !Number.isFinite(capienza)) {
    return null;
  }

  const prenotazioni = rows.map(row => {
    const pickup = Date.parse(row.prelievo_il);

    const flight = Date.parse(
      row.volo_programmato_il
    );

    let earliest = Math.max(
      riferimento,
      pickup - p.tolleranzaMinuti * MIN
    );

    const latest =
      pickup + p.tolleranzaMinuti * MIN;

    let deadline = Infinity;

    if (row.volo_direzione === 'partenza') {
      if (!Number.isFinite(flight)) return null;

      deadline =
        flight - p.anticipoAeroportoMinuti * MIN;
    }

    if (row.volo_direzione === 'arrivo') {
      if (!Number.isFinite(flight)) return null;

      earliest = Math.max(earliest, flight);
    }

    return {
      id: String(row.id),
      origine: row.origine,
      destinazione: row.destinazione,
      passeggeri: Number(row.passeggeri),
      earliest,
      latest,
      deadline
    };
  });

  if (prenotazioni.some(r =>
    !r ||
    !Number.isFinite(r.earliest) ||
    !Number.isFinite(r.latest) ||
    r.earliest > r.latest ||
    !Number.isInteger(r.passeggeri) ||
    r.passeggeri < 1 ||
    r.passeggeri > capienza
  )) return null;

  if (new Set(prenotazioni.map(r => r.id)).size
      !== prenotazioni.length) {
    return null;
  }

  const origini = new Set(
    prenotazioni.map(r => key(r.origine))
  );

  const destinazioni = new Set(
    prenotazioni.map(r => key(r.destinazione))
  );

  if (!p.multisalita && origini.size > 1) {
    return null;
  }

  if (!p.multidiscesa && destinazioni.size > 1) {
    return null;
  }

  if (!p.serviziSingoli && rows.length === 1) {
    return null;
  }

  if (p.stessoVolo && rows.length > 1) {
    const flights = rows.map(r =>
      r.volo_numero
        ? JSON.stringify([
            r.volo_numero,
            r.volo_aeroporto,
            r.volo_direzione,
            Date.parse(r.volo_programmato_il)
          ])
        : null
    );

    if (!flights[0] ||
        flights.some(f => f !== flights[0])) {
      return null;
    }
  }

  const stopsMap = new Map();

  function addStop(tipo, localita, row) {
    const id = tipo + '|' + key(localita);

    if (!stopsMap.has(id)) {
      stopsMap.set(id, {
        tipo,
        localita,
        rows: []
      });
    }

    stopsMap.get(id).rows.push(row);
  }

  for (const row of prenotazioni) {
    addStop('salita', row.origine, row);
    addStop('discesa', row.destinazione, row);
  }

  const stops = [...stopsMap.values()];

  if (stops.length > p.maxFermate) {
    return null;
  }

  const direct = new Map();

  await Promise.all(
    prenotazioni.map(async row => {
      verificaAttiva();

      const route = await routing.tratta(
        row.origine,
        row.destinazione
      );

      verificaAttiva();

      direct.set(row.id, route);
    })
  );

  verificaAttiva();

  if (prenotazioni.some(r =>
    !validRoute(direct.get(r.id))
  )) return null;

  const matrix = await Promise.all(
    stops.map(async stop => {

      verificaAttiva();

      const risultato = await routing.matrix(
        stop.localita,
        stops.map(s => s.localita)
      );

      verificaAttiva();

      return risultato;
    })
  );

  verificaAttiva();

  let best = null;

  function visit(
    order,
    itinerary,
    time,
    km,
    onboard,
    completed,
    peak
  ) {
    verificaAttiva();

    if (order.length === stops.length) {
      if (onboard.size ||
          completed.size !== rows.length) {
        return;
      }

      if (best && (
        km > best.km ||
        (km === best.km &&
          time >= best.finish)
      )) return;

      best = {
        km,
        finish: time,
        piccoPasseggeri: peak,
        arrivoPrevisto:
          new Date(time).toISOString(),
        fermate: itinerary
      };

      return;
    }

    const last = order.at(-1);

    for (let i = 0; i < stops.length; i++) {
      if (order.includes(i)) continue;

      const stop = stops[i];

      const leg = last == null
        ? { distanzaKm: 0, durataMs: 0 }
        : matrix[last][i];

      if (!validRoute(leg)) continue;

      let arrival = time + leg.durataMs;

      const nextKm = km + leg.distanzaKm;
      const nextOnboard = new Map(onboard);
      const nextCompleted = new Set(completed);

      let valid = true;

      if (stop.tipo === 'salita') {
        arrival = Math.max(
          arrival,
          ...stop.rows.map(r => r.earliest)
        );

        if (stop.rows.some(r =>
          arrival > r.latest ||
          nextOnboard.has(r.id) ||
          nextCompleted.has(r.id)
        )) continue;

        for (const row of stop.rows) {
          nextOnboard.set(row.id, {
            row,
            time: arrival +
              p.durataFermataMinuti * MIN,
            km: nextKm
          });
        }
      } else {
        for (const row of stop.rows) {
          const boarded = nextOnboard.get(row.id);

          if (!boarded) {
            valid = false;
            break;
          }

          const baseline = direct.get(row.id);
          const rideKm = nextKm - boarded.km;
          const rideMs = arrival - boarded.time;

          if (
            arrival > row.deadline ||
            rideKm >
              baseline.distanzaKm *
              (1 + p.deviazioneMassima) + 1e-6 ||
            rideMs >
              baseline.durataMs +
              p.tempoAggiuntivoMinuti * MIN
          ) {
            valid = false;
            break;
          }

          nextOnboard.delete(row.id);
          nextCompleted.add(row.id);
        }
      }

      if (!valid) continue;

      const load = [...nextOnboard.values()]
        .reduce(
          (sum, item) =>
            sum + item.row.passeggeri,
          0
        );

      if (load > capienza) continue;

      const finish = arrival +
        (stop.tipo === 'salita'
          ? p.durataFermataMinuti * MIN
          : nextCompleted.size === rows.length
            ? 0
            : p.durataFermataMinuti * MIN);

      visit(
        [...order, i],
        [...itinerary, {
          tipo: stop.tipo,
          localita: stop.localita,
          orario: new Date(arrival).toISOString(),
          prelievo: stop.tipo === 'salita'
            ? new Date(arrival).toISOString()
            : null,
          prenotazioni: stop.rows.map(r => r.id),
          passeggeriABordo: load,
          kmProgressivi: nextKm
        }],
        finish,
        nextKm,
        nextOnboard,
        nextCompleted,
        Math.max(peak, load)
      );
    }
  }

  visit(
    [],
    [],
    riferimento,
    0,
    new Map(),
    new Set(),
    0
  );

  verificaAttiva();

  if (!best) return null;


  // NCC_FINESTRE_TEMPORALI_V27

  let flessibilitaTemporale;

  if (opzioni.finestreTemporali === true) {

    verificaAttiva();

    const prenotazioniMap = new Map(
      prenotazioni.map(r => [r.id, r])
    );

    const inizioMs = Date.parse(
      best.fermate[0].orario
    );

    let margineMs = Infinity;

    for (const fermata of best.fermate) {

      verificaAttiva();

      const orario = Date.parse(fermata.orario);

      for (const id of fermata.prenotazioni) {

        verificaAttiva();

        const row = prenotazioniMap.get(String(id));

        if (!row || !Number.isFinite(orario)) {
          throw new Error(
            'NCC_FINESTRA_DATI_NON_VALIDI'
          );
        }

        if (fermata.tipo === 'salita') {
          margineMs = Math.min(
            margineMs,
            row.latest - orario
          );
        }

        if (fermata.tipo === 'discesa') {
          margineMs = Math.min(
            margineMs,
            row.deadline - orario
          );
        }
      }
    }

    if (
      !Number.isFinite(margineMs) ||
      margineMs < 0
    ) {
      throw new Error(
        'NCC_FINESTRA_TEMPORALE_NON_VALIDA'
      );
    }

    flessibilitaTemporale = {
      versione: '2.7.1',
      modalita: 'TRASLAZIONE_UNIFORME',
      inizioMinimo: new Date(
        inizioMs
      ).toISOString(),
      inizioMassimo: new Date(
        inizioMs + margineMs
      ).toISOString(),
      fineMinima: new Date(
        best.finish
      ).toISOString(),
      fineMassima: new Date(
        best.finish + margineMs
      ).toISOString(),
      durataMs: best.finish - inizioMs,
      posticipoMassimoMs: margineMs
    };
  }

  const { finish, ...result } = best;

  return {
    ...result,
    ...(flessibilitaTemporale
      ? { flessibilitaTemporale }
      : {}),
    inizio: result.fermate[0].orario,
    fine: result.arrivoPrevisto,
    bagagliVerificati: false
  };
}

export async function aggregaPrenotazioniNcc(
  rows,
  routing,
  veicoli,
  parametri = {},
  riferimento = Date.now(),
  opzioni = {}
) {
  const verificaAttiva =
    opzioni.verificaAttiva ?? (() => {});

  verificaAttiva();
  const p = {
    ...NCC_V2_PARAMS,
    tolleranzaMinuti: 20,
    obiettivoRiempimento: 75,
    ...parametri
  };

  const flotta = [...veicoli]
    .filter(v => Number(v.posti_totali) > 0)
    .sort((a, b) =>
      Number(a.posti_totali) -
      Number(b.posti_totali)
    );

  const capienza = Math.max(
    0,
    ...flotta.map(v => Number(v.posti_totali))
  );

  function flottaCompatibile(group, passeggeri = 0) {
    return veicoliCompatibiliNcc(
      flotta,
      restrizioniGruppoNcc(group),
      passeggeri
    );
  }

  function capienzaCompatibile(group) {
    return Math.max(
      0,
      ...flottaCompatibile(group).map(
        v => Number(v.posti_totali)
      )
    );
  }

  const disponibili = [...rows].sort(
    (a, b) =>
      Date.parse(a.prelievo_il) -
      Date.parse(b.prelievo_il)
  );

  const assegnate = new Set();
  const singoli = new Map();
  const proposte = [];
  const nonAssegnate = [];

  const diagnostica = {
    candidatiVerificati: 0,
    candidatiGeograficiEsclusi: 0,
    candidatiTemporaliEsclusi: 0,
    candidatiVeicoliIncompatibili: 0,
    prenotazioniVeicoliIncompatibili: 0,
    itinerariRifiutati: 0,
    gruppiAggregati: 0,
    serviziSingoli: 0
  };

  // Precalcolo dei servizi individuali.
  await Promise.all(
    disponibili.map(async row => {
      verificaAttiva();

      if (
        !flottaCompatibile(
          [row],
          Number(row.passeggeri)
        ).length
      ) {
        return;
      }

      const route = await routing.tratta(
        row.origine,
        row.destinazione
      );

      verificaAttiva();

      singoli.set(String(row.id), route);
    })
  );

  verificaAttiva();

  async function compatibile(a, b) {

    verificaAttiva();

    const delta = Math.abs(
      Date.parse(a.prelievo_il) -
      Date.parse(b.prelievo_il)
    );

    if (delta > p.tolleranzaMinuti * 2 * MIN) {
      diagnostica.candidatiTemporaliEsclusi++;
      return false;
    }

    const [origini, destinazioni] =
      await Promise.all([
        routing.vicini(
          a.origine,
          b.origine,
          p.raggioKm
        ),
        routing.vicini(
          a.destinazione,
          b.destinazione,
          p.raggioKm
        )
      ]);

    verificaAttiva();

    if (!origini || !destinazioni) {
      diagnostica.candidatiGeograficiEsclusi++;
      return false;
    }

    return true;
  }

  function kmIndividuali(group) {
    return group.reduce(
      (sum, row) =>
        sum + singoli.get(
          String(row.id)
        ).distanzaKm,
      0
    );
  }

  function creaProposta(group, itinerario) {
    const tipiVeicoloAmmessi =
      restrizioniGruppoNcc(group);

    const veicolo = flottaCompatibile(
      group,
      itinerario.piccoPasseggeri
    )[0];

    if (!veicolo) {
      throw new Error(
        'NCC_PROPOSTA_VEICOLO_INCOMPATIBILE'
      );
    }

    const kmSeparati = kmIndividuali(group);

    const ricavi = group.every(
      r => r.prezzo_centesimi != null
    )
      ? group.reduce(
          (sum, r) =>
            sum + Number(r.prezzo_centesimi),
          0
        )
      : null;

    const costoKm =
      p.costiVeicoli?.[veicolo?.id] ?? null;

    const costo = costoKm == null
      ? null
      : Math.round(
          itinerario.km * costoKm * 100
        );

    return {
      prenotazioni: group.map(
        r => String(r.id)
      ),

      passeggeri: group.reduce(
        (sum, r) =>
          sum + Number(r.passeggeri),
        0
      ),

      piccoPasseggeri:
        itinerario.piccoPasseggeri,

      origine:
        itinerario.fermate[0].localita,

      destinazione:
        itinerario.fermate.at(-1).localita,

      prelievoDal: itinerario.inizio,

      prelievoAl: itinerario.fermate
        .filter(f => f.tipo === 'salita')
        .at(-1).orario,

      inizio: itinerario.inizio,
      fine: itinerario.fine,

      volo: group.find(
        r => r.volo_numero
      )?.volo_numero ?? null,

      tipiVeicoloAmmessi,

      veicoloId: veicolo.id,
      posti: veicolo?.posti_totali ?? null,

      riempimento: veicolo
        ? Math.round(
            itinerario.piccoPasseggeri *
            100 / veicolo.posti_totali
          )
        : null,

      itinerario,

      economia: {
        km: itinerario.km,
        kmIndividuali: kmSeparati,
        kmRisparmiati:
          kmSeparati - itinerario.km,
        costoKm,
        ricaviCentesimi: ricavi,
        costoCentesimi: costo,
        margineCentesimi:
          ricavi == null || costo == null
            ? null
            : ricavi - costo
      },

      bagagliVerificati: false
    };
  }

  for (const row of disponibili) {

    verificaAttiva();

    const id = String(row.id);

    if (assegnate.has(id)) continue;

    if (Number(row.passeggeri) > capienza) {
      nonAssegnate.push({
        id,
        motivo: 'CAPIENZA_INSUFFICIENTE'
      });

      continue;
    }

    const capienzaSingola =
      capienzaCompatibile([row]);

    if (
      !flottaCompatibile(
        [row],
        Number(row.passeggeri)
      ).length
    ) {
      diagnostica.prenotazioniVeicoliIncompatibili++;

      nonAssegnate.push({
        id,
        motivo: 'NESSUN_VEICOLO_COMPATIBILE',
        tipiVeicoloAmmessi:
          restrizioniPrenotazioneNcc(row)
      });

      continue;
    }

    if (!validRoute(singoli.get(id))) {
      nonAssegnate.push({
        id,
        motivo: 'ROUTING_NON_DISPONIBILE'
      });
      continue;
    }

    let group = [row];

    let itinerario =
      await verificaItinerarioNcc(
        group,
        routing,
        capienzaSingola,
        { ...p, serviziSingoli: true },
        riferimento,
        opzioni
      );

    verificaAttiva();

    if (!itinerario) {
      nonAssegnate.push({
        id,
        motivo: 'VINCOLI_ITINERARIO'
      });
      continue;
    }

    while (true) {

      verificaAttiva();

      let best = null;

      for (const candidate of disponibili) {

        verificaAttiva();

        const cid = String(candidate.id);

        if (
          assegnate.has(cid) ||
          group.some(r => String(r.id) === cid) ||
          !validRoute(singoli.get(cid))
        ) continue;

        const next = [...group, candidate];

        const capienzaNext =
          capienzaCompatibile(next);

        if (
          capienzaNext <= 0 ||
          next.some(r =>
            Number(r.passeggeri) > capienzaNext
          )
        ) {
          diagnostica.candidatiVeicoliIncompatibili++;
          continue;
        }

        let compatible = true;

        for (const member of group) {

          verificaAttiva();

          if (!(await compatibile(
            member,
            candidate
          ))) {
            compatible = false;
            break;
          }
        }

        verificaAttiva();

        if (!compatible) continue;

        diagnostica.candidatiVerificati++;

        const result =
          await verificaItinerarioNcc(
            next,
            routing,
            capienzaNext,
            p,
            riferimento,
            opzioni
          );

        verificaAttiva();

        if (!result) {
          diagnostica.itinerariRifiutati++;
          continue;
        }

        if (
          !flottaCompatibile(
            next,
            result.piccoPasseggeri
          ).length
        ) {
          diagnostica.candidatiVeicoliIncompatibili++;
          continue;
        }

        const saving =
          itinerario.km +
          singoli.get(cid).distanzaKm -
          result.km;

        if (saving <= 0) continue;

        if (!best || saving > best.saving) {
          best = {
            group: next,
            itinerario: result,
            saving
          };
        }
      }

      if (!best) break;

      group = best.group;
      itinerario = best.itinerario;
    }

    if (group.length === 1 &&
        !p.serviziSingoli) {
      nonAssegnate.push({
        id,
        motivo: 'SERVIZIO_SINGOLO_ESCLUSO'
      });
      continue;
    }

    verificaAttiva();

    const proposta =
      creaProposta(group, itinerario);

    for (const member of group) {
      assegnate.add(String(member.id));
    }

    proposte.push(proposta);

    if (group.length > 1) {
      diagnostica.gruppiAggregati++;
    } else {
      diagnostica.serviziSingoli++;
    }
  }

  verificaAttiva();

  const residue = nonAssegnate.filter(
    r => !assegnate.has(r.id)
  );

  return {
    proposte,
    nonAssegnate: residue,

    riepilogo: {
      prenotazioniTotali: rows.length,
      prenotazioniAssegnate: assegnate.size,
      prenotazioniNonAssegnate: residue.length,

      gruppiAggregati:
        diagnostica.gruppiAggregati,

      serviziSingoli:
        diagnostica.serviziSingoli,

      kmIndividuali: proposte.reduce(
        (sum, g) =>
          sum + g.economia.kmIndividuali,
        0
      ),

      kmAggregati: proposte.reduce(
        (sum, g) =>
          sum + g.economia.km,
        0
      ),

      kmRisparmiati: proposte.reduce(
        (sum, g) =>
          sum + g.economia.kmRisparmiati,
        0
      )
    },

    diagnostica
  };
}
