// NCC_OTTIMIZZATORE_COMPATIBILITA_V2902E2E3

import {
  veicoloCompatibileNcc,
  intersecaRestrizioniNcc
} from './ncc-compatibilita-veicoli.service.js';

function restrizioniServizioNcc(gruppo) {
  return gruppo.tipiVeicoloAmmessi === undefined
    ? null
    : gruppo.tipiVeicoloAmmessi;
}

function veicoloCompatibileServizioNcc(
  veicolo,
  gruppo
) {
  return veicoloCompatibileNcc(
    veicolo,
    restrizioniServizioNcc(gruppo)
  );
}

function restrizioniMissioneNcc(gruppi) {
  if (!Array.isArray(gruppi) || !gruppi.length) {
    return [];
  }

  return intersecaRestrizioniNcc(
    ...gruppi.map(restrizioniServizioNcc)
  );
}


import {
  diagnosticaConflittiNcc
} from './ncc-aggregazione-adattiva.service.js';

import { precalcolaTratteNcc } from './ncc-routing-prefetch.service.js';

import {
  finestraServizioNcc,
  schedulaSequenzaNcc
} from './ncc-schedulazione-temporale.service.js';

// NCC_OTTIMIZZATORE_TEMPORALE_V27

// NCC_OTTIMIZZATORE_SESSION_V26
const MIN = 60000;

const giornoLocale = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Rome',
  dateStyle: 'short'
});

