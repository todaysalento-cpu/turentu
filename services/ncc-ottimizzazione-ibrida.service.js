// NCC_SNAPSHOT_ORIGINALE_V2902E2F1D2A
import assert from 'node:assert/strict';

import {
  creaCatalogoAdattivoNcc
} from './ncc-catalogo-adattivo.service.js';

import {
  creaMatriceCpsatNcc
} from './ncc-matrice-cpsat.service.js';

import {
  eseguiCpsatNcc
} from './ncc-cpsat-bridge.service.js';

import {
  validaSoluzioneCpsatNcc
} from './ncc-validatore-cpsat.service.js';

import {
  validaPrenotazioniCpsatNcc
} from './ncc-validazione-prenotazioni.service.js';

import {
  ricostruisciMissioniCpsatNcc
} from './ncc-ricostruzione-missioni.service.js';

// NCC_RICOSTRUZIONE_AUDIT_V2902E2F2B

import {
  validaMissioniNcc
} from './ncc-validazione-missioni.service.js';

export const NCC_IBRIDO_VERSION = '2.9.0';

// NCC_CONCORRENZA_V28751

const MAX_PIPELINE_CPSAT = 1;

let pipelineAttive = 0;

export function diagnosticaConcorrenzaCpsatNcc() {
  return {
    limite: MAX_PIPELINE_CPSAT,
    attive: pipelineAttive,
    disponibili:
      MAX_PIPELINE_CPSAT - pipelineAttive
  };
}

function idsPiano(piano) {

  const ids = piano.missioni.flatMap(
    m => m.gruppi.flatMap(
      g => g.prenotazioni.map(String)
    )
  );

  assert.equal(
    new Set(ids).size,
    ids.length,
    'NCC_IBRIDO_PRENOTAZIONI_DUPLICATE'
  );

  return new Set(ids);
}

