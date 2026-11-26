import {
  finestraServizioNcc
} from './ncc-schedulazione-temporale.service.js';

export const NCC_ADATTIVA_VERSION = '2.8.0';

export async function diagnosticaConflittiNcc({
  proposte,
  missioni,
  veicoli,
  tratta,
  verificaAttiva = () => {},
  maxConfronti = 100
}) {
  const assegnate = new Set(
    missioni.flatMap(m =>
      m.gruppi.flatMap(g =>
        g.prenotazioni.map(String)
      )
    )
  );

  const esclusi = proposte.filter(g =>
    g.prenotazioni.every(id =>
      !assegnate.has(String(id))
    )
  );

  const compatibili = g =>
    veicoli.filter(v =>
      Number(v.posti_totali) >=
      Number(g.piccoPasseggeri)
    ).map(v => String(v.id));

  const origine = g =>
    g.itinerario.fermate[0].localita;

  const destinazione = g =>
    g.itinerario.fermate.at(-1).localita;

  const report = {
    versione: NCC_ADATTIVA_VERSION,
    modalita: 'SOLO_DIAGNOSTICA',
    gruppiEsclusi: esclusi.length,
    confronti: 0,
    limiteRaggiunto: false,
    conflitti: [],
    nonVerificati: [],
    candidatiDisaggregazione: []
  };

  const candidati = new Map();

  function aggiungiCandidato(g) {
    if (g.prenotazioni.length < 2) return;

    const ids = g.prenotazioni.map(String).sort();

    candidati.set(ids.join(','), {
      prenotazioni: ids,
      piccoPasseggeri: g.piccoPasseggeri
    });
  }

  for (const a of esclusi) {
    verificaAttiva();

    const va = compatibili(a);

    if (!va.length) {
      report.conflitti.push({
        codice: 'CAPACITA_ASSOLUTA',
        prenotazioni: a.prenotazioni,
        piccoPasseggeri: a.piccoPasseggeri
      });

      aggiungiCandidato(a);
      continue;
    }

    for (const b of proposte) {
      verificaAttiva();

      if (a === b) continue;

      const idsA = new Set(
        a.prenotazioni.map(String)
      );

      if (b.prenotazioni.some(id =>
        idsA.has(String(id))
      )) continue;

      const vb = compatibili(b);

      // Certificato limitato ai gruppi
      // che richiedono lo stesso unico veicolo.

      if (
        va.length !== 1 ||
        vb.length !== 1 ||
        va[0] !== vb[0]
      ) continue;

      const fa = finestraServizioNcc(a);
      const fb = finestraServizioNcc(b);

      if (!fa || !fb) {
        report.nonVerificati.push({
          codice: 'FINESTRA_NON_VALIDA',
          gruppoA: a.prenotazioni,
          gruppoB: b.prenotazioni
        });
        continue;
      }

      if (report.confronti >= maxConfronti) {
        report.limiteRaggiunto = true;
        break;
      }

      report.confronti++;

      const disponibileAB =
        fb.massimo - fa.minimo - fa.durataMs;

      const disponibileBA =
        fa.massimo - fb.minimo - fb.durataMs;

      const ab = disponibileAB >= 0
        ? await tratta(
            destinazione(a),
            origine(b)
          )
        : null;

      verificaAttiva();

      const ba = disponibileBA >= 0
        ? await tratta(
            destinazione(b),
            origine(a)
          )
        : null;

      verificaAttiva();

      const valido = t =>
        Number.isSafeInteger(t?.durataMs) &&
        t.durataMs >= 0;

      const impossibileAB =
        disponibileAB < 0 ||
        (valido(ab) &&
          ab.durataMs > disponibileAB);

      const impossibileBA =
        disponibileBA < 0 ||
        (valido(ba) &&
          ba.durataMs > disponibileBA);

      if (
        (disponibileAB >= 0 && !valido(ab)) ||
        (disponibileBA >= 0 && !valido(ba))
      ) {
        report.nonVerificati.push({
          codice: 'ROUTING_NON_DISPONIBILE',
          gruppoA: a.prenotazioni,
          gruppoB: b.prenotazioni
        });
      }

      if (!impossibileAB || !impossibileBA) {
        continue;
      }

      report.conflitti.push({
        codice: 'CONFLITTO_FLOTTA',
        veicoloId: va[0],
        gruppoA: {
          prenotazioni: a.prenotazioni,
          passeggeri: a.piccoPasseggeri
        },
        gruppoB: {
          prenotazioni: b.prenotazioni,
          passeggeri: b.piccoPasseggeri
        },
        direzioneAB: {
          disponibileMs: disponibileAB,
          trasferimentoMs: ab?.durataMs ?? null,
          deficitMs: valido(ab)
            ? Math.max(
                0,
                ab.durataMs - disponibileAB
              )
            : null
        },
        direzioneBA: {
          disponibileMs: disponibileBA,
          trasferimentoMs: ba?.durataMs ?? null,
          deficitMs: valido(ba)
            ? Math.max(
                0,
                ba.durataMs - disponibileBA
              )
            : null
        }
      });

      aggiungiCandidato(a);
      aggiungiCandidato(b);
    }

    if (report.limiteRaggiunto) break;
  }

  report.candidatiDisaggregazione =
    [...candidati.values()];

  return report;
}