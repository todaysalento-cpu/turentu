
import { costruisciSequenzaFermate } from './popbus-stop-itinerary.service.js';
import { calcolaRoutingFermate } from './popbus-stop-routing.service.js';
import { verificaCompatibilitaTemporaleFermate } from './popbus-stop-temporal.service.js';
import { verificaQualitaFermate } from './popbus-stop-quality.service.js';
import { generaSequenzeStradaliFermate } from './popbus-stop-sequencer.service.js';
import { diagnosticaDepartureFermate } from './popbus-stop-departure-optimizer.shadow.js';

const fail = message => {
  throw new Error(`POPBUS_STOP_EVALUATOR: ${message}`);
};

export async function valutaCombinazioniFermate({
  combinazioni,
  richieste,
  postiTotali,
  departure,
  routing,
  maxValutazioni = 100,
  maxSequenzePerCombinazione = 3,
  maxPermutazioniSequenza = 1000
}) {
  if (!Array.isArray(combinazioni) || !combinazioni.length) {
    fail('combinazioni non valide');
  }

  if (!Array.isArray(richieste) || !richieste.length) {
    fail('richieste non valide');
  }

  if (!Number.isSafeInteger(postiTotali) || postiTotali < 1) {
    fail('postiTotali non valido');
  }

  if (!Number.isFinite(departure)) {
    fail('departure non valido');
  }

  if (!Number.isSafeInteger(maxValutazioni) ||
      maxValutazioni < 1 ||
      maxValutazioni > 1000) {
    fail('maxValutazioni non valido');
  }

  const byId = new Map();

  for (const richiesta of richieste) {
    const id = Number(richiesta.id);
    const posti = Number(richiesta.posti_richiesti);

    if (!Number.isSafeInteger(id) || id <= 0 ||
        byId.has(id) ||
        !Number.isSafeInteger(posti) || posti <= 0) {
      fail('richiesta non valida o duplicata');
    }

    byId.set(id, richiesta);
  }

  const valide = [];
  const scartate = [];
  // Opt-in isolato: nessun recupero operativo senza flag esplicito.
  const departureApplyEnabled = process.env.POPBUS_SHADOW_APPLY_DEPARTURE === '1';
  const departureShadowEnabled = departureApplyEnabled || process.env.POPBUS_SHADOW_OPTIMIZE_DEPARTURE === '1';
  const departureShadow = {
  analizzate: 0,
  recuperabiliTemporalmente: 0,
  recuperabiliConQualita: 0,
  senzaIntersezione: 0,
  errori: 0,
  recuperateValidate: 0,
  recuperiRifiutati: 0,

  // Diagnostica dettagliata dei recuperi APPLY rifiutati.
  recuperiRifiutatiRoutingCapienza: 0,
  recuperiRifiutatiTemporale: 0,
  recuperiRifiutatiQualita: 0,
  recuperiRifiutatiErrore: 0
};
  const daValutare = combinazioni.slice(0, maxValutazioni);

  for (let i = 0; i < daValutare.length; i++) {
    const combinazione = daValutare[i];

    try {
      if (!Array.isArray(combinazione.assegnazioni) ||
          combinazione.assegnazioni.length !== byId.size) {
        fail('assegnazioni incomplete');
      }

      const viste = new Set();

      const assegnazioni = combinazione.assegnazioni.map(a => {
        const id = Number(a.richiesta_id);
        const richiesta = byId.get(id);

        if (!richiesta || viste.has(id)) {
          fail('richiesta mancante o duplicata');
        }

        viste.add(id);

        return {
          ...a,
          posti_richiesti: Number(richiesta.posti_richiesti)
        };
      });

      const sequenza = costruisciSequenzaFermate({
        assegnazioni,
        postiTotali,
        verificaCapienza: false
      });

      if (!sequenza.ok) {
        scartate.push({
          indice: i,
          fase: 'SEQUENZA',
          motivo: sequenza.motivo ?? 'NON_AMMISSIBILE'
        });
        continue;
      }

      const stradali = await generaSequenzeStradaliFermate({
        sequenza,
        ...(routing ? { routing } : {}),
        maxSequenze: maxSequenzePerCombinazione,
        maxPermutazioni: maxPermutazioniSequenza
      });
      if (!stradali.ok || !stradali.sequenze.length) {
        scartate.push({ indice: i, fase: 'SEQUENZIAMENTO',
          motivo: stradali.motivo || 'NESSUNA_SEQUENZA_AMMISSIBILE',
          diagnosticaSequenziamento: stradali.diagnostica ?? null });
        continue;
      }
      for (let j = 0; j < stradali.sequenze.length; j++) {
        const sequenzaStradale = stradali.sequenze[j].sequenza;
        try {
          // Fail closed: a road sequence must carry a verified capacity result.
          if (sequenzaStradale.capienzaVerificata !== true ||
              !Number.isSafeInteger(sequenzaStradale.peak) ||
              sequenzaStradale.peak < 0 ||
              sequenzaStradale.peak > postiTotali) {
            scartate.push({ indice: i, sequenzaIndice: j, fase: 'CAPIENZA',
              motivo: 'CAPIENZA_NON_CERTIFICATA' });
            continue;
          }
          const itinerario = await calcolaRoutingFermate({
            sequenza: sequenzaStradale,
            departure,
            ...(routing ? { routing } : {})
          });
          if (!itinerario.ok) {
            scartate.push({ indice: i, sequenzaIndice: j, fase: 'ROUTING',
              motivo: itinerario.motivo ?? 'NON_AMMISSIBILE' });
            continue;
          }
          // Ensure routing did not drop or alter the verified passenger peak.
          if (!Number.isSafeInteger(itinerario.peak) ||
              itinerario.peak < 0 ||
              itinerario.peak > postiTotali ||
              itinerario.peak !== sequenzaStradale.peak) {
            scartate.push({ indice: i, sequenzaIndice: j, fase: 'CAPIENZA',
              motivo: 'CAPIENZA_ROUTING_DISCORDANTE' });
            continue;
          }
          const temporale = verificaCompatibilitaTemporaleFermate({ itinerario, richieste });
          if (!temporale.ok) {
            let diagnosticaDeparture = null;
            let risultatoDeparture = null;
            if (departureShadowEnabled && temporale.motivo === 'SALITA_FUORI_TOLLERANZA') {
              departureShadow.analizzate++;
              try {
                const risultato = diagnosticaDepartureFermate({ itinerario, richieste });
                risultatoDeparture = risultato;
                let qualitaOttimizzata = null;
                if (risultato.ok && risultato.recuperabileTemporalmente && risultato.itinerarioOttimizzato) {
                  departureShadow.recuperabiliTemporalmente++;
                  qualitaOttimizzata = verificaQualitaFermate({
                    itinerario: risultato.itinerarioOttimizzato,
                    richieste
                  });
                  if (qualitaOttimizzata.ok) departureShadow.recuperabiliConQualita++;
                }
                if (risultato.motivo === 'NESSUNA_INTERSEZIONE_TEMPORALE') {
                  departureShadow.senzaIntersezione++;
                }
                diagnosticaDeparture = {
                  ok: risultato.ok,
                  motivo: risultato.motivo,
                  recuperabileTemporalmente: risultato.recuperabileTemporalmente === true,
                  spostamentoMinuti: risultato.spostamentoMinuti ?? null,
                  departureOriginale: risultato.departureOriginale ?? null,
                  departureOttimizzato: risultato.departureOttimizzato ?? null,
                  qualitaOttimizzataOk: qualitaOttimizzata?.ok ?? null,
                  qualitaOttimizzataMotivo: qualitaOttimizzata?.motivo ?? null
                };
                if (risultato.recuperabileTemporalmente) {
                  console.log('[POPBUS SHADOW DEPARTURE RECUPERABILE]', JSON.stringify({
                    indice: i,
                    sequenzaIndice: j,
                    richiestaIds: richieste.map(r => Number(r.id)),
                    ...diagnosticaDeparture
                  }));
                }
              } catch (error) {
                departureShadow.errori++;
                diagnosticaDeparture = { ok: false, motivo: 'ERRORE_DIAGNOSTICA', errore: error.message };
              }
            }
            // SHADOW APPLY: solo un itinerario RICALCOLATO e rivalidato puo' diventare candidato.
            // L'itinerario traslato dalla diagnostica NON e' una certificazione di routing.
            if (departureApplyEnabled && risultatoDeparture?.ok === true &&
                risultatoDeparture.recuperabileTemporalmente === true &&
                Number.isFinite(risultatoDeparture.departureOttimizzato)) {
              try {
                const itinerarioRecuperato = await calcolaRoutingFermate({
                  sequenza: sequenzaStradale,
                  departure: risultatoDeparture.departureOttimizzato,
                  ...(routing ? { routing } : {})
                });
                if (!itinerarioRecuperato?.ok || itinerarioRecuperato.routingVerificato !== true ||
                    itinerarioRecuperato.capienzaVerificata !== true ||
                    !Number.isSafeInteger(itinerarioRecuperato.peak) ||
                    itinerarioRecuperato.peak !== sequenzaStradale.peak ||
                    itinerarioRecuperato.peak < 0 || itinerarioRecuperato.peak > postiTotali) {
                                  departureShadow.recuperiRifiutati++;
                  departureShadow.recuperiRifiutatiRoutingCapienza++;

                  scartate.push({
                    indice: i,
                    sequenzaIndice: j,
                    fase: 'CAPIENZA',
                    motivo: 'RECUPERO_ROUTING_O_CAPIENZA_NON_CERTIFICATI',
                    diagnosticaDeparture
                  });

                  continue;
                }
                const temporaleRecuperato = verificaCompatibilitaTemporaleFermate({
                  itinerario: itinerarioRecuperato, richieste
                });
                if (!temporaleRecuperato?.ok) {
                  departureShadow.recuperiRifiutati++;
departureShadow.recuperiRifiutatiTemporale++;

scartate.push({ indice: i, sequenzaIndice: j, fase: 'TEMPORALE',
                    motivo: temporaleRecuperato?.motivo ?? 'RECUPERO_TEMPORALE_NON_VALIDO',
                    richiestaId: temporaleRecuperato?.richiestaId ?? null, diagnosticaDeparture });
                  continue;
                }
                const qualitaRecuperata = verificaQualitaFermate({
                  itinerario: itinerarioRecuperato, richieste
                });
                if (!qualitaRecuperata?.ok) {
                  departureShadow.recuperiRifiutati++;
departureShadow.recuperiRifiutatiQualita++;

scartate.push({ indice: i, sequenzaIndice: j, fase: 'QUALITA',
                    motivo: qualitaRecuperata?.motivo ?? 'RECUPERO_QUALITA_NON_CONFORME',
                    richiestaId: qualitaRecuperata?.richiestaId ?? null, diagnosticaDeparture });
                  continue;
                }
                valide.push({ indice: i, sequenzaIndice: j, combinazione,
                  sequenza: sequenzaStradale, itinerario: itinerarioRecuperato,
                  temporale: temporaleRecuperato, qualita: qualitaRecuperata,
                  sequenziamento: stradali.diagnostica,
                  kmMissione: itinerarioRecuperato.kmTotali,
                  recuperataDeparture: true,
                  diagnosticaDeparture,
                  stato: 'DA_VALIDARE_ECONOMIA', attivabile: false });
                departureShadow.recuperateValidate++;
                continue;
              } catch (error) {
  departureShadow.recuperiRifiutati++;
  departureShadow.recuperiRifiutatiErrore++;

  scartate.push({ indice: i, sequenzaIndice: j, fase: 'RECUPERO_DEPARTURE',
                  motivo: 'ERRORE_RICALCOLO', errore: error.message, diagnosticaDeparture });
                continue;
              }
            }
            scartate.push({ indice: i, sequenzaIndice: j, fase: 'TEMPORALE',
              motivo: temporale.motivo, richiestaId: temporale.richiestaId,
              ...(diagnosticaDeparture ? { diagnosticaDeparture } : {}) });
            continue;
          }
          const qualita = verificaQualitaFermate({ itinerario, richieste });
          if (!qualita.ok) {
            scartate.push({ indice: i, sequenzaIndice: j, fase: 'QUALITA',
              motivo: qualita.motivo ?? 'NON_CONFORME', richiestaId: qualita.richiestaId ?? null });
            continue;
          }
          valide.push({ indice: i, sequenzaIndice: j, combinazione,
            sequenza: sequenzaStradale, itinerario, temporale, qualita,
            sequenziamento: stradali.diagnostica,
            kmMissione: itinerario.kmTotali,
            stato: 'DA_VALIDARE_ECONOMIA', attivabile: false });
        } catch (error) {
          scartate.push({ indice: i, sequenzaIndice: j, fase: 'ERRORE_SEQUENZA',
            motivo: error.message });
        }
      }
    } catch (error) {
      scartate.push({
        indice: i,
        fase: 'ERRORE',
        motivo: error.message
      });
    }
  }

  // Ordinamento provvisorio:
  // nessuna pretesa di ottimizzazione economica.
  valide.sort((a, b) =>
    a.kmMissione - b.kmMissione ||
    a.combinazione.scorePreliminare -
      b.combinazione.scorePreliminare
  );

  return {
    ok: true,
    stato: 'VALUTAZIONE_PRELIMINARE',
    valide,
    scartate,
    diagnostica: {
      combinazioniRicevute: combinazioni.length,
      combinazioniValutate: daValutare.length,
      combinazioniNonValutate:
        combinazioni.length - daValutare.length,
      preliminarmenteValide: valide.length,
      scartate: scartate.length,
      ...(departureShadowEnabled ? { departureShadow, departureApplyEnabled } : {}),
      valutazioneCompleta:
        combinazioni.length <= maxValutazioni,
      sequenziamentoEsaustivo: combinazioni.length <= maxValutazioni &&
        !scartate.some(s => s.fase === 'SEQUENZIAMENTO' && s.motivo === 'RICERCA_INCOMPLETA') &&
        valide.every(v => v.sequenziamento.ricercaEsaustiva === true)
    },
    attivabile: false
  };
}