export async function ottimizzaIbridoNcc({

  abilitato = false,

  pianoOriginale,
  aggregazione,
  prenotazioni,
  veicoli,
  routing,
  parametri,
  riferimento,
  durataGiornoMs = 86400000,
  giorno,

  prenotazioniIndicative = [],

  signal = null,
  verificaAttiva = () => {}

}) {

  verificaAttiva();

  const avvio = Date.now();

  const diagnostica = {
    versione: NCC_IBRIDO_VERSION,
    abilitato,
    tentato: false,
    adottato: false,
    motivo: null,
    durataMs: 0
  };

  function termina(piano, motivo) {

    verificaAttiva();

    return {
      piano,
      diagnostica: {
        ...diagnostica,
        motivo,
        durataMs: Date.now() - avvio
      }
    };
  }

  if (abilitato !== true) {

    return termina(
      pianoOriginale,
      'FLAG_DISABILITATO'
    );
  }

  const originali = idsPiano(
    pianoOriginale
  );

  const aggregati = new Set(
    aggregazione.proposte.flatMap(
      g => g.prenotazioni.map(String)
    )
  );

  for (const id of originali) {

    assert.ok(
      aggregati.has(id),
      'NCC_IBRIDO_COPERTURA_ORIGINALE'
    );
  }

  diagnostica.prenotazioniOriginali =
    originali.size;

  diagnostica.prenotazioniAggregate =
    aggregati.size;

  diagnostica.recuperabili =
    aggregati.size - originali.size;

  if (!diagnostica.recuperabili) {

    return termina(
      pianoOriginale,
      'NESSUNA_ESCLUSIONE_RECUPERABILE'
    );
  }

  if (!veicoli.length) {

    return termina(
      pianoOriginale,
      'NESSUN_VEICOLO'
    );
  }

  if (veicoli.length > 20) {

    return termina(
      pianoOriginale,
      'LIMITE_VEICOLI'
    );
  }

  if (aggregazione.proposte.length > 150) {

    return termina(
      pianoOriginale,
      'LIMITE_SERVIZI'
    );
  }

  const candidati =
    pianoOriginale.diagnosticaAdattiva
      ?.candidatiDisaggregazione ?? [];

  diagnostica.candidatiDisaggregazione =
    candidati.length;

  if (!candidati.length) {

    return termina(
      pianoOriginale,
      'NESSUN_CANDIDATO_DISAGGREGAZIONE'
    );
  }

  const routingPrima =
    routing.diagnostica();

  diagnostica.routingPrima =
    routingPrima;

  if (
    signal?.aborted ||
    routingPrima.interrotta ||
    routingPrima.autorizzazioneBloccata ||
    routingPrima.ultimoRifiutoAutorizzazione === 'LEASE_PERSO'
  ) {
    throw new Error('NCC_IBRIDO_ROUTING_NON_SICURO');
  }

  if (
    routingPrima.elementiResiduiLocali === 0
  ) {
    return termina(
      pianoOriginale,
      'BUDGET_ROUTING_INSUFFICIENTE'
    );
  }

  if (
    Number.isFinite(routingPrima.tempoResiduoMs) &&
    routingPrima.tempoResiduoMs < 20000
  ) {
    return termina(
      pianoOriginale,
      'TEMPO_ROUTING_INSUFFICIENTE'
    );
  }

  if (
    routingPrima.interrotta ||
    routingPrima.budgetEsaurito
  ) {

    return termina(
      pianoOriginale,
      'ROUTING_NON_DISPONIBILE'
    );
  }

  // NCC_FALLBACK_PROTETTO_V2871

  verificaAttiva();

  diagnostica.concorrenza =
    diagnosticaConcorrenzaCpsatNcc();

  if (pipelineAttive >= MAX_PIPELINE_CPSAT) {

    return termina(
      pianoOriginale,
      'SLOT_CP_SAT_OCCUPATO'
    );
  }

  pipelineAttive++;

  diagnostica.concorrenza =
    diagnosticaConcorrenzaCpsatNcc();

  diagnostica.tentato = true;

  let fase = 'PREFLIGHT';

  try {

  verificaAttiva();

  // NCC_PREFLIGHT_V28741

  const preflight = await eseguiCpsatNcc({

    script: 'scripts/ncc-cpsat-preflight.py',

    input: {},

    signal,

    timeoutMs: 5000,

    maxOutputBytes: 16384
  });

  verificaAttiva();

  if (
    preflight.risultato.disponibile !== true ||
    typeof preflight.risultato.python !== 'string' ||
    typeof preflight.risultato.ortools !== 'string'
  ) {
    throw new Error('NCC_PREFLIGHT_NON_VALIDO');
  }

  diagnostica.preflight = {
    disponibile: true,
    python: preflight.risultato.python,
    ortools: preflight.risultato.ortools,
    durataMs: preflight.durataMs
  };

  const routingDopoPreflight =
    routing.diagnostica();

  if (
    signal?.aborted ||
    routingDopoPreflight.interrotta ||
    routingDopoPreflight.autorizzazioneBloccata ||
    routingDopoPreflight.ultimoRifiutoAutorizzazione ===
      'LEASE_PERSO'
  ) {
    throw new Error('NCC_IBRIDO_ROUTING_NON_SICURO');
  }

  if (
    routingDopoPreflight.budgetEsaurito ||
    routingDopoPreflight.elementiResiduiLocali === 0
  ) {
    return termina(
      pianoOriginale,
      'BUDGET_ROUTING_INSUFFICIENTE'
    );
  }

  if (
    Number.isFinite(
      routingDopoPreflight.tempoResiduoMs
    ) &&
    routingDopoPreflight.tempoResiduoMs < 20000
  ) {
    return termina(
      pianoOriginale,
      'TEMPO_ROUTING_INSUFFICIENTE'
    );
  }

  fase = 'SNAPSHOT_ORIGINALE';

  verificaAttiva();

  const prenotazioniOriginali =
    structuredClone(prenotazioni);

  const veicoliOriginali =
    structuredClone(veicoli);

  verificaAttiva();

  diagnostica.snapshotOriginale = {
    prenotazioni: prenotazioniOriginali.length,
    veicoli: veicoliOriginali.length,
    indipendente: true
  };

  fase = 'CATALOGO';

  const catalogo =
    await creaCatalogoAdattivoNcc({

      prenotazioni,

      proposte:
        aggregazione.proposte,

      veicoli,

      diagnostica:
        pianoOriginale.diagnosticaAdattiva,

      routing,
      parametri,
      riferimento,
      durataGiornoMs,
      verificaAttiva
    });

  diagnostica.catalogo =
    catalogo.diagnosticaCatalogo;

  verificaAttiva();

  fase = 'MATRICE';

  const matrice =
    await creaMatriceCpsatNcc({

      catalogo,
      routing,
      verificaAttiva
    });

  diagnostica.matrice =
    matrice.diagnosticaMatrice;

  verificaAttiva();

  fase = 'SOLVER';

  const solver = await eseguiCpsatNcc({

    script: 'scripts/ncc-cpsat.py',

    input: {
      catalogo: matrice,

      opzioni: {
        maxTempoSecondi: 5,
        workers: 2
      }
    },

    signal,
    timeoutMs: 15000
  });

  verificaAttiva();

  const risultato = solver.risultato;

  diagnostica.solver = {
    stato: risultato.stato,

    ottimoCompleto:
      risultato.ottimoCompleto,

    durataMs: solver.durataMs,

    obiettivi:
      risultato.obiettivi
  };

  if (
    risultato.stato !==
      'SOLUZIONE_DISPONIBILE'
  ) {

    return termina(
      pianoOriginale,
      'NESSUNA_SOLUZIONE_CP_SAT'
    );
  }

  fase = 'VALIDAZIONE_LOGISTICA';

  const logistica =
    validaSoluzioneCpsatNcc({

      catalogo: matrice,
      risultato,
      prenotazioniOriginali,
      veicoliOriginali,
      verificaAttiva
    });

  verificaAttiva();

  fase = 'VALIDAZIONE_PRENOTAZIONI';

  const validazione =
    await validaPrenotazioniCpsatNcc({

      catalogo: matrice,

      validazione: logistica,

      prenotazioniOriginali,
      veicoliOriginali,

      routing,
      verificaAttiva
    });

  verificaAttiva();

  fase = 'RICOSTRUZIONE';

  const candidato =
    ricostruisciMissioniCpsatNcc({

      catalogo: matrice,
      risultato,
      validazione,
      prenotazioniOriginali,
      veicoliOriginali,
      giorno,
      prenotazioniIndicative,
      verificaAttiva
    });

  fase = 'AUDIT_MISSIONI_RICOSTRUITE';

  verificaAttiva();

  assert.ok(
    candidato.audit
      ?.compatibilitaRicostruzioneVerificata === true &&
    candidato.audit
      ?.identitaVeicoliOriginaliVerificata === true &&
    candidato.audit
      ?.restrizioniMissioniRicostruite === true,
    'NCC_IBRIDO_RICOSTRUZIONE_NON_VERIFICATA'
  );

  const auditMissioni = validaMissioniNcc({
    missioni: candidato.missioni,
    prenotazioni: prenotazioniOriginali,
    veicoli: veicoliOriginali,
    verificaAttiva
  });

  assert.ok(
    auditMissioni.valido === true &&
    auditMissioni.caricoRealeVerificato === true &&
    auditMissioni.capienzaVerificata === true &&
    auditMissioni.compatibilitaVeicoliVerificata === true &&
    auditMissioni.restrizioniOriginaliVerificate === true &&
    auditMissioni.univocitaPrenotazioniVerificata === true &&
    auditMissioni.sovrapposizioniMissioniVerificate === true,
    'NCC_IBRIDO_AUDIT_MISSIONI_INCOMPLETO'
  );

  candidato.audit = {
    ...candidato.audit,
    missioniRicostruiteVerificate: true,
    caricoRealeVerificato: true,
    capienzaVerificata: true,
    compatibilitaVeicoliVerificata: true,
    restrizioniOriginaliVerificate: true,
    sovrapposizioniMissioniVerificate: true,
    validazioneMissioni: auditMissioni
  };

  diagnostica.auditMissioni = auditMissioni;

  verificaAttiva();

  fase = 'AUDIT_CANDIDATO';

  const nuove = idsPiano(candidato);

  assert.equal(
    auditMissioni.prenotazioniVerificate,
    nuove.size,
    'NCC_IBRIDO_COPERTURA_AUDIT_INCOERENTE'
  );

  diagnostica.prenotazioniCandidato =
    nuove.size;

  diagnostica.recuperate =
    [...nuove].filter(
      id => !originali.has(id)
    );

  diagnostica.perse =
    [...originali].filter(
      id => !nuove.has(id)
    );

  diagnostica.routingDopo =
    routing.diagnostica();

  diagnostica.ricostruzione =
    candidato.diagnosticaRicostruzione;

  // Non perdere prenotazioni gia
  // assegnate dal motore originale.

  if (diagnostica.perse.length) {

    return termina(
      pianoOriginale,
      'PERDITA_PRENOTAZIONI_ORIGINALI'
    );
  }

  // In questa fase CP-SAT viene adottato
  // solo per aumentare la copertura.

  if (nuove.size <= originali.size) {

    return termina(
      pianoOriginale,
      'NESSUN_MIGLIORAMENTO_COPERTURA'
    );
  }

  for (const id of nuove) {

    assert.ok(
      aggregati.has(id),
      'NCC_IBRIDO_PRENOTAZIONE_ESTRANEA'
    );
  }

  candidato.riepilogo.serviziNonAssegnati =
    aggregazione.proposte.filter(
      g => g.prenotazioni.some(
        id => !nuove.has(String(id))
      )
    ).length;

  candidato.ottimizzazione.prima = {
    prenotazioni: originali.size,

    senzaCosto:
      pianoOriginale.riepilogo
        .missioniSenzaCosto,

    costo:
      pianoOriginale.riepilogo
        .costoCentesimi,

    km:
      pianoOriginale.riepilogo
        .kmTotali,

    kmVuoto:
      pianoOriginale.riepilogo
        .kmVuoto,

    missioni:
      pianoOriginale.missioni.length,

    veicoli:
      pianoOriginale.riepilogo
        .veicoliUtilizzati
  };

  candidato.diagnosticaAdattiva =
    structuredClone(
      pianoOriginale.diagnosticaAdattiva
    );

  const statoFinale = routing.diagnostica();

  verificaAttiva();

  if (
    signal?.aborted ||
    statoFinale.interrotta ||
    statoFinale.autorizzazioneBloccata ||
    statoFinale.ultimoRifiutoAutorizzazione === 'LEASE_PERSO'
  ) {
    throw new Error('NCC_IBRIDO_ROUTING_NON_SICURO');
  }

  if (statoFinale.budgetEsaurito) {
    throw new Error('NCC_BUDGET_ROUTING_ESAURITO');
  }

  diagnostica.adottato = true;

  return termina(
    candidato,
    'COPERTURA_MIGLIORATA'
  );

  } catch (err) {

    // Non trasformare una cancellazione
    // della sessione in un risultato valido.

    if (signal?.aborted) {
      throw err;
    }

    verificaAttiva();

    const statoRouting = routing.diagnostica();

    if (
      statoRouting.interrotta ||
      statoRouting.autorizzazioneBloccata ||
      statoRouting.ultimoRifiutoAutorizzazione === 'LEASE_PERSO'
    ) {
      throw err;
    }

    if (
      err?.message === 'NCC_CPSAT_INTERROTTO'
    ) {
      throw err;
    }

    if (statoRouting.budgetEsaurito) {

      diagnostica.adottato = false;

      diagnostica.fallback = {
        attivato: true,
        fase,
        codice: 'NCC_BUDGET_ROUTING_ESAURITO'
      };

      diagnostica.routingDopo = statoRouting;

      return termina(
        pianoOriginale,
        'BUDGET_ROUTING_ESAURITO'
      );
    }

    diagnostica.adottato = false;

    diagnostica.fallback = {
      attivato: true,
      fase,
      codice: 'NCC_CP_SAT_FALLBACK'
    };

    diagnostica.routingDopo = statoRouting;

    console.warn(
      '[NCC CP-SAT] Fallback automatico:',
      fase
    );

    return termina(
      pianoOriginale,
      'FALLBACK_CP_SAT'
    );

  } finally {

    pipelineAttive--;

  }
}