async function ottimizzaSingoloPiano(
  proposte,
  veicoli,
  routing,
  parametri = {},
  occupati = new Set(),
  opzioni = {}
) {
  const verificaAttiva =
    opzioni.verificaAttiva ?? (() => {});

  verificaAttiva();

  const costi = parametri.costiVeicoli ?? {};
  const maxAttesa = parametri.attesaMassimaMinuti ?? Infinity;
  const maxDurata = parametri.durataMassimaMissioneMinuti ?? Infinity;

  const missioni = [];
  const nonAssegnate = [];
  const cache = new Map();
  const basi = new Map();

  const inizio = p => Date.parse(p.inizio);
  const fine = p => Date.parse(p.fine);

  const origine = p =>
    p.itinerario?.fermate?.[0]?.localita ?? p.origine;

  const destinazione = p =>
    p.itinerario?.fermate?.at(-1)?.localita ?? p.destinazione;

  const picco = p => p.piccoPasseggeri ?? p.passeggeri;

  const costo = v => {
    const c = costi[v.id];
    return typeof c === 'number' && Number.isFinite(c) && c >= 0
      ? c
      : null;
  };

  async function tratta(a, b) {

    verificaAttiva();

    if (!a || !b) return null;

    const k = JSON.stringify([a, b]);

    if (!cache.has(k)) {
      cache.set(k, Promise.resolve()
        .then(() => {

          verificaAttiva();

          return routing.tratta(a, b);
        })
        .then(r =>
          Number.isFinite(r?.distanzaKm) &&
          Number.isFinite(r?.durataMs) &&
          r.distanzaKm >= 0 &&
          r.durataMs >= 0 ? r : null
        )
        .catch(() => {

          verificaAttiva();

          return null;
        }));
    }

    const risultato = await cache.get(k);

    verificaAttiva();

    return risultato;
  }

  for (const v of veicoli) {

    verificaAttiva();
    if (
      Number.isFinite(v.lat) &&
      Number.isFinite(v.lon) &&
      Math.abs(v.lat) <= 90 &&
      Math.abs(v.lon) <= 180 &&
      (v.lat !== 0 || v.lon !== 0)
    ) {
      const nome = `__BASE_NCC__${v.lat},${v.lon}`;

      if (!basi.has(nome)) {
        routing.registraCoordinate(nome, {
          lat: v.lat,
          lon: v.lon
        });

        basi.set(nome, true);
      }

      basi.set(String(v.id), nome);
    } else {
      basi.set(String(v.id), v.localita || null);
    }
  }

  async function valuta(v, gruppi, diagnostica = null) {

    const rifiuta = causa => {
      if (diagnostica) diagnostica( causa );
      return null;
    };

    verificaAttiva();

    if (!Array.isArray(gruppi) || !gruppi.length) {
      return rifiuta('MISSIONE_VUOTA');
    }

    const tipiVeicoloAmmessi =
      restrizioniMissioneNcc(gruppi);

    if (
      !veicoloCompatibileNcc(
        v,
        tipiVeicoloAmmessi
      )
    ) {
      return rifiuta(
        'VEICOLO_NON_COMPATIBILE'
      );
    }

    const temporale =
      opzioni.schedulazioneTemporale === true;

    const ordineTemporale = p =>
      temporale
        ? finestraServizioNcc(p)?.minimo
        : inizio(p);

    if (
      temporale &&
      gruppi.some(p => !finestraServizioNcc(p))
    ) return rifiuta('FINESTRA_TEMPORALE_INVALIDA');

    let ordinati = [...gruppi].sort(
      (a, b) =>
        ordineTemporale(a) - ordineTemporale(b)
    );

    if (temporale) {

      const trasferimenti = [];

      for (let i = 0; i < ordinati.length; i++) {

        verificaAttiva();

        if (picco(ordinati[i]) > v.posti_totali) {
          return rifiuta('CAPACITA_INSUFFICIENTE');
        }

        if (i === 0) continue;

        const t = await tratta(
          destinazione(ordinati[i - 1]),
          origine(ordinati[i])
        );

        verificaAttiva();

        if (!t) return rifiuta('TRASFERIMENTO_IMPOSSIBILE');

        trasferimenti.push(t);
      }

      const schedulazione = schedulaSequenzaNcc(
        ordinati,
        trasferimenti,
        {
          verificaAttiva,
          attesaMassimaMs: maxAttesa * MIN
        }
      );

      verificaAttiva();

      if (!schedulazione) return rifiuta('SEQUENZA_TEMPORALE');

      ordinati = schedulazione.gruppi;
    }

    const primo = ordinati[0];
    const ultimo = ordinati.at(-1);
    const base = basi.get(String(v.id));

    const giorno = giornoLocale.format(new Date(inizio(primo)));

    if (occupati.has(giorno + '/' + v.id)) {
      return rifiuta('VEICOLO_OCCUPATO');
    }

    let kmServizio = 0;
    const trasferimentiTimeline = []; // NCC_TIMELINE_V2891
    let kmTrasferimenti = 0;
    let attesaMs = 0;
    let piccoPasseggeri = 0;

    for (let i = 0; i < ordinati.length; i++) {

      verificaAttiva();

      const p = ordinati[i];

      if (
        giornoLocale.format(new Date(inizio(p))) !== giorno ||
        giornoLocale.format(new Date(fine(p))) !== giorno
      ) return rifiuta('CAMBIO_GIORNO');

      if (picco(p) > v.posti_totali) {
        return rifiuta('CAPACITA_INSUFFICIENTE');
      }

      piccoPasseggeri = Math.max(piccoPasseggeri, picco(p));
      kmServizio += p.economia.km;

      if (i === 0) continue;

      const precedente = ordinati[i - 1];
      const intervallo = inizio(p) - fine(precedente);

      if (intervallo < 0) return rifiuta('SEQUENZA_TEMPORALE');

      const trasferimento = await tratta(
        destinazione(precedente),
        origine(p)
      );

      verificaAttiva();

      if (!trasferimento) return rifiuta('TRASFERIMENTO_IMPOSSIBILE');

      const attesa = intervallo - trasferimento.durataMs;

      if (attesa < 0 || attesa > maxAttesa * MIN) {
        return rifiuta('ATTESA_ECCESSIVA');
      }

      kmTrasferimenti += trasferimento.distanzaKm;
      attesaMs += attesa;
      trasferimentiTimeline.push({ dopoServizio: i - 1, km: trasferimento.distanzaKm, durataMs: trasferimento.durataMs, attesaMs: attesa });
    }

    const [andata, ritorno] = await Promise.all([
      tratta(base, origine(primo)),
      tratta(destinazione(ultimo), base)
    ]);

    verificaAttiva();

    if (!andata) return rifiuta('POSIZIONAMENTO_BASE');
    if (!ritorno) return rifiuta('RIENTRO_BASE');

    const partenzaBase = inizio(primo) - andata.durataMs;
    const arrivoBase = fine(ultimo) + ritorno.durataMs;
    const durataMs = arrivoBase - partenzaBase;

    if (durataMs > maxDurata * MIN) {
      return rifiuta('DURATA_ECCESSIVA');
    }

    const kmVuoto =
      kmTrasferimenti +
      andata.distanzaKm +
      ritorno.distanzaKm;

    const km = kmServizio + kmVuoto;
    const costoKm = costo(v);

    const ricaviCentesimi = ordinati.every(
      p => Number.isFinite(p.economia?.ricaviCentesimi)
    )
      ? ordinati.reduce(
          (s, p) => s + p.economia.ricaviCentesimi, 0
        )
      : null;

    const costoCentesimi = costoKm === null
      ? null
      : Math.round(km * costoKm * 100);

    verificaAttiva();

    return {
      giorno,
      veicoloId: v.id,
      posti: v.posti_totali,
      tipiVeicoloAmmessi,
      gruppi: ordinati.map(p => {
        const costoServizio = costoKm === null
          ? null
          : Math.round(p.economia.km * costoKm * 100);

        return {
          ...p,
          veicoloId: v.id,
          posti: v.posti_totali,
          riempimento: Math.round(
            100 * picco(p) / v.posti_totali
          ),
          economia: {
            ...p.economia,
            costoKm,
            costoCentesimi: costoServizio,
            margineCentesimi:
              costoServizio === null ||
              p.economia.ricaviCentesimi == null
                ? null
                : p.economia.ricaviCentesimi - costoServizio
          }
        };
      }),
      piccoPasseggeri,
      passeggeri: ordinati.reduce(
        (s, p) => s + p.passeggeri, 0
      ),
      durataMs,
      attesaMs,
      kmTrasferimenti,
      logistica: {
        base: v.localita,
        trasferimentiTimeline,
        kmServizio,
        kmVuoto,
        posizionamento: {
          km: andata.distanzaKm,
          durataMs: andata.durataMs
        },
        riposizionamento: {
          km: ritorno.distanzaKm,
          durataMs: ritorno.durataMs
        },
        partenzaBase: new Date(partenzaBase).toISOString(),
        arrivoBase: new Date(arrivoBase).toISOString()
      },
      economia: {
        km,
        costoKm,
        ricaviCentesimi,
        costoCentesimi,
        margineCentesimi:
          ricaviCentesimi === null || costoCentesimi === null
            ? null
            : ricaviCentesimi - costoCentesimi
      },
      bagagliVerificati: false,
      approvabile: false
    };
  }

  function sovrapposta(candidata, esclusa = null) {
    return missioni.some(m =>
      m !== esclusa &&
      String(m.veicoloId) === String(candidata.veicoloId) &&
      Date.parse(m.logistica.partenzaBase) <
        Date.parse(candidata.logistica.arrivoBase) &&
      Date.parse(candidata.logistica.partenzaBase) <
        Date.parse(m.logistica.arrivoBase)
    );
  }

  const ordinati = opzioni.ordine
    ? opzioni.ordine([...proposte])
    : [...proposte].sort(
        (a, b) => inizio(a) - inizio(b)
      );

  for (const p of ordinati) {

    verificaAttiva();

    if (
      !Number.isFinite(inizio(p)) ||
      !Number.isFinite(fine(p)) ||
      fine(p) <= inizio(p) ||
      !Number.isFinite(picco(p)) ||
      !Number.isFinite(p.economia?.km) ||
      p.economia.km < 0
    ) {
      nonAssegnate.push({
        prenotazioni: p.prenotazioni,
        motivo: 'DATI_SERVIZIO_INCOMPLETI'
      });
      continue;
    }

    const alternative = [];

    for (const v of veicoli) {

      verificaAttiva();

      if (v.posti_totali < picco(p)) continue;

      if (
        !veicoloCompatibileServizioNcc(v, p)
      ) continue;

      const esistenti = missioni.filter(
        m => String(m.veicoloId) === String(v.id)
      );

      for (const m of esistenti) {
        const nuova = await valuta(v, [...m.gruppi, p]);

        verificaAttiva();

        if (!nuova || sovrapposta(nuova, m)) continue;

        alternative.push({
          precedente: m,
          missione: nuova,
          deltaKm: nuova.economia.km - m.economia.km,
          deltaCosto:
            nuova.economia.costoCentesimi === null ||
            m.economia.costoCentesimi === null
              ? null
              : nuova.economia.costoCentesimi -
                m.economia.costoCentesimi
        });
      }

      const nuova = await valuta(v, [p]);

      verificaAttiva();

      if (!nuova || sovrapposta(nuova)) continue;

      alternative.push({
        precedente: null,
        missione: nuova,
        deltaKm: nuova.economia.km,
        deltaCosto: nuova.economia.costoCentesimi
      });
    }

    verificaAttiva();

    alternative.sort((a, b) =>
      Number(a.deltaCosto === null) -
        Number(b.deltaCosto === null) ||
      (a.deltaCosto ?? 0) - (b.deltaCosto ?? 0) ||
      a.deltaKm - b.deltaKm ||
      a.missione.posti - b.missione.posti
    );

    const scelta = alternative[0];

    if (!scelta) {
      nonAssegnate.push({
        prenotazioni: p.prenotazioni,
        passeggeri: p.passeggeri,
        motivo: (
          veicoli.some(
            v => Number(v.posti_totali) >= picco(p)
          ) &&
          !veicoli.some(
            v =>
              Number(v.posti_totali) >= picco(p) &&
              veicoloCompatibileServizioNcc(v, p)
          )
        )
          ? 'NESSUN_VEICOLO_COMPATIBILE'
          : 'NESSUNA_MISSIONE_COMPATIBILE'
      });
      continue;
    }

    if (scelta.precedente) {
      const index = missioni.indexOf(scelta.precedente);
      missioni[index] = scelta.missione;
    } else {
      missioni.push(scelta.missione);
    }
  }


  // RICERCA_LOCALE_V22

  const limitiRicerca = {
    maxIterazioni: opzioni.maxIterazioni ?? 10,
    maxValutazioni: opzioni.maxValutazioni ?? 5000,
    maxTempoMs: opzioni.maxTempoMs ?? 15000
  };

  // NCC_DIAGNOSTICA_REINSERIMENTO_V273

  const diagnosticaReinserimento = {
    serviziEsclusi: 0,
    tentativi: {
      missioneEsistente: 0,
      missioneNuova: 0,
      sostituzioneInterna: 0,
      spostamentoMissioneEsistente: 0,
      spostamentoMissioneNuova: 0
    },
    capienzaInsufficiente: 0,
    categoriaIncompatibile: 0,
    valutazioni: {
      valide: 0,
      nulle: 0
    },
    piani: {
      incompatibili: 0,
      duplicati: 0,
      migliorativi: 0,
      nonMigliorativi: 0
    },
    ponte: {
      combinazioni: 0,
      veicoliProvati: 0,
      valutazioniValide: 0,
      rifiuti: {}
    },
    redistribuzione: {
      combinazioni: 0,
      nodiEsplorati: 0,
      valutazioniMissioni: 0,
      missioniValide: 0,
      pianiCompleti: 0,
      pianiMigliorativi: 0,
      scartiCapienza: 0,
      scartiCompatibilita: 0,
      scartiDimensione: 0,
      rifiuti: {},
      limiteLocaleRaggiunto: false,
      budgetEsaurito: false
    }
  };

  let faseReinserimento = false;

  const ricercaStart = Date.now();

  let valutazioni = 0;
  let iterazioni = 0;
  let miglioramenti = 0;

  const operazioni = {
    spostamenti: 0,
    scambi: 0,
    fusioni: 0,
    sostituzioni: 0,

    ...(opzioni.reinserimentoDinamico === true
      ? {
          reinserimenti: 0,
          reinserimentiConSpostamento: 0,
          reinserimentiPonte: 0,
          reinserimentiRedistribuzione: 0
        }
      : {})
  };

  const veicoliMap = new Map(
    veicoli.map(v => [String(v.id), v])
  );

  // NCC_REINSERIMENTO_V273

  const reinserimento =
    opzioni.schedulazioneTemporale === true &&
    opzioni.reinserimentoDinamico === true;

  const chiaveServizio = p =>
    JSON.stringify(
      p.prenotazioni.map(String).sort()
    );

  function serviziEsclusi(lista) {

    verificaAttiva();

    const assegnati = new Set(
      lista.flatMap(m =>
        m.gruppi.map(chiaveServizio)
      )
    );

    return proposte.filter(
      p => !assegnati.has(chiaveServizio(p))
    );
  }

  function score(lista) {
    return {

      ...(reinserimento
        ? {
            prenotazioni: new Set(
              lista.flatMap(m =>
                m.gruppi.flatMap(p =>
                  p.prenotazioni.map(String)
                )
              )
            ).size
          }
        : {}),
      senzaCosto: lista.filter(
        m => m.economia.costoCentesimi === null
      ).length,

      costo: lista.reduce(
        (s, m) => s + (m.economia.costoCentesimi ?? 0), 0
      ),

      km: lista.reduce(
        (s, m) => s + m.economia.km, 0
      ),

      kmVuoto: lista.reduce(
        (s, m) => s + m.logistica.kmVuoto, 0
      ),

      missioni: lista.length,

      veicoli: new Set(
        lista.map(m => String(m.veicoloId))
      ).size
    };
  }

  function confronta(a, b) {
    return (
      (reinserimento
        ? b.prenotazioni - a.prenotazioni
        : 0) ||
      a.senzaCosto - b.senzaCosto ||
      a.costo - b.costo ||
      Math.round(a.km * 1000) -
        Math.round(b.km * 1000) ||
      a.missioni - b.missioni ||
      a.veicoli - b.veicoli
    );
  }

  function budgetDisponibile() {

    verificaAttiva();

    return (
      valutazioni < limitiRicerca.maxValutazioni &&
      Date.now() - ricercaStart <
        limitiRicerca.maxTempoMs
    );
  }

  function pianoCompatibile(lista) {

    verificaAttiva();

    for (let i = 0; i < lista.length; i++) {

      verificaAttiva();
      const a = lista[i];

      for (let j = i + 1; j < lista.length; j++) {

        verificaAttiva();

        const b = lista[j];

        if (
          String(a.veicoloId) !== String(b.veicoloId)
        ) continue;

        if (
          Date.parse(a.logistica.partenzaBase) <
            Date.parse(b.logistica.arrivoBase) &&
          Date.parse(b.logistica.partenzaBase) <
            Date.parse(a.logistica.arrivoBase)
        ) return false;
      }
    }

    return true;
  }

  async function rivaluta(veicoloId, gruppi, diagnosticaRifiuto = null) {
    if (!budgetDisponibile()) return null;

    const v = veicoliMap.get(String(veicoloId));

    if (!v || !gruppi.length) return null;

    // NCC_REINSERIMENTO_COMPATIBILITA_V2902E2E4
    if (
      !veicoloCompatibileNcc(
        v,
        restrizioniMissioneNcc(gruppi)
      )
    ) {
      if (faseReinserimento) {
        diagnosticaReinserimento.categoriaIncompatibile++;
      }

      if (diagnosticaRifiuto) {
        diagnosticaRifiuto('VEICOLO_NON_COMPATIBILE');
      }

      return null;
    }

    valutazioni++;

    const risultato = await valuta(v, gruppi, diagnosticaRifiuto);

    verificaAttiva();

    if (faseReinserimento) {
      diagnosticaReinserimento.valutazioni[
        risultato ? 'valide' : 'nulle'
      ]++;
    }

    return risultato;
  }

  const scoreIniziale = score(missioni);

  for (
    let iter = 0;
    iter < limitiRicerca.maxIterazioni &&
      budgetDisponibile();
    iter++
  ) {
    iterazioni++;

    const corrente = [...missioni];

    let migliore = null;
    let scoreMigliore = score(corrente);
    let tipoMigliore = null;

    function proponi(lista, tipo) {

      verificaAttiva();

      if (!pianoCompatibile(lista)) {
        if (faseReinserimento) {
          diagnosticaReinserimento.piani.incompatibili++;
        }
        return;
      }

      if (reinserimento) {

        const ids = lista.flatMap(m =>
          m.gruppi.flatMap(p =>
            p.prenotazioni.map(String)
          )
        );

        if (new Set(ids).size !== ids.length) {
          if (faseReinserimento) {
            diagnosticaReinserimento.piani.duplicati++;
          }
          return;
        }
      }

      const s = score(lista);

      if (confronta(s, scoreMigliore) < 0) {
        if (faseReinserimento) {
          diagnosticaReinserimento.piani.migliorativi++;
        }

        migliore = lista;
        scoreMigliore = s;
        tipoMigliore = tipo;
      } else if (faseReinserimento) {
        diagnosticaReinserimento.piani.nonMigliorativi++;
      }
    }

    // REINSERIMENTO DINAMICO V273

    if (reinserimento) {

      faseReinserimento = true;

      const esclusi = serviziEsclusi(corrente)
        .sort((a, b) =>
          b.prenotazioni.length -
          a.prenotazioni.length
        );

      diagnosticaReinserimento.serviziEsclusi +=
        esclusi.length;

      for (const p of esclusi) {

        if (!budgetDisponibile()) break;

        // Inserimento in missione esistente

        for (const m of corrente) {

          if (!budgetDisponibile()) break;

          if (m.posti < picco(p)) {
            diagnosticaReinserimento.capienzaInsufficiente++;
            continue;
          }

          diagnosticaReinserimento.tentativi.missioneEsistente++;

          const nuova = await rivaluta(
            m.veicoloId,
            [...m.gruppi, p]
          );

          if (!nuova) continue;

          proponi(
            corrente.map(
              x => x === m ? nuova : x
            ),
            'reinserimenti'
          );
        }

        // Nuova missione indipendente

        for (const v of veicoli) {

          if (!budgetDisponibile()) break;

          if (v.posti_totali < picco(p)) {
            diagnosticaReinserimento.capienzaInsufficiente++;
            continue;
          }

          diagnosticaReinserimento.tentativi.missioneNuova++;

          const nuova = await rivaluta(
            v.id,
            [p]
          );

          if (!nuova) continue;

          proponi(
            [...corrente, nuova],
            'reinserimenti'
          );
        }

        // Reinserimento con spostamento
        // di un servizio gia assegnato

        for (const a of corrente) {

          if (!budgetDisponibile()) break;

          if (a.posti < picco(p)) continue;

          for (const q of a.gruppi) {

            if (!budgetDisponibile()) break;

            diagnosticaReinserimento.tentativi.sostituzioneInterna++;

            const nuovaA = await rivaluta(
              a.veicoloId,
              a.gruppi.map(
                x => x === q ? p : x
              )
            );

            if (!nuovaA) continue;

            // Trasferimento q in altra missione

            for (const b of corrente) {

              if (!budgetDisponibile()) break;

              if (a === b) continue;

              if (b.posti < picco(q)) continue;

              diagnosticaReinserimento.tentativi.spostamentoMissioneEsistente++;

              const nuovaB = await rivaluta(
                b.veicoloId,
                [...b.gruppi, q]
              );

              if (!nuovaB) continue;

              proponi(
                corrente.map(m =>
                  m === a ? nuovaA :
                  m === b ? nuovaB : m
                ),
                'reinserimentiConSpostamento'
              );
            }

            // Trasferimento q in nuova missione

            for (const v of veicoli) {

              if (!budgetDisponibile()) break;

              if (v.posti_totali < picco(q)) {
                continue;
              }

              diagnosticaReinserimento.tentativi.spostamentoMissioneNuova++;

              const nuovaQ = await rivaluta(
                v.id,
                [q]
              );

              if (!nuovaQ) continue;

              proponi(
                [
                  ...corrente.map(
                    m => m === a ? nuovaA : m
                  ),
                  nuovaQ
                ],
                'reinserimentiConSpostamento'
              );
            }
          }
        }

        // NCC_REDISTRIBUZIONE_V277

        const diagRedistribuzione =
          diagnosticaReinserimento.redistribuzione;

        const maxGruppiRedistribuzione = 6;
        const maxNodiRedistribuzione = 600;
        const maxValutazioniRedistribuzione = 1200;

        let nodiLocali = 0;
        let valutazioniLocali = 0;

        const cacheRedistribuzione = new Map();

        function budgetRedistribuzione() {
          if (!budgetDisponibile()) {
            diagRedistribuzione.budgetEsaurito = true;
            return false;
          }

          if (
            nodiLocali >= maxNodiRedistribuzione ||
            valutazioniLocali >=
              maxValutazioniRedistribuzione
          ) {
            diagRedistribuzione.limiteLocaleRaggiunto = true;
            return false;
          }

          return true;
        }

        async function valutaRedistribuzione(v, gruppi) {
          if (!budgetRedistribuzione()) return null;

          const k = JSON.stringify([
            String(v.id),
            gruppi.map(chiaveServizio).sort()
          ]);

          if (cacheRedistribuzione.has(k)) {
            return cacheRedistribuzione.get(k);
          }

          valutazioniLocali++;
          diagRedistribuzione.valutazioniMissioni++;

          const risultato = await rivaluta(
            v.id,
            gruppi,
            causa => {
              const r = diagRedistribuzione.rifiuti;
              r[causa] = (r[causa] ?? 0) + 1;
            }
          );

          if (risultato) {
            diagRedistribuzione.missioniValide++;
          }

          cacheRedistribuzione.set(k, risultato);

          return risultato;
        }

        async function provaRedistribuzione(indici) {
          if (!budgetRedistribuzione()) return;

          const selezionate = indici.map(
            i => corrente[i]
          );

          const rimosse = new Set(selezionate);

          const residue = corrente.filter(
            m => !rimosse.has(m)
          );

          const gruppi = [
            ...selezionate.flatMap(m => m.gruppi),
            p
          ];

          if (
            gruppi.length > maxGruppiRedistribuzione
          ) {
            diagRedistribuzione.scartiDimensione++;
            return;
          }

          const ids = gruppi.flatMap(
            g => g.prenotazioni.map(String)
          );

          if (new Set(ids).size !== ids.length) {
            return;
          }

          diagRedistribuzione.combinazioni++;

          // Priorita ai servizi con meno veicoli
          // compatibili e maggiore occupazione.

          const compatibili = g =>
            veicoli.filter(
              v =>
                v.posti_totali >= picco(g) &&
                veicoloCompatibileServizioNcc(v, g)
            ).length;

          gruppi.sort((a, b) =>
            compatibili(a) - compatibili(b) ||
            picco(b) - picco(a) ||
            inizio(a) - inizio(b)
          );

          const visitati = new Set();

          async function esplora(indice, piano) {
            if (!budgetRedistribuzione()) return;

            verificaAttiva();

            nodiLocali++;
            diagRedistribuzione.nodiEsplorati++;

            const firma = JSON.stringify([
              indice,
              piano.map(m =>
                JSON.stringify([
                  String(m.veicoloId),
                  m.gruppi.map(
                    chiaveServizio
                  ).sort()
                ])
              ).sort()
            ]);

            if (visitati.has(firma)) return;
            visitati.add(firma);

            if (indice === gruppi.length) {
              diagRedistribuzione.pianiCompleti++;

              const prima = scoreMigliore;

              proponi(
                piano,
                'reinserimentiRedistribuzione'
              );

              if (
                confronta(scoreMigliore, prima) < 0
              ) {
                diagRedistribuzione.pianiMigliorativi++;
              }

              return;
            }

            const gruppo = gruppi[indice];
            const alternative = [];

            for (const v of veicoli) {
              if (!budgetRedistribuzione()) break;

              if (v.posti_totali < picco(gruppo)) {
                diagRedistribuzione.scartiCapienza++;
                continue;
              }

              if (
                !veicoloCompatibileServizioNcc(v, gruppo)
              ) {
                diagRedistribuzione.scartiCompatibilita++;
                diagnosticaReinserimento.categoriaIncompatibile++;
                continue;
              }

              // Inserimento in missione esistente.

              for (let i = 0; i < piano.length; i++) {
                if (!budgetRedistribuzione()) break;

                const m = piano[i];

                // Le missioni residue restano immutate.
                if (residue.includes(m)) continue;

                if (
                  String(m.veicoloId) !== String(v.id)
                ) continue;

                const nuova =
                  await valutaRedistribuzione(
                    v,
                    [...m.gruppi, gruppo]
                  );

                if (!nuova) continue;

                const candidato = [...piano];
                candidato[i] = nuova;

                if (!pianoCompatibile(candidato)) {
                  diagRedistribuzione.scartiCompatibilita++;
                  continue;
                }

                alternative.push(candidato);
              }

              // Creazione di una nuova missione.

              if (!budgetRedistribuzione()) break;

              const nuova =
                await valutaRedistribuzione(
                  v,
                  [gruppo]
                );

              if (!nuova) continue;

              const candidato = [...piano, nuova];

              if (!pianoCompatibile(candidato)) {
                diagRedistribuzione.scartiCompatibilita++;
                continue;
              }

              alternative.push(candidato);
            }

            // Esplora prima i piani economicamente
            // piu convenienti.

            alternative.sort(
              (a, b) => confronta(score(a), score(b))
            );

            for (const candidato of alternative) {
              if (!budgetRedistribuzione()) break;

              await esplora(
                indice + 1,
                candidato
              );
            }
          }

          await esplora(0, [...residue]);
        }

        // Ricostruzione di una missione.

        for (let i = 0; i < corrente.length; i++) {
          if (!budgetRedistribuzione()) break;

          await provaRedistribuzione([i]);
        }

        // Ricostruzione di due missioni.

        for (let i = 0; i < corrente.length; i++) {
          if (!budgetRedistribuzione()) break;

          for (let j = i + 1; j < corrente.length; j++) {
            if (!budgetRedistribuzione()) break;

            await provaRedistribuzione([i, j]);
          }
        }

        // Ricostruzione di tre missioni.

        for (let i = 0; i < corrente.length; i++) {
          if (!budgetRedistribuzione()) break;

          for (let j = i + 1; j < corrente.length; j++) {
            if (!budgetRedistribuzione()) break;

            for (
              let k = j + 1;
              k < corrente.length;
              k++
            ) {
              if (!budgetRedistribuzione()) break;

              await provaRedistribuzione([i, j, k]);
            }
          }
        }

        // NCC_REINSERIMENTO_PONTE_MULTI_MISSIONE_V274

        async function provaPonte(indici) {

          if (!budgetDisponibile()) return;

          const selezionate = indici.map(
            i => corrente[i]
          );

          if (selezionate.length < 2) return;

          const gruppi = [
            ...selezionate.flatMap(m => m.gruppi),
            p
          ];

          // Evita combinazioni con prenotazioni duplicate.

          const ids = gruppi.flatMap(g =>
            g.prenotazioni.map(String)
          );

          if (new Set(ids).size !== ids.length) {
            return;
          }

          diagnosticaReinserimento.ponte.combinazioni++;

          // Prova ogni veicolo compatibile.

          for (const v of veicoli) {

            if (!budgetDisponibile()) break;

            if (
              gruppi.some(g =>
                picco(g) > v.posti_totali
              )
            ) {
              diagnosticaReinserimento.capienzaInsufficiente++;
              continue;
            }

            if (
              !veicoloCompatibileNcc(
                v,
                restrizioniMissioneNcc(gruppi)
              )
            ) {
              diagnosticaReinserimento.categoriaIncompatibile++;

              const rifiuti =
                diagnosticaReinserimento.ponte.rifiuti;

              rifiuti.VEICOLO_NON_COMPATIBILE =
                (rifiuti.VEICOLO_NON_COMPATIBILE ?? 0) + 1;

              continue;
            }

            diagnosticaReinserimento.ponte.veicoliProvati++;

            const nuova = await rivaluta(
              v.id,
              gruppi,
              causa => {
                const rifiuti =
                  diagnosticaReinserimento.ponte.rifiuti;

                rifiuti[causa] =
                  (rifiuti[causa] ?? 0) + 1;
              }
            );

            if (!nuova) continue;

            diagnosticaReinserimento.ponte.valutazioniValide++;

            const rimosse = new Set(selezionate);

            const piano = [
              ...corrente.filter(
                m => !rimosse.has(m)
              ),
              nuova
            ];

            proponi(
              piano,
              'reinserimentiPonte'
            );
          }
        }

        // Combinazioni di due missioni.

        for (let i = 0; i < corrente.length; i++) {

          if (!budgetDisponibile()) break;

          for (let j = i + 1; j < corrente.length; j++) {

            if (!budgetDisponibile()) break;

            await provaPonte([i, j]);

            // Combinazioni di tre missioni.

            for (let k = j + 1; k < corrente.length; k++) {

              if (!budgetDisponibile()) break;

              await provaPonte([i, j, k]);
            }
          }
        }
      }
    }

    faseReinserimento = false;

    // SOSTITUZIONE VEICOLO

    for (const m of corrente) {
      if (!budgetDisponibile()) break;

      for (const v of veicoli) {
        if (!budgetDisponibile()) break;

        if (
          String(v.id) === String(m.veicoloId)
        ) continue;

        if (
          v.posti_totali < m.piccoPasseggeri
        ) continue;

        const nuova = await rivaluta(v.id, m.gruppi);

        if (!nuova) continue;

        proponi(
          corrente.map(x => x === m ? nuova : x),
          'sostituzioni'
        );
      }
    }

    // FUSIONE, SPOSTAMENTO E SCAMBIO

    for (let i = 0; i < corrente.length; i++) {
      if (!budgetDisponibile()) break;

      for (let j = 0; j < corrente.length; j++) {
        if (!budgetDisponibile()) break;
        if (i === j) continue;

        const a = corrente[i];
        const b = corrente[j];

        const altre = corrente.filter(
          (_, k) => k !== i && k !== j
        );

        // Fusione sul veicolo B

        const fusione = await rivaluta(
          b.veicoloId,
          [...a.gruppi, ...b.gruppi]
        );

        if (fusione) {
          proponi(
            [...altre, fusione],
            'fusioni'
          );
        }

        // Spostamento di un servizio da A verso B

        for (const p of a.gruppi) {
          if (!budgetDisponibile()) break;

          const nuovaB = await rivaluta(
            b.veicoloId,
            [...b.gruppi, p]
          );

          if (!nuovaB) continue;

          const residui = a.gruppi.filter(
            x => x !== p
          );

          if (!residui.length) {
            proponi(
              [...altre, nuovaB],
              'spostamenti'
            );
            continue;
          }

          const nuovaA = await rivaluta(
            a.veicoloId,
            residui
          );

          if (!nuovaA) continue;

          proponi(
            [...altre, nuovaA, nuovaB],
            'spostamenti'
          );
        }

        // Scambio di due servizi

        if (j <= i) continue;

        for (const p of a.gruppi) {
          if (!budgetDisponibile()) break;

          for (const q of b.gruppi) {
            if (!budgetDisponibile()) break;

            const nuovaA = await rivaluta(
              a.veicoloId,
              a.gruppi.map(x => x === p ? q : x)
            );

            if (!nuovaA) continue;

            const nuovaB = await rivaluta(
              b.veicoloId,
              b.gruppi.map(x => x === q ? p : x)
            );

            if (!nuovaB) continue;

            proponi(
              [...altre, nuovaA, nuovaB],
              'scambi'
            );
          }
        }
      }
    }

    verificaAttiva();

    if (!migliore) break;

    missioni.splice(
      0, missioni.length, ...migliore
    );

    miglioramenti++;
    operazioni[tipoMigliore]++;
  }

  verificaAttiva();

  const scoreFinale = score(missioni);

  const ottimizzazione = {
    algoritmo: 'RICERCA_LOCALE_V22',
    iterazioni,
    valutazioni,
    miglioramenti,
    operazioni,

    ...(reinserimento
      ? {
          diagnosticaReinserimento:
            diagnosticaReinserimento
        }
      : {}),

    tempoMs: Date.now() - ricercaStart,
    budgetEsaurito: !budgetDisponibile(),
    prima: scoreIniziale,
    dopo: scoreFinale,

    risparmioKm:
      scoreIniziale.km - scoreFinale.km,

    risparmioKmVuoto:
      scoreIniziale.kmVuoto - scoreFinale.kmVuoto,

    risparmioCentesimi:
      scoreIniziale.senzaCosto === 0 &&
      scoreFinale.senzaCosto === 0
        ? scoreIniziale.costo - scoreFinale.costo
        : null
  };

  const gruppiAssegnati = missioni.flatMap(m => m.gruppi);

  if (reinserimento) {

    const assegnati = new Set(
      gruppiAssegnati.map(chiaveServizio)
    );

    const residue = nonAssegnate.filter(
      p => !assegnati.has(chiaveServizio(p))
    );

    nonAssegnate.splice(
      0,
      nonAssegnate.length,
      ...residue
    );
  }

  verificaAttiva();

  return {
    motore: 'V2.2',
    ottimizzazione,
    approvabile: false,
    missioni,
    nonAssegnate,
    riepilogo: {
      missioni: missioni.length,
      veicoliUtilizzati: new Set(
        missioni.map(m => m.veicoloId)
      ).size,
      serviziAssegnati: gruppiAssegnati.length,
      serviziNonAssegnati: nonAssegnate.length,
      prenotazioniAssegnate: new Set(
        gruppiAssegnati.flatMap(p => p.prenotazioni)
      ).size,
      passeggeri: missioni.reduce(
        (s, m) => s + m.passeggeri, 0
      ),
      kmServizio: missioni.reduce(
        (s, m) => s + m.logistica.kmServizio, 0
      ),
      kmVuoto: missioni.reduce(
        (s, m) => s + m.logistica.kmVuoto, 0
      ),
      kmTotali: missioni.reduce(
        (s, m) => s + m.economia.km, 0
      ),
      costoCentesimi: missioni.every(
        m => m.economia.costoCentesimi !== null
      )
        ? missioni.reduce(
            (s, m) => s + m.economia.costoCentesimi, 0
          )
        : null,
      margineCentesimi: missioni.every(
        m => m.economia.margineCentesimi !== null
      )
        ? missioni.reduce(
            (s, m) => s + m.economia.margineCentesimi, 0
          )
        : null,
      missioniSenzaCosto: missioni.filter(
        m => m.economia.costoCentesimi === null
      ).length
    },
    routing: routing.diagnostica?.() ?? null
  };
}


