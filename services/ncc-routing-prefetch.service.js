
const MIN = 60000;

const giornoLocale = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Rome',
  dateStyle: 'short'
});

export async function precalcolaTratteNcc(
  proposte,
  veicoli,
  routing,
  parametri = {},
  occupati = new Set(),
  opzioni = {}
) {
  const start = Date.now();

  const maxDurata =
    parametri.durataMassimaMissioneMinuti ?? Infinity;

  const limite = Math.max(
    0,
    Math.min(
      300,
      opzioni.maxTratte ?? 300
    )
  );

  const candidati = new Map();
  const basi = new Map();

  const origine = p =>
    p.itinerario?.fermate?.[0]?.localita ?? p.origine;

  const destinazione = p =>
    p.itinerario?.fermate?.at(-1)?.localita ??
    p.destinazione;

  const picco = p =>
    p.piccoPasseggeri ?? p.passeggeri;

  const servizi = proposte
    .filter(p =>
      Number.isFinite(Date.parse(p.inizio)) &&
      Number.isFinite(Date.parse(p.fine)) &&
      Date.parse(p.fine) > Date.parse(p.inizio) &&
      Number.isFinite(picco(p)) &&
      picco(p) > 0 &&
      Number.isFinite(p.economia?.km) &&
      p.economia.km >= 0 &&
      origine(p) &&
      destinazione(p)
    )
    .map(p => ({
      p,
      inizio: Date.parse(p.inizio),
      fine: Date.parse(p.fine),
      giorno: giornoLocale.format(
        new Date(p.inizio)
      )
    }))
    .filter(s =>
      giornoLocale.format(new Date(s.fine)) ===
        s.giorno &&
      s.fine - s.inizio <= maxDurata * MIN
    )
    .sort((a, b) => a.inizio - b.inizio);

  function aggiungi(a, b, priorita, intervallo = 0) {
    if (!a || !b || a === b) return;

    const id = JSON.stringify([a, b]);

    const esistente = candidati.get(id);

    if (esistente) {
      esistente.frequenza++;

      esistente.priorita = Math.min(
        esistente.priorita,
        priorita
      );

      esistente.intervallo = Math.min(
        esistente.intervallo,
        intervallo
      );

      return;
    }

    candidati.set(id, {
      a,
      b,
      priorita,
      intervallo,
      frequenza: 1
    });
  }

  // Registrazione delle basi operative.
  for (const v of veicoli) {
    let base = v.localita || null;

    if (
      Number.isFinite(v.lat) &&
      Number.isFinite(v.lon) &&
      Math.abs(v.lat) <= 90 &&
      Math.abs(v.lon) <= 180 &&
      (v.lat !== 0 || v.lon !== 0)
    ) {
      base = `__BASE_NCC__${v.lat},${v.lon}`;

      routing.registraCoordinate(base, {
        lat: v.lat,
        lon: v.lon
      });
    }

    basi.set(String(v.id), base);
  }

  // Collegamenti con le basi operative.
  for (const s of servizi) {
    for (const v of veicoli) {
      if (v.posti_totali < picco(s.p)) continue;

      if (
        occupati.has(s.giorno + '/' + v.id)
      ) continue;

      const base = basi.get(String(v.id));

      aggiungi(base, origine(s.p), 0);
      aggiungi(destinazione(s.p), base, 0);
    }
  }

  // Collegamenti tra servizi.
  for (let i = 0; i < servizi.length; i++) {
    const a = servizi[i];

    for (let j = i + 1; j < servizi.length; j++) {
      const b = servizi[j];

      if (a.giorno !== b.giorno) continue;

      const intervallo = b.inizio - a.fine;

      if (intervallo < 0) continue;

      if (
        b.fine - a.inizio > maxDurata * MIN
      ) continue;

      const capienza = Math.max(
        picco(a.p),
        picco(b.p)
      );

      const compatibile = veicoli.some(v =>
        v.posti_totali >= capienza &&
        !occupati.has(a.giorno + '/' + v.id)
      );

      if (!compatibile) continue;

      aggiungi(
        destinazione(a.p),
        origine(b.p),
        1,
        intervallo
      );
    }
  }

  const ordinati = [...candidati.values()]
    .sort((a, b) =>
      a.priorita - b.priorita ||
      b.frequenza - a.frequenza ||
      a.intervallo - b.intervallo
    );

  const selezionati = ordinati.slice(0, limite);

  let riuscite = 0;
  let fallite = 0;

  const gruppi = new Map();

  for (const tratta of selezionati) {
    if (!gruppi.has(tratta.a)) {
      gruppi.set(tratta.a, []);
    }

    gruppi.get(tratta.a).push(tratta);
  }

  // Le richieste con origine comune vengono
  // avviate contemporaneamente per sfruttare
  // il batch automatico del Routing V2.1.
  for (const gruppo of gruppi.values()) {
    const risultati = await Promise.all(
      gruppo.map(t =>
        Promise.resolve()
          .then(() => routing.tratta(t.a, t.b))
          .catch(() => null)
      )
    );

    for (const r of risultati) {
      if (
        Number.isFinite(r?.distanzaKm) &&
        Number.isFinite(r?.durataMs) &&
        r.distanzaKm >= 0 &&
        r.durataMs >= 0
      ) {
        riuscite++;
      } else {
        fallite++;
      }
    }
  }

  return {
    algoritmo: 'NCC_PREFETCH_V22',
    servizi: servizi.length,
    basiDistinte: new Set(
      [...basi.values()].filter(Boolean)
    ).size,
    tratteCandidate: candidati.size,
    tratteSelezionate: selezionati.length,
    tratteRiuscite: riuscite,
    tratteFallite: fallite,
    tratteNonPrecalcolate:
      candidati.size - selezionati.length,
    originiDistinte: gruppi.size,
    limite,
    tempoMs: Date.now() - start
  };
}
