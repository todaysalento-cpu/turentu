// services/popbus/v2/popbus-stop-itinerary.service.js

const fail = message => {
  throw new Error(`POPBUS_STOP_ITINERARY: ${message}`);
};

const validId = value =>
  value != null &&
  value !== '' &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) > 0;

export function costruisciSequenzaFermate({
  assegnazioni,
  postiTotali
}) {
  if (!Array.isArray(assegnazioni) || !assegnazioni.length) {
    fail('assegnazioni assenti');
  }

  if (!Number.isSafeInteger(postiTotali) || postiTotali <= 0) {
    fail('postiTotali non valido');
  }

  const eventi = [];
  const richieste = new Set();

  for (const a of assegnazioni) {
    if (!validId(a.richiesta_id) ||
        richieste.has(Number(a.richiesta_id))) {
      fail('richiesta duplicata o non valida');
    }

    richieste.add(Number(a.richiesta_id));

    const start = Number(a.start_territoriale);
    const end = Number(a.end_territoriale);
    const posti = Number(a.posti_richiesti);

    if (!Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 || end <= start ||
        !Number.isSafeInteger(posti) || posti <= 0) {
      fail('indici territoriali o posti non validi');
    }

    for (const stop of [a.salita, a.discesa]) {
      if (!validId(stop?.fermata_id) ||
          !Number.isFinite(Number(stop.lat)) ||
          !Number.isFinite(Number(stop.lon)) ||
          Math.abs(Number(stop.lat)) > 90 ||
          Math.abs(Number(stop.lon)) > 180) {
        fail('fermata fisica non valida');
      }
    }

    if (Number(a.salita.fermata_id) ===
        Number(a.discesa.fermata_id)) {
      fail('salita e discesa sulla stessa fermata');
    }

    eventi.push({
      richiesta_id: Number(a.richiesta_id),
      tipo: 'salita',
      indiceTerritoriale: start,
      fermata: a.salita,
      posti
    });

    eventi.push({
      richiesta_id: Number(a.richiesta_id),
      tipo: 'discesa',
      indiceTerritoriale: end,
      fermata: a.discesa,
      posti
    });
  }

  // Ordine preliminare: posizione territoriale,
  // poi fermata e tipo di operazione.
  eventi.sort((a, b) =>
    a.indiceTerritoriale - b.indiceTerritoriale ||
    Number(a.fermata.fermata_id) -
      Number(b.fermata.fermata_id) ||
    (a.tipo === 'discesa' ? -1 : 1)
  );

  // Raggruppamento degli eventi sulla stessa fermata
  // e nello stesso indice territoriale.
  const visite = [];

  for (const evento of eventi) {
    const precedente = visite.at(-1);

    if (precedente &&
        precedente.indiceTerritoriale === evento.indiceTerritoriale &&
        precedente.fermata_id === Number(evento.fermata.fermata_id)) {
      precedente.eventi.push(evento);
      continue;
    }

    visite.push({
      visita_id: visite.length + 1,
      fermata_id: Number(evento.fermata.fermata_id),
      indiceTerritoriale: evento.indiceTerritoriale,
      lat: Number(evento.fermata.lat),
      lon: Number(evento.fermata.lon),
      eventi: [evento]
    });
  }

  let occupati = 0;
  let peak = 0;
  const aBordo = new Set();

  for (const visita of visite) {
    // Prima le discese, poi le salite.
    const ordinati = [
      ...visita.eventi.filter(e => e.tipo === 'discesa'),
      ...visita.eventi.filter(e => e.tipo === 'salita')
    ];

    for (const evento of ordinati) {
      if (evento.tipo === 'discesa') {
        if (!aBordo.has(evento.richiesta_id)) {
          fail('discesa prima della salita');
        }

        aBordo.delete(evento.richiesta_id);
        occupati -= evento.posti;
      } else {
        if (aBordo.has(evento.richiesta_id)) {
          fail('salita duplicata');
        }

        aBordo.add(evento.richiesta_id);
        occupati += evento.posti;
      }
    }

    if (occupati < 0 || occupati > postiTotali) {
      fail('capienza non rispettata');
    }

    peak = Math.max(peak, occupati);
    visita.occupatiDopoVisita = occupati;
  }

  if (aBordo.size || occupati !== 0) {
    fail('passeggeri ancora a bordo');
  }

  return {
    ok: true,
    stato: 'SEQUENZA_PRELIMINARE',
    visite,
    peak,
    postiTotali,
    routingVerificato: false,
    qualitaVerificata: false,
    attivabile: false
  };
}