// MULTISTART_V23

function mescolaRiproducibile(lista, seed) {
  let stato = seed >>> 0;

  function random() {
    stato = (
      Math.imul(1664525, stato) + 1013904223
    ) >>> 0;

    return stato / 4294967296;
  }

  const risultato = [...lista];

  for (let i = risultato.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));

    [risultato[i], risultato[j]] =
      [risultato[j], risultato[i]];
  }

  return risultato;
}

function scorePiano(piano) {
  const r = piano.riepilogo;

  const gruppiSenzaCosto = piano.missioni
    .filter(m => m.economia.costoCentesimi === null)
    .flatMap(m => m.gruppi);

  const senzaCosto = new Set(
    gruppiSenzaCosto.flatMap(p => p.prenotazioni)
  ).size;

  const costoConosciuto = piano.missioni.reduce(
    (s, m) => s + (m.economia.costoCentesimi ?? 0),
    0
  );

  return [
    -r.prenotazioniAssegnate,
    senzaCosto,
    costoConosciuto,
    Math.round(r.kmVuoto * 1000),
    r.missioni,
    r.veicoliUtilizzati
  ];
}

function confrontaPiani(a, b) {
  const sa = scorePiano(a);
  const sb = scorePiano(b);

  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) {
      return sa[i] - sb[i];
    }
  }

  return 0;
}

