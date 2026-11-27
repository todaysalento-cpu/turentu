// NCC_AUDIT_COMPATIBILITA_CPSAT_V2902E2F1D1

import assert from 'node:assert/strict';

import {
  normalizzaTipoVeicoloNcc,
  normalizzaRestrizioniNcc,
  restrizioniGruppoNcc,
  veicoloCompatibileNcc,
  veicoliCompatibiliNcc
} from './ncc-compatibilita-veicoli.service.js';

export const NCC_AUDIT_COMPATIBILITA_CPSAT_VERSION =
  '2.9.0';

function verifica(condizione, motivo) {
  assert.ok(
    condizione,
    'NCC_AUDIT_CPSAT_' + motivo
  );
}

function firma(ids) {
  return JSON.stringify(ids.map(String).sort());
}

function indicizza(rows, motivo) {
  verifica(Array.isArray(rows), motivo);

  const mappa = new Map();

  for (const row of rows) {
    verifica(
      row && row.id != null &&
      String(row.id).trim().length > 0,
      motivo
    );

    const id = String(row.id);

    verifica(!mappa.has(id), motivo);

    mappa.set(id, row);
  }

  return mappa;
}

function verificaRestrizione(valore) {
  verifica(
    valore === null ||
    (
      Array.isArray(valore) &&
      valore.every(
        tipo => normalizzaTipoVeicoloNcc(tipo) !== null
      )
    ),
    'RESTRIZIONE_INVALIDA'
  );
}

function verificaStessaRestrizione(a, b) {
  verificaRestrizione(a);
  verificaRestrizione(b);

  assert.deepEqual(
    normalizzaRestrizioniNcc(a),
    normalizzaRestrizioniNcc(b),
    'NCC_AUDIT_CPSAT_RESTRIZIONI_ALTERATE'
  );
}

export function creaAuditCompatibilitaCpsatNcc({
  catalogo,
  prenotazioniOriginali,
  veicoliOriginali,
  verificaAttiva = () => {}
}) {
  verificaAttiva();

  const rows = indicizza(
    prenotazioniOriginali,
    'PRENOTAZIONI_ORIGINALI_INVALIDE'
  );

  const flotta = indicizza(
    veicoliOriginali,
    'FLOTTA_ORIGINALE_INVALIDA'
  );

  const rowsCatalogo = indicizza(
    catalogo.prenotazioni,
    'PRENOTAZIONI_CATALOGO_INVALIDE'
  );

  const flottaCatalogo = indicizza(
    catalogo.veicoli,
    'FLOTTA_CATALOGO_INVALIDA'
  );

  assert.equal(
    firma([...rows.keys()]),
    firma([...rowsCatalogo.keys()]),
    'NCC_AUDIT_CPSAT_PRENOTAZIONI_ALTERATE'
  );

  assert.equal(
    firma([...flotta.keys()]),
    firma([...flottaCatalogo.keys()]),
    'NCC_AUDIT_CPSAT_FLOTTA_ALTERATA'
  );

  for (const [id, row] of rows) {
    verificaAttiva();

    const copia = rowsCatalogo.get(id);

    for (const campo of [
      'origineTipiVeicoloAmmessi',
      'destinazioneTipiVeicoloAmmessi'
    ]) {
      verifica(
        Object.hasOwn(row, campo) &&
        Object.hasOwn(copia, campo),
        'RESTRIZIONE_MANCANTE'
      );

      verificaStessaRestrizione(
        row[campo],
        copia[campo]
      );
    }

    const pax = Number(row.passeggeri);

    verifica(
      Number.isSafeInteger(pax) &&
      pax > 0 &&
      pax === Number(copia.passeggeri),
      'PASSEGGERI_ALTERATI'
    );
  }

  for (const [id, originale] of flotta) {
    verificaAttiva();

    const copia = flottaCatalogo.get(id);

    const posti = Number(originale.posti_totali);

    verifica(
      Number.isSafeInteger(posti) &&
      posti > 0 &&
      copia.posti === posti,
      'CAPIENZA_VEICOLO_ALTERATA'
    );

    verifica(
      Object.hasOwn(originale, 'tipo') &&
      Object.hasOwn(copia, 'tipo'),
      'TIPO_VEICOLO_MANCANTE'
    );

    verifica(
      copia.tipo ===
        normalizzaTipoVeicoloNcc(originale.tipo),
      'TIPO_VEICOLO_ALTERATO'
    );
  }

  function verificaServizio({
    servizio,
    veicoloId,
    proposta = servizio?.proposta
  }) {
    verificaAttiva();

    verifica(
      servizio &&
      proposta &&
      Array.isArray(servizio.prenotazioni) &&
      servizio.prenotazioni.length > 0,
      'SERVIZIO_INVALIDO'
    );

    const ids = servizio.prenotazioni.map(String);

    verifica(
      new Set(ids).size === ids.length,
      'PRENOTAZIONI_DUPLICATE'
    );

    verifica(
      Array.isArray(proposta.prenotazioni) &&
      firma(proposta.prenotazioni) === firma(ids),
      'IDENTITA_SERVIZIO_ALTERATA'
    );

    const originali = ids.map(id => {
      const row = rows.get(id);

      verifica(
        row,
        'PRENOTAZIONE_ORIGINALE_MANCANTE'
      );

      return row;
    });

    const restrizioni =
      restrizioniGruppoNcc(originali);

    verificaStessaRestrizione(
      restrizioni,
      servizio.tipiVeicoloAmmessi
    );

    verificaStessaRestrizione(
      restrizioni,
      proposta.tipiVeicoloAmmessi
    );

    const picco = servizio.piccoPasseggeri;

    const passeggeri = originali.map(
      row => Number(row.passeggeri)
    );

    const totale = passeggeri.reduce(
      (somma, pax) => somma + pax,
      0
    );

    verifica(
      Number.isSafeInteger(picco) &&
      picco >= Math.max(...passeggeri) &&
      picco <= totale &&
      picco === proposta.piccoPasseggeri,
      'PICCO_PASSEGGERI_INVALIDO'
    );

    verifica(
      servizio.passeggeri === totale &&
      proposta.passeggeri === totale,
      'TOTALE_PASSEGGERI_ALTERATO'
    );

    const compatibili = veicoliCompatibiliNcc(
      [...flotta.values()],
      restrizioni,
      picco
    ).map(v => String(v.id));

    verifica(
      compatibili.length > 0,
      'NESSUN_VEICOLO_COMPATIBILE'
    );

    verifica(
      Array.isArray(servizio.veicoliCompatibili),
      'LISTA_COMPATIBILITA_MANCANTE'
    );

    assert.equal(
      firma(servizio.veicoliCompatibili),
      firma(compatibili),
      'NCC_AUDIT_CPSAT_LISTA_COMPATIBILITA_ALTERATA'
    );

    const veicolo = flotta.get(String(veicoloId));

    verifica(
      veicolo &&
      veicoloCompatibileNcc(
        veicolo,
        restrizioni
      ) &&
      compatibili.includes(String(veicoloId)),
      'VEICOLO_NON_COMPATIBILE'
    );

    verificaAttiva();

    return {
      valido: true,
      tipiVeicoloAmmessi: restrizioni,
      veicoliCompatibili: compatibili,
      veicoloId: String(veicoloId),
      piccoPasseggeri: picco
    };
  }

  verificaAttiva();

  return {
    versione:
      NCC_AUDIT_COMPATIBILITA_CPSAT_VERSION,

    verificaServizio
  };
}