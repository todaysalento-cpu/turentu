// TURENTU POPBUS V2
// Compatibilita temporale alle fermate fisiche.
// Nessuna scrittura DB. Nessuna attivazione.

import { TOLLERANZA_MS } from './model.js';

const fail = message => {
  throw new Error(`POPBUS_STOP_TEMPORAL: ${message}`);
};

function toMillis(value) {
  if (value instanceof Date) return value.getTime();

  if (typeof value === 'number') return value;

  if (typeof value === 'string' && value.trim()) {
    return new Date(value).getTime();
  }

  return NaN;
}

export function verificaCompatibilitaTemporaleFermate({
  itinerario,
  richieste,
  tolleranzaMs = TOLLERANZA_MS
}) {
  if (!itinerario?.ok ||
      !Array.isArray(itinerario.visite) ||
      !itinerario.visite.length) {
    fail('itinerario non valido');
  }

  if (!Array.isArray(richieste) || !richieste.length) {
    fail('richieste non valide');
  }

  if (!Number.isFinite(tolleranzaMs) || tolleranzaMs < 0) {
    fail('tolleranza non valida');
  }

  const byId = new Map();

  for (const r of richieste) {
    const id = Number(r.id);

    if (!Number.isSafeInteger(id) || id <= 0 || byId.has(id)) {
      fail('ID richiesta duplicato o non valido');
    }

    const desiderato = toMillis(r.start_datetime);

    if (!Number.isFinite(desiderato)) {
      fail(`orario richiesta non valido: ${id}`);
    }

    byId.set(id, {
      richiestaId: id,
      desiderato
    });
  }

  const salite = new Map();

  for (const visita of itinerario.visite) {
    if (!Number.isFinite(visita.arrivo) ||
        !Array.isArray(visita.eventi)) {
      fail('visita temporale non valida');
    }

    for (const evento of visita.eventi) {
      if (evento.tipo !== 'salita') continue;

      const id = Number(evento.richiesta_id);

      if (!byId.has(id)) {
        fail(`richiesta non presente: ${id}`);
      }

      if (salite.has(id)) {
        fail(`salita duplicata: ${id}`);
      }

      const effettivo = evento.timestampOperazione;

      if (!Number.isFinite(effettivo)) {
        fail(`timestamp salita non valido: ${id}`);
      }

      salite.set(id, {
        richiestaId: id,
        fermataId: Number(visita.fermata_id),
        desiderato: byId.get(id).desiderato,
        effettivo,
        differenzaMinuti:
          (effettivo - byId.get(id).desiderato) / 60000
      });
    }
  }

  const dettagli = [];

  for (const [id, richiesta] of byId) {
    const salita = salite.get(id);

    if (!salita) {
      return {
        ok: false,
        motivo: 'SALITA_MANCANTE',
        richiestaId: id,
        dettagli
      };
    }

    const compatibile =
      Math.abs(salita.effettivo - richiesta.desiderato) <=
      tolleranzaMs;

    dettagli.push({
      ...salita,
      compatibile
    });
  }

  const incompatibile = dettagli.find(x => !x.compatibile);

  if (incompatibile) {
    return {
      ok: false,
      motivo: 'SALITA_FUORI_TOLLERANZA',
      richiestaId: incompatibile.richiestaId,
      dettagli
    };
  }

  return {
    ok: true,
    stato: 'COMPATIBILITA_TEMPORALE_PRELIMINARE',
    tolleranzaMinuti: tolleranzaMs / 60000,
    dettagli,
    attivabile: false
  };
}