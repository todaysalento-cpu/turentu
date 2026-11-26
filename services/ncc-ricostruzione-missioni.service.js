import assert from 'node:assert/strict';

export const NCC_RICOSTRUZIONE_VERSION = '2.8.6f';

export function ricostruisciMissioniCpsatNcc({
  catalogo,
  risultato,
  validazione,
  giorno,
  prenotazioniIndicative = [],
  verificaAttiva = () => {}
}) {

  verificaAttiva();

  function verifica(condizione, motivo) {
    assert.ok(
      condizione,
      'NCC_RICOSTRUZIONE_' + motivo
    );
  }

  const somma = (array, fn) =>
    array.reduce((s, x) => s + fn(x), 0);

  const firma = ids =>
    JSON.stringify(ids.map(String).sort());

  const chiave = (...args) =>
    JSON.stringify(args.map(String));

  const vicino = (a, b) =>
    Math.abs(a - b) < 0.000001;

  verifica(
    validazione?.valida === true &&
    validazione.audit
      ?.vincoliPrenotazioniOriginaliVerificati === true,
    'VALIDAZIONE_INCOMPLETA'
  );

  verifica(
    risultato?.stato === 'SOLUZIONE_DISPONIBILE',
    'SOLUZIONE_NON_DISPONIBILE'
  );

  verifica(
    /^\d{4}-\d{2}-\d{2}$/.test(giorno),
    'GIORNO_INVALIDO'
  );

  const riferimento = catalogo.riferimento;

  verifica(
    Number.isSafeInteger(riferimento),
    'RIFERIMENTO_INVALIDO'
  );

  const iso = ms =>
    new Date(riferimento + ms).toISOString();

  const soluzione = risultato.soluzione;

  const indicative = new Set(
    Array.from(prenotazioniIndicative, String)
  );

  function indicizza(array, fn) {

    const m = new Map();

    for (const elemento of array) {

      verificaAttiva();

      const k = fn(elemento);

      verifica(
        !m.has(k),
        'CHIAVE_DUPLICATA'
      );

      m.set(k, elemento);
    }

    return m;
  }

  const flotta = indicizza(
    catalogo.veicoli,
    v => String(v.id)
  );

  const servizi = indicizza(
    catalogo.servizi,
    s => String(s.id)
  );

  const traslati = indicizza(
    validazione.serviziTraslati,
    s => chiave(s.veicolo, s.servizio)
  );

  const selezionati = indicizza(
    soluzione.servizi,
    s => chiave(s.veicolo, s.servizio)
  );

  const archi = indicizza(
    soluzione.archi,
    a => chiave(a.veicolo, a.da, a.a)
  );

  const posizionamenti = indicizza(
    catalogo.matrice.posizionamenti,
    t => chiave(t.veicolo, t.servizio)
  );

  const rientri = indicizza(
    catalogo.matrice.rientri,
    t => chiave(t.veicolo, t.servizio)
  );

  const trasferimenti = indicizza(
    catalogo.matrice.trasferimenti,
    t => chiave(t.da, t.a)
  );

  const missioni = [];

  const assegnate = new Set();
  const serviziUsati = new Set();

  let veicoliRiassegnati = 0;

  function tratta(t) {

    verifica(
      t &&
      Number.isSafeInteger(t.distanzaMetri) &&
      t.distanzaMetri >= 0 &&
      Number.isSafeInteger(t.durataMs) &&
      t.durataMs >= 0,
      'TRATTA_INVALIDA'
    );

    return {
      km: t.distanzaMetri / 1000,
      durataMs: t.durataMs
    };
  }

  for (const m of validazione.missioni) {

    verificaAttiva();

    const v = flotta.get(String(m.veicolo));

    verifica(v, 'VEICOLO_NON_TROVATO');

    verifica(
      Number.isFinite(v.costoKm) &&
      v.costoKm >= 0,
      'COSTO_VEICOLO_INVALIDO'
    );

    verifica(
      Number.isSafeInteger(v.posti) &&
      v.posti > 0,
      'CAPIENZA_INVALIDA'
    );

    verifica(
      Array.isArray(m.servizi) &&
      m.servizi.length > 0,
      'MISSIONE_VUOTA'
    );

    const veicoloId = v.veicolo.id;

    verifica(
      String(veicoloId) === String(v.id),
      'IDENTITA_VEICOLO'
    );

    const gruppi = [];

    let metriServizio = 0;
    let metriTrasferimenti = 0;
    let durataTrasferimenti = 0;
    let attesaMs = 0;
    let precedente = null;

    for (const sid of m.servizi) {

      verificaAttiva();

      const k = chiave(v.id, sid);

      const c = servizi.get(String(sid));
      const t = traslati.get(k);
      const s = selezionati.get(k);

      verifica(
        c && t && s,
        'SERVIZIO_NON_TROVATO'
      );

      verifica(
        !serviziUsati.has(String(sid)),
        'SERVIZIO_DUPLICATO'
      );

      serviziUsati.add(String(sid));

      const g = structuredClone(t.proposta);

      verifica(
        firma(g.prenotazioni) ===
        firma(c.prenotazioni),
        'IDENTITA_PRENOTAZIONI'
      );

      verifica(
        Date.parse(g.inizio) ===
          riferimento + s.inizioMs &&
        Date.parse(g.fine) ===
          riferimento + s.fineMs,
        'ORARI_INCOERENTI'
      );

      verifica(
        g.piccoPasseggeri <= v.posti,
        'CAPIENZA_SUPERATA'
      );

      for (const id of g.prenotazioni) {

        const key = String(id);

        verifica(
          !assegnate.has(key),
          'PRENOTAZIONE_DUPLICATA'
        );

        assegnate.add(key);
      }

      if (
        String(g.veicoloId) !==
        String(veicoloId)
      ) {
        veicoliRiassegnati++;
      }

      // Aggiornamento del veicolo effettivo.

      g.veicoloId = veicoloId;
      g.posti = v.posti;

      g.riempimento = Math.round(
        g.piccoPasseggeri * 100 / v.posti
      );

      const costoGruppo = Math.round(
        g.itinerario.km * v.costoKm * 100
      );

      const ricaviGruppo =
        c.ricaviCentesimi;

      g.economia = {
        ...g.economia,
        costoKm: v.costoKm,
        ricaviCentesimi: ricaviGruppo,
        costoCentesimi: costoGruppo,
        margineCentesimi:
          ricaviGruppo == null
            ? null
            : ricaviGruppo - costoGruppo
      };

      // Conservazione della geografia indicativa.

      const idsIndicativi = new Set([
        ...(g.prenotazioniIndicative ?? [])
          .map(String),

        ...g.prenotazioni
          .map(String)
          .filter(id => indicative.has(id))
      ]);

      g.prenotazioniIndicative =
        [...idsIndicativi];

      g.geografiaIndicativa =
        g.geografiaIndicativa === true ||
        idsIndicativi.size > 0;

      g.bagagliVerificati = false;
      g.approvabile = false;

      metriServizio += c.distanzaMetri;

      // Trasferimento tra servizi della stessa
      // missione: deve essere DIRECT.

      if (precedente) {

        const arco = archi.get(
          chiave(
            v.id,
            precedente.servizio,
            sid
          )
        );

        verifica(
          arco?.tipo === 'DIRECT',
          'ARCO_INTERNO_NON_DIRETTO'
        );

        const tr = trasferimenti.get(
          chiave(
            precedente.servizio,
            sid
          )
        );

        tratta(tr);

        metriTrasferimenti +=
          tr.distanzaMetri;

        durataTrasferimenti +=
          tr.durataMs;

        const attesa =
          s.inizioMs -
          precedente.fineMs -
          tr.durataMs;

        verifica(
          attesa >= 0,
          'ATTESA_NEGATIVA'
        );

        attesaMs += attesa;
      }

      precedente = s;

      gruppi.push(g);
    }

    const primo = selezionati.get(
      chiave(v.id, m.servizi[0])
    );

    const ultimo = selezionati.get(
      chiave(v.id, m.servizi.at(-1))
    );

    const pos = posizionamenti.get(
      chiave(v.id, m.servizi[0])
    );

    const ret = rientri.get(
      chiave(v.id, m.servizi.at(-1))
    );

    const posizionamento = tratta(pos);
    const riposizionamento = tratta(ret);

    const metriVuoto =
      pos.distanzaMetri +
      metriTrasferimenti +
      ret.distanzaMetri;

    const metriTotali =
      metriServizio + metriVuoto;

    verifica(
      metriVuoto === m.metriVuoto &&
      metriTotali === m.metri,
      'DISTANZE_INCOERENTI'
    );

    verifica(
      primo.inizioMs - pos.durataMs ===
        m.inizioMs &&
      ultimo.fineMs + ret.durataMs ===
        m.fineMs,
      'ESTREMI_MISSIONE_INCOERENTI'
    );

    verifica(
      attesaMs === m.attesaMs,
      'ATTESA_INCOERENTE'
    );

    verifica(
      m.fineMs - m.inizioMs === m.durataMs,
      'DURATA_INCOERENTE'
    );

    const durataServizi = somma(
      gruppi,
      g => Date.parse(g.fine) -
        Date.parse(g.inizio)
    );

    verifica(
      durataServizi +
      pos.durataMs +
      durataTrasferimenti +
      ret.durataMs +
      attesaMs === m.durataMs,
      'COMPONENTI_DURATA_INCOERENTI'
    );

    verifica(
      firma(gruppi.flatMap(
        g => g.prenotazioni
      )) === firma(m.prenotazioni),
      'PRENOTAZIONI_MISSIONE_INCOERENTI'
    );

    const ricavi = gruppi.every(
      g => g.economia.ricaviCentesimi != null
    )
      ? somma(
          gruppi,
          g => g.economia.ricaviCentesimi
        )
      : null;

    verifica(
      ricavi === m.ricaviCentesimi,
      'RICAVI_INCOERENTI'
    );

    const costoEuro =
      metriTotali / 1000 * v.costoKm;

    verifica(
      vicino(costoEuro, m.costoEuro),
      'COSTO_INCOERENTE'
    );

    const costoCentesimi =
      Math.round(costoEuro * 100);

    missioni.push({
      giorno,
      veicoloId,
      posti: v.posti,

      gruppi,

      piccoPasseggeri: Math.max(
        ...gruppi.map(g => g.piccoPasseggeri)
      ),

      passeggeri: somma(
        gruppi,
        g => g.passeggeri
      ),

      durataMs: m.durataMs,
      attesaMs,

      kmTrasferimenti:
        metriTrasferimenti / 1000,

      logistica: {
        base: v.base,

        kmServizio:
          metriServizio / 1000,

        kmVuoto:
          metriVuoto / 1000,

        posizionamento,
        riposizionamento,

        partenzaBase: iso(m.inizioMs),
        arrivoBase: iso(m.fineMs)
      },

      economia: {
        km: metriTotali / 1000,
        costoKm: v.costoKm,
        ricaviCentesimi: ricavi,
        costoCentesimi,

        margineCentesimi:
          ricavi == null
            ? null
            : ricavi - costoCentesimi
      },

      bagagliVerificati: false,
      approvabile: false
    });
  }

  // Ordinamento deterministico.

  missioni.sort((a, b) =>
    Date.parse(a.logistica.partenzaBase) -
    Date.parse(b.logistica.partenzaBase) ||
    String(a.veicoloId).localeCompare(
      String(b.veicoloId)
    )
  );

  // Controllo sovrapposizioni.

  const ultimoRientro = new Map();

  for (const m of missioni) {

    verificaAttiva();

    const id = String(m.veicoloId);

    const partenza =
      Date.parse(m.logistica.partenzaBase);

    const arrivo =
      Date.parse(m.logistica.arrivoBase);

    verifica(
      partenza >=
        (ultimoRientro.get(id) ?? -Infinity),
      'MISSIONI_SOVRAPPOSTE'
    );

    ultimoRientro.set(id, arrivo);
  }

  verifica(
    firma([...assegnate]) ===
    firma(validazione.prenotazioniAssegnate),
    'COPERTURA_INCOERENTE'
  );

  verifica(
    serviziUsati.size ===
      validazione.serviziTraslati.length &&
    serviziUsati.size ===
      soluzione.servizi.length,
    'COPERTURA_SERVIZI_INCOERENTE'
  );

  const costoCentesimi = somma(
    missioni,
    m => m.economia.costoCentesimi
  );

  const ricaviCompleti = missioni.every(
    m => m.economia.ricaviCentesimi != null
  );

  const ricaviCentesimi = ricaviCompleti
    ? somma(
        missioni,
        m => m.economia.ricaviCentesimi
      )
    : null;

  const riepilogo = {
    missioni: missioni.length,

    veicoliUtilizzati: new Set(
      missioni.map(m => String(m.veicoloId))
    ).size,

    serviziAssegnati: serviziUsati.size,

    // Le alternative non selezionate non
    // costituiscono servizi realmente esclusi.
    serviziNonAssegnati: null,

    prenotazioniAssegnate: assegnate.size,

    passeggeri: somma(
      missioni,
      m => m.passeggeri
    ),

    kmServizio: somma(
      missioni,
      m => m.logistica.kmServizio
    ),

    kmVuoto: somma(
      missioni,
      m => m.logistica.kmVuoto
    ),

    kmTotali: somma(
      missioni,
      m => m.economia.km
    ),

    costoCentesimi,

    margineCentesimi:
      ricaviCentesimi == null
        ? null
        : ricaviCentesimi - costoCentesimi,

    missioniSenzaCosto: 0,

    ricaviCentesimi,

    durataMs: somma(
      missioni,
      m => m.durataMs
    ),

    attesaMs: somma(
      missioni,
      m => m.attesaMs
    ),

    prenotazioniNonAssegnate:
      validazione.escluse.length
  };

  verifica(
    vicino(
      riepilogo.kmTotali,
      validazione.kmTotali
    ) &&
    vicino(
      riepilogo.kmVuoto,
      validazione.kmVuoto
    ),
    'TOTALI_KM_INCOERENTI'
  );

  verifica(
    riepilogo.missioni === soluzione.missioni &&
    riepilogo.veicoliUtilizzati ===
      soluzione.veicoli,
    'TOTALI_MISSIONI_INCOERENTI'
  );

  if (ricaviCompleti) {

    verifica(
      vicino(
        ricaviCentesimi / 100,
        validazione.ricavi
      ),
      'TOTALI_RICAVI_INCOERENTI'
    );
  }

  verificaAttiva();

  return {
    versione: NCC_RICOSTRUZIONE_VERSION,
    approvabile: false,

    missioni,
    riepilogo,

    ottimizzazione: {
      algoritmo: 'CP_SAT_ADATTIVO_V286',

      ottimoCompleto:
        risultato.ottimoCompleto,

      obiettivi:
        structuredClone(risultato.obiettivi),

      dopo: {
        prenotazioni: assegnate.size,
        senzaCosto: 0,
        costo: costoCentesimi,
        km: riepilogo.kmTotali,
        kmVuoto: riepilogo.kmVuoto,
        missioni: riepilogo.missioni,
        veicoli: riepilogo.veicoliUtilizzati
      }
    },

    diagnosticaRicostruzione: {
      versione: NCC_RICOSTRUZIONE_VERSION,

      serviziRicostruiti: serviziUsati.size,
      veicoliRiassegnati,

      costoEuroNonArrotondato:
        validazione.costoEuro,

      costoSolverEuro:
        validazione.costoSolverEuro,

      differenzaArrotondamentoEuro:
        costoCentesimi / 100 -
        validazione.costoEuro,

      nuoveRichiesteRouting: 0
    },

    audit: {
      ...validazione.audit,

      missioniRicostruite: true,
      formatoGestionaleRicostruito: true,
      economiaVeicoliAggiornata: true,

      bagagliVerificati: false,
      disponibilitaOrariaVerificata: false,
      disponibilitaConducentiVerificata: false
    }
  };
}