export async function ottimizzaMissioniNcc(
  proposte,
  veicoli,
  routing,
  parametri = {},
  occupati = new Set(),
  opzioni = {}
) {
  const verificaAttiva =
    opzioni.verificaAttiva ?? (() => {});

  verificaAttiva();

  const start = Date.now();

  const maxTempoMs = opzioni.maxTempoMs ?? 30000;
  const maxStrategie = opzioni.maxStrategie ?? 8;

  const cache = new Map();
  const coordinateRegistrate = new Map();

  let cacheHit = 0;
  let cacheMiss = 0;

  const routingCondiviso = {
    registraCoordinate(nome, coord) {

      verificaAttiva();

      const chiave = String(nome)
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();

      const valore = JSON.stringify([
        coord.lat,
        coord.lon
      ]);

      if (coordinateRegistrate.has(chiave)) {
        if (
          coordinateRegistrate.get(chiave) !== valore
        ) {
          throw new Error(
            'Coordinate incompatibili: ' + nome
          );
        }

        return;
      }

      routing.registraCoordinate(nome, coord);

      coordinateRegistrate.set(chiave, valore);
    },

    async tratta(a, b) {

      verificaAttiva();

      const k = JSON.stringify([a, b]);

      if (cache.has(k)) {
        cacheHit++;

        const risultato = await cache.get(k);

        verificaAttiva();

        return risultato;
      }

      cacheMiss++;

      const promessa = Promise.resolve()

        .then(() => {

          verificaAttiva();

          return routing.tratta(a, b);
        })

        .catch(() => {

          verificaAttiva();

          return null;
        });

      cache.set(k, promessa);

      const risultato = await promessa;

      verificaAttiva();

      return risultato;
    },

    diagnostica() {
      return {
        ...(routing.diagnostica?.() ?? {}),
        cacheMultistart: cache.size,
        cacheHit,
        cacheMiss
      };
    }
  };

  const cronologico = (a, b) =>
    Date.parse(a.inizio) - Date.parse(b.inizio);

  const picco = p =>
    p.piccoPasseggeri ?? p.passeggeri;

  const compatibili = p =>
    veicoli.filter(v =>
      v.posti_totali >= picco(p) &&
      veicoloCompatibileServizioNcc(v, p)
    ).length;

  // NCC_PREFETCH_INTEGRATION_V22

  const diagnosticaPrima =
    routing.diagnostica?.() ?? {};

  const budgetResiduo = Math.max(
    0,
    (opzioni.budgetRouting ?? 1000) -
      (diagnosticaPrima.elementi ?? 0)
  );

  const limitePrefetch = Math.min(
    300,
    Math.floor(budgetResiduo * 0.5),
    opzioni.maxTrattePrefetch ?? 300
  );

  verificaAttiva();

  const prefetch = opzioni.prefetch === true
    ? await precalcolaTratteNcc(
        proposte,
        veicoli,
        routingCondiviso,
        parametri,
        occupati,
        {
          maxTratte: limitePrefetch
        }
      )
    : {
        algoritmo: 'NCC_PREFETCH_V22',
        disabilitato: true
      };

  verificaAttiva();

  const strategie = [
    {
      nome: 'CRONOLOGICO',
      ordine: lista => lista.sort(cronologico)
    },
    {
      nome: 'CAPIENZA',
      ordine: lista => lista.sort((a, b) =>
        picco(b) - picco(a) ||
        cronologico(a, b)
      )
    },
    {
      nome: 'COMPLESSITA',
      ordine: lista => lista.sort((a, b) =>
        compatibili(a) - compatibili(b) ||
        picco(b) - picco(a) ||
        cronologico(a, b)
      )
    },
    {
      nome: 'PRENOTAZIONI',
      ordine: lista => lista.sort((a, b) =>
        b.prenotazioni.length -
          a.prenotazioni.length ||
        cronologico(a, b)
      )
    },
    {
      nome: 'PERCORRENZA',
      ordine: lista => lista.sort((a, b) =>
        b.economia.km - a.economia.km ||
        cronologico(a, b)
      )
    },
    ...[42, 123, 777].map(seed => ({
      nome: 'RANDOM_' + seed,
      ordine: lista =>
        mescolaRiproducibile(lista, seed)
    }))
  ];

  let migliore = null;
  let strategiaMigliore = null;

  const risultati = [];

  for (const strategia of strategie.slice(
    0, Math.max(1, maxStrategie)
  )) {

    verificaAttiva();

    const residuo =
      maxTempoMs - (Date.now() - start);

    if (migliore && residuo <= 0) break;

    const t = Date.now();

    const piano = await ottimizzaSingoloPiano(
      proposte,
      veicoli,
      routingCondiviso,
      parametri,
      occupati,
      {
        verificaAttiva,
        ordine: strategia.ordine,
        schedulazioneTemporale:
          opzioni.schedulazioneTemporale === true,

        reinserimentoDinamico:
          opzioni.reinserimentoDinamico === true,
        maxIterazioni: 10,
        maxValutazioni: 5000,
        maxTempoMs: Math.max(
          1, Math.min(15000, residuo)
        )
      }
    );

    verificaAttiva();

    risultati.push({
      strategia: strategia.nome,
      tempoMs: Date.now() - t,
      prenotazioni:
        piano.riepilogo.prenotazioniAssegnate,
      servizi:
        piano.riepilogo.serviziAssegnati,
      missioni:
        piano.riepilogo.missioni,
      veicoli:
        piano.riepilogo.veicoliUtilizzati,
      kmVuoto:
        piano.riepilogo.kmVuoto,
      kmTotali:
        piano.riepilogo.kmTotali,
      costoCentesimi:
        piano.riepilogo.costoCentesimi,
      miglioramenti:
        piano.ottimizzazione?.miglioramenti ?? 0,
      score: scorePiano(piano)
    });

    if (
      !migliore ||
      confrontaPiani(piano, migliore) < 0
    ) {
      migliore = piano;
      strategiaMigliore = strategia.nome;
    }
  }

  verificaAttiva();


  // NCC_ADATTIVA_DIAGNOSTICA_V280

  let diagnosticaAdattiva = null;

  if (opzioni.aggregazioneAdattiva === true) {
    verificaAttiva();

    if (Date.now() - start >= maxTempoMs) {
      diagnosticaAdattiva = {
        versione: '2.8.0',
        modalita: 'SOLO_DIAGNOSTICA',
        stato: 'BUDGET_TEMPO_ESAURITO'
      };
    } else {
      diagnosticaAdattiva =
        await diagnosticaConflittiNcc({
          proposte,
          missioni: migliore.missioni,
          veicoli,
          tratta: (a, b) =>
            routingCondiviso.tratta(a, b),
          verificaAttiva,
          maxConfronti: 100
        });
    }

    verificaAttiva();
  }

  return {
    ...migliore,
    ...(diagnosticaAdattiva
      ? { diagnosticaAdattiva }
      : {}),
    motore: 'V2.3',
    approvabile: false,

    ...(opzioni.schedulazioneTemporale === true
      ? {
          schedulazioneTemporale: {
            versione: '2.7.2',
            attiva: true,
            serviziPosticipati: migliore.missioni
              .flatMap(m => m.gruppi)
              .filter(p =>
                (p.schedulazioneTemporale
                  ?.posticipoMs ?? 0) > 0
              ).length,
            posticipoTotaleMs: migliore.missioni
              .flatMap(m => m.gruppi)
              .reduce(
                (s, p) => s +
                  (p.schedulazioneTemporale
                    ?.posticipoMs ?? 0),
                0
              )
          }
        }
      : {}),

    multistart: {
      algoritmo: 'MULTISTART_V23',
      strategieEseguite: risultati.length,
      strategiaMigliore,
      tempoMs: Date.now() - start,
      budgetTempoSuperato:
        Date.now() - start > maxTempoMs,
      risultati
    },

    prefetch,
    routing: routingCondiviso.diagnostica()
  };
}
