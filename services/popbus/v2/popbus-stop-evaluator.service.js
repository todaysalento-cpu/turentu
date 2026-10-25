
import { costruisciSequenzaFermate } from './popbus-stop-itinerary.service.js';
import { calcolaRoutingFermate } from './popbus-stop-routing.service.js';
import { verificaCompatibilitaTemporaleFermate } from './popbus-stop-temporal.service.js';
import { verificaQualitaFermate } from './popbus-stop-quality.service.js';

const fail = message => {
  throw new Error(`POPBUS_STOP_EVALUATOR: ${message}`);
};

export async function valutaCombinazioniFermate({
  combinazioni,
  richieste,
  postiTotali,
  departure,
  routing,
  maxValutazioni = 100
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
        postiTotali
      });

      if (!sequenza.ok) {
        scartate.push({
          indice: i,
          fase: 'SEQUENZA',
          motivo: sequenza.motivo ?? 'NON_AMMISSIBILE'
        });
        continue;
      }

      const itinerario = await calcolaRoutingFermate({
        sequenza,
        departure,
        ...(routing ? { routing } : {})
      });

      if (!itinerario.ok) {
        scartate.push({
          indice: i,
          fase: 'ROUTING',
          motivo: itinerario.motivo ?? 'NON_AMMISSIBILE'
        });
        continue;
      }

      const temporale = verificaCompatibilitaTemporaleFermate({
        itinerario,
        richieste
      });

      if (!temporale.ok) {
        scartate.push({
          indice: i,
          fase: 'TEMPORALE',
          motivo: temporale.motivo,
          richiestaId: temporale.richiestaId
        });
        continue;
      }

      const qualita = verificaQualitaFermate({
        itinerario,
        richieste
      });

      if (!qualita.ok) {
        scartate.push({
          indice: i,
          fase: 'QUALITA',
          motivo: qualita.motivo ?? 'NON_CONFORME',
          richiestaId: qualita.richiestaId ?? null
        });
        continue;
      }

      valide.push({
        indice: i,
        combinazione,
        sequenza,
        itinerario,
        temporale,
        qualita,
        kmMissione: itinerario.kmTotali,
        stato: 'DA_VALIDARE_ECONOMIA',
        attivabile: false
      });
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
      valutazioneCompleta:
        combinazioni.length <= maxValutazioni
    },
    attivabile: false
  };
}
