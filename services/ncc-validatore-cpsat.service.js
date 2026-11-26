
import assert from 'node:assert/strict';

import {
  finestraServizioNcc,
  traslaServizioNcc
} from './ncc-schedulazione-temporale.service.js';

export const NCC_VALIDATORE_CPSAT_VERSION =
  '2.8.6e.1';

export function validaSoluzioneCpsatNcc({
  catalogo: d,
  risultato: r,
  verificaAttiva = () => {}
}) {

  verificaAttiva();

  assert.ok(d);
  assert.ok(r);

  assert.equal(
    r.stato,
    'SOLUZIONE_DISPONIBILE'
  );

  const sol = r.soluzione;

  assert.ok(sol);

  assert.ok(Array.isArray(sol.servizi));
  assert.ok(Array.isArray(sol.archi));

  assert.ok(
    Array.isArray(sol.prenotazioniAssegnate)
  );

  assert.ok(
    Array.isArray(sol.prenotazioniEscluse)
  );

  assert.ok(Array.isArray(d.prenotazioni));
  assert.ok(Array.isArray(d.servizi));
  assert.ok(Array.isArray(d.veicoli));

  assert.ok(Array.isArray(d.matrice?.trasferimenti));
  assert.ok(Array.isArray(d.matrice?.posizionamenti));
  assert.ok(Array.isArray(d.matrice?.rientri));

  assert.ok(Number.isFinite(sol.costoEuro));
  assert.ok(sol.costoEuro >= 0);

  assert.ok(Number.isFinite(sol.kmTotali));
  assert.ok(sol.kmTotali >= 0);

  assert.ok(Number.isSafeInteger(sol.missioni));
  assert.ok(Number.isSafeInteger(sol.veicoli));

  const servizi = new Map(
    d.servizi.map(s => [s.id, s])
  );

  const assegnate = new Set();
  const serviziUsati = new Set();
  const missioni = [];

  const DAY = d.durataGiornoMs ?? 86400000;

  assert.ok(
    [82800000, 86400000, 90000000]
      .includes(DAY)
  );

  assert.ok(Number.isSafeInteger(d.riferimento));

  const serviziTraslati = [];

  let costoSolverEuro = 0;
  let ricaviCompleti = true;

  const maxAttesa = d.vincoli.attesaMassimaMs;
  const maxDurata = d.vincoli.durataMassimaMissioneMs;

  assert.ok(Number.isSafeInteger(maxAttesa));
  assert.ok(Number.isSafeInteger(maxDurata));
  assert.ok(maxAttesa >= 0);
  assert.ok(maxDurata > 0);

  const firma = ids =>
    JSON.stringify(ids.map(String).sort());

  const idsInput = d.prenotazioni.map(
    p => String(p.id)
  );

  assert.equal(
    new Set(idsInput).size,
    idsInput.length
  );

  const originali = new Set(idsInput);

  const veicoli = new Map(
    d.veicoli.map(v => [v.id, v])
  );

  assert.equal(servizi.size, d.servizi.length);
  assert.equal(veicoli.size, d.veicoli.length);

  for (const v of d.veicoli) {
    assert.ok(Number.isFinite(v.costoKm));
    assert.ok(v.costoKm >= 0);
    assert.ok(Number.isSafeInteger(v.posti));
    assert.ok(v.posti > 0);
  }

  for (const s of sol.servizi) {
    verificaAttiva();
    assert.ok(servizi.has(s.servizio));
    assert.ok(veicoli.has(s.veicolo));

    assert.ok(!serviziUsati.has(s.servizio));
    serviziUsati.add(s.servizio);

    const c = servizi.get(s.servizio);
    const v = veicoli.get(s.veicolo);

    assert.ok(
      c.veicoliCompatibili.includes(v.id)
    );

    assert.ok(Number.isSafeInteger(c.piccoPasseggeri));
    assert.ok(c.piccoPasseggeri > 0);
    assert.ok(c.piccoPasseggeri <= v.posti);

    assert.ok(Number.isSafeInteger(c.durataMs));
    assert.ok(c.durataMs > 0);

    assert.ok(Number.isSafeInteger(c.distanzaMetri));
    assert.ok(c.distanzaMetri >= 0);

    assert.ok(Number.isSafeInteger(s.partenzaMissioneMs));

    assert.ok(
      c.ricaviCentesimi === null ||
      (
        Number.isSafeInteger(c.ricaviCentesimi) &&
        c.ricaviCentesimi >= 0
      )
    );

    assert.deepEqual(
      firma(s.prenotazioni),
      firma(c.prenotazioni)
    );

    assert.ok(Number.isSafeInteger(s.inizioMs));
    assert.ok(Number.isSafeInteger(s.fineMs));

    assert.ok(s.inizioMs >= c.inizioMinimoMs);
    assert.ok(s.inizioMs <= c.inizioMassimoMs);

    assert.equal(
      s.fineMs,
      s.inizioMs + c.durataMs
    );

    assert.ok(s.inizioMs >= 0);
    assert.ok(s.fineMs < DAY);

    assert.ok(c.prenotazioni.length > 0);

    assert.equal(
      new Set(c.prenotazioni).size,
      c.prenotazioni.length
    );

    assert.equal(
      firma(c.proposta.prenotazioni),
      firma(c.prenotazioni)
    );

    const finestra =
      finestraServizioNcc(c.proposta);

    assert.ok(finestra, 'FINESTRA_ORIGINALE_INVALIDA');

    assert.equal(
      finestra.durataMs,
      c.durataMs
    );

    assert.equal(
      Math.round(c.proposta.itinerario.km * 1000),
      c.distanzaMetri
    );

    const traslato = traslaServizioNcc(
      structuredClone(c.proposta),
      d.riferimento + s.inizioMs,
      { verificaAttiva }
    );

    assert.ok(
      traslato,
      'NCC_VALIDATORE_TRASLAZIONE_INVALIDA'
    );

    assert.equal(
      Date.parse(traslato.inizio),
      d.riferimento + s.inizioMs
    );

    assert.equal(
      Date.parse(traslato.fine),
      d.riferimento + s.fineMs
    );

    serviziTraslati.push({
      servizio: s.servizio,
      veicolo: s.veicolo,
      proposta: traslato
    });

    for (const id of c.prenotazioni) {
      assert.ok(originali.has(id));

      assert.ok(
        !assegnate.has(id),
        'PRENOTAZIONE DUPLICATA: ' + id
      );

      assegnate.add(id);
    }
  }

  const archiUsati = new Set();

  let metriTotali = 0;
  let metriVuoto = 0;
  let costoEuro = 0;

  for (const v of d.veicoli) {
    verificaAttiva();

    const lista = sol.servizi
      .filter(s => s.veicolo === v.id)
      .sort((a, b) => a.inizioMs - b.inizioMs);

    if (!lista.length) continue;

    let missione = null;
    let precedente = null;

    function aggiungiTratta(t, vuoto = true) {
      assert.ok(t, 'TRATTA MANCANTE');

      assert.ok(
        Number.isSafeInteger(t.distanzaMetri)
      );

      assert.ok(
        Number.isSafeInteger(t.durataMs)
      );

      assert.ok(t.distanzaMetri >= 0);
      assert.ok(t.durataMs >= 0);

      missione.metri += t.distanzaMetri;

      if (vuoto) {
        missione.metriVuoto += t.distanzaMetri;
      }
    }

    function chiudiMissione(ultimo) {
      const ret = d.matrice.rientri.find(t =>
        t.veicolo === v.id &&
        t.servizio === ultimo.servizio
      );

      aggiungiTratta(ret);

      missione.fineMs =
        ultimo.fineMs + ret.durataMs;

      missione.durataMs =
        missione.fineMs - missione.inizioMs;

      assert.ok(missione.fineMs < DAY);
      assert.ok(missione.durataMs <= maxDurata);

      missione.costoEuro =
        missione.metri / 1000 * v.costoKm;

      missione.costoSolverEuro =
        missione.metri *
        Math.round(v.costoKm * 1000) /
        1000000;

      costoSolverEuro += missione.costoSolverEuro;

      metriTotali += missione.metri;
      metriVuoto += missione.metriVuoto;
      costoEuro += missione.costoEuro;

      missioni.push(missione);

      const fine = missione.fineMs;

      missione = null;

      return fine;
    }

    for (let i = 0; i < lista.length; i++) {
      verificaAttiva();

      const s = lista[i];
      const c = servizi.get(s.servizio);

      assert.equal(s.primo, i === 0);
      assert.equal(s.ultimo, i === lista.length - 1);

      let arco = null;

      if (precedente) {
        const matches = sol.archi.filter(a =>
          a.veicolo === v.id &&
          a.da === precedente.servizio &&
          a.a === s.servizio
        );

        assert.equal(matches.length, 1);

        arco = matches[0];

        archiUsati.add(arco);

        assert.ok(
          ['DIRECT', 'BASE'].includes(arco.tipo)
        );
      }

      if (!precedente || arco.tipo === 'BASE') {
        const finePrecedente = precedente
          ? chiudiMissione(precedente)
          : 0;

        const pos = d.matrice.posizionamenti.find(t =>
          t.veicolo === v.id &&
          t.servizio === s.servizio
        );

        assert.ok(pos);

        const partenza = s.inizioMs - pos.durataMs;

        assert.ok(partenza >= finePrecedente);

        assert.equal(
          s.partenzaMissioneMs,
          partenza
        );

        missione = {
          veicolo: v.id,
          inizioMs: partenza,
          fineMs: null,
          servizi: [],
          prenotazioni: [],
          metri: 0,
          metriVuoto: 0,
          attesaMs: 0,
          ricaviCentesimi: 0
        };

        aggiungiTratta(pos);

      } else {
        const t = d.matrice.trasferimenti.find(t =>
          t.da === precedente.servizio &&
          t.a === s.servizio
        );

        assert.ok(t);

        const attesa =
          s.inizioMs -
          precedente.fineMs -
          t.durataMs;

        assert.ok(attesa >= 0);
        assert.ok(attesa <= maxAttesa);

        assert.equal(
          s.partenzaMissioneMs,
          missione.inizioMs
        );

        missione.attesaMs += attesa;

        aggiungiTratta(t);
      }

      missione.servizi.push(s.servizio);

      missione.prenotazioni.push(
        ...c.prenotazioni
      );

      if (c.ricaviCentesimi === null) {
        ricaviCompleti = false;
        missione.ricaviCentesimi = null;
      } else if (missione.ricaviCentesimi !== null) {
        missione.ricaviCentesimi += c.ricaviCentesimi;
      }

      aggiungiTratta({
        distanzaMetri: c.distanzaMetri,
        durataMs: c.durataMs
      }, false);

      precedente = s;
    }

    if (missione) {
      chiudiMissione(precedente);
    }
  }

  assert.equal(
    archiUsati.size,
    sol.archi.length
  );

  assert.equal(missioni.length, sol.missioni);

  assert.equal(
    new Set(missioni.map(m => m.veicolo)).size,
    sol.veicoli
  );

  assert.deepEqual(
    firma([...assegnate]),
    firma(sol.prenotazioniAssegnate)
  );

  const escluse = idsInput.filter(
    id => !assegnate.has(id)
  );

  assert.deepEqual(
    firma(escluse),
    firma(sol.prenotazioniEscluse)
  );

  assert.equal(
    assegnate.size + escluse.length,
    idsInput.length
  );

  assert.equal(
    assegnate.size,
    sol.prenotazioniAssegnate.length
  );

  assert.equal(
    escluse.length,
    sol.prenotazioniEscluse.length
  );

  assert.ok(
    Math.abs(
      metriTotali / 1000 - sol.kmTotali
    ) < 0.000001
  );

  assert.ok(
    Math.abs(costoSolverEuro - sol.costoEuro)
      < 0.000001
  );

  const ricavi = ricaviCompleti
    ? missioni.reduce(
        (s, m) => s + m.ricaviCentesimi,
        0
      ) / 100
    : null;


  verificaAttiva();

  return {
    versione: NCC_VALIDATORE_CPSAT_VERSION,
    modalita: 'VALIDAZIONE_LOGISTICA',
    valida: true,
    approvabile: false,

    missioni,
    serviziTraslati,

    prenotazioniAssegnate: [...assegnate],
    escluse,

    metriTotali,
    metriVuoto,

    kmTotali: metriTotali / 1000,
    kmVuoto: metriVuoto / 1000,

    costoEuro,
    costoSolverEuro,

    ricaviCompleti,
    ricavi,

    margineEuro:
      ricavi === null
        ? null
        : ricavi - costoEuro,

    audit: {
      univocitaPrenotazioni: true,
      coperturaCoerente: true,
      capienzaCatalogoVerificata: true,
      finestreTemporaliVerificate: true,
      traslazioneServiziVerificata: true,
      trasferimentiVerificati: true,
      atteseVerificate: true,
      durataMissioniVerificata: true,
      sovrapposizioniVerificate: true,
      costiVerificati: true,

      vincoliPrenotazioniOriginaliVerificati: false,
      vincoliVoliVerificati: false,
      caricoFermateVerificato: false,
      bagagliVerificati: false,
      disponibilitaOrariaVerificata: false,
      disponibilitaConducentiVerificata: false
    }
  };
}
