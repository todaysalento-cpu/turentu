// TURENTU POPBUS V2
// Routing operativo tra fermate fisiche.
// Nessuna scrittura DB, nessuna attivazione.

import { leg } from './planner.js';

const fail = message => {
  throw new Error(`POPBUS_STOP_ROUTING: ${message}`);
};

const validTime = value =>
  typeof value === 'number' && Number.isFinite(value);

const validPoint = p =>
  p &&
  Number.isFinite(Number(p.lat)) &&
  Number.isFinite(Number(p.lon)) &&
  Math.abs(Number(p.lat)) <= 90 &&
  Math.abs(Number(p.lon)) <= 180;

const samePoint = (a, b) =>
  Math.abs(Number(a.lat) - Number(b.lat)) < 1e-7 &&
  Math.abs(Number(a.lon) - Number(b.lon)) < 1e-7;

export async function calcolaRoutingFermate({
  sequenza,
  departure,
  sostaBaseSecondi = 30,
  sostaPerPasseggeroSecondi = 10,
  routing = leg
}) {
  if (!sequenza?.ok ||
      !Array.isArray(sequenza.visite) ||
      sequenza.visite.length < 2) {
    fail('sequenza fermate non valida');
  }

  if (!validTime(departure)) {
    fail('departure non valido');
  }

  if (!Number.isFinite(sostaBaseSecondi) ||
      sostaBaseSecondi < 0 ||
      !Number.isFinite(sostaPerPasseggeroSecondi) ||
      sostaPerPasseggeroSecondi < 0) {
    fail('parametri di sosta non validi');
  }

  if (typeof routing !== 'function') {
    fail('funzione routing non valida');
  }

  const visite = [];
  const legs = [];

  let currentTime = departure;
  let metriTotali = 0;
  let secondiViaggio = 0;
  let secondiSosta = 0;

  for (let i = 0; i < sequenza.visite.length; i++) {
    const visita = sequenza.visite[i];

    if (!validPoint(visita) ||
        !Array.isArray(visita.eventi) ||
        !visita.eventi.length) {
      fail('visita non valida');
    }

    if (i > 0) {
      const precedente = sequenza.visite[i - 1];

      let segmento;

      if (samePoint(precedente, visita)) {
        segmento = {
          metres: 0,
          seconds: 0,
          polyline: null,
          coincidente: true
        };
      } else {
        segmento = await routing(precedente, visita);

        if (!Number.isFinite(Number(segmento?.metres)) ||
            !Number.isFinite(Number(segmento?.seconds)) ||
            Number(segmento.metres) < 0 ||
            Number(segmento.seconds) < 0 ||
            typeof segmento.polyline !== 'string' ||
            !segmento.polyline.length) {
          fail('segmento stradale non valido');
        }
      }

      legs.push({
        from_visita_id: precedente.visita_id,
        to_visita_id: visita.visita_id,
        ...segmento
      });

      metriTotali += Number(segmento.metres);
      secondiViaggio += Number(segmento.seconds);
      currentTime += Number(segmento.seconds) * 1000;
    }

    const arrivo = currentTime;

    const passeggeriMovimentati = visita.eventi.reduce(
      (totale, evento) => {
        const posti = Number(evento.posti);

        if (!Number.isSafeInteger(posti) || posti <= 0) {
          fail('posti evento non validi');
        }

        return totale + posti;
      },
      0
    );

    const sostaSecondi =
      sostaBaseSecondi +
      passeggeriMovimentati * sostaPerPasseggeroSecondi;

    const partenza = arrivo + sostaSecondi * 1000;

    visite.push({
      ...visita,
      arrivo,
      partenza,
      sostaSecondi,
      eventi: visita.eventi.map(evento => ({
        ...evento,
        timestampOperazione: arrivo
      }))
    });

    secondiSosta += sostaSecondi;
    currentTime = partenza;
  }

  return {
    ok: true,
    stato: 'ROUTING_CALCOLATO',
    // Propaga il picco già verificato dal sequenziatore: il routing non lo ricalcola.
    peak: sequenza.peak,
    postiTotali: sequenza.postiTotali,
    capienzaVerificata: sequenza.capienzaVerificata === true,
    departure,
    arrival: visite.at(-1).arrivo,
    fineOperazioni: currentTime,
    visite,
    legs,
    metriTotali,
    kmTotali: metriTotali / 1000,
    secondiViaggio,
    secondiSosta,
    routingVerificato: true,
    qualitaVerificata: false,
    attivabile: false
  };
}