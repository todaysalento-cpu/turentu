// TURENTU POPBUS V2
// Routing operativo tra fermate fisiche.
// Nessuna scrittura DB, nessuna attivazione.

import { leg } from './planner.js';
import polyline from 'polyline';

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

// Tolleranza geometrica provvisoria, coerente con il controllo PIXEL-FIRST.
// NON certifica l'accessibilita' stradale o la sicurezza della fermata.
const MAX_DISTANZA_ANCORAGGIO_METRI = 250;

function distanzaMetri(a, b) {
  const toRad = value => Number(value) * Math.PI / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLon = toRad(Number(b.lon) - Number(a.lon));
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function verificaGeometriaStradale(segmento, from, to) {
  let punti;
  try {
    punti = polyline.decode(segmento.polyline);
  } catch {
    fail('polilinea stradale malformata');
  }

  if (!Array.isArray(punti) || punti.length < 2 ||
      punti.some(p => !Array.isArray(p) || p.length < 2 ||
        !validPoint({ lat: p[0], lon: p[1] }))) {
    fail('polilinea stradale malformata');
  }

  const primo = { lat: punti[0][0], lon: punti[0][1] };
  const ultimo = { lat: punti.at(-1)[0], lon: punti.at(-1)[1] };

  if (distanzaMetri(primo, from) > MAX_DISTANZA_ANCORAGGIO_METRI ||
      distanzaMetri(ultimo, to) > MAX_DISTANZA_ANCORAGGIO_METRI) {
    fail('polilinea non ancorata alle fermate');
  }
}

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

        verificaGeometriaStradale(segmento, precedente, visita);
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
    // Propaga il picco gia' verificato dal sequenziatore: il routing non lo ricalcola.
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
