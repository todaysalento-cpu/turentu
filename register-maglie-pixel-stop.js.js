
import { registerPixelStopCandidate } from './services/pixel/pixel-stop-registration.service.js';

const fermata = {
  nodo_territoriale_id: 5,
  nome: 'Maglie - Piazzale Megapark',
  indirizzo: 'Via Otranto 55, Piazzale Megapark, 73024 Maglie (LE)',
  lat: 40.121583,
  lon: 18.305914,

  fonte: 'fonte_pubblica_riutilizzabile',
  riferimento_fonte: 'https://www.flixbus.it/autobus/maglie/maglie',

  autorizzazione_uso_dati: true,
  conferma_punto_salita: true,
};

try {
  const risultato = await registerPixelStopCandidate(fermata);

  console.log(
    '\n=== RISULTATO REGISTRAZIONE PIXEL ===\n',
    JSON.stringify(risultato, null, 2)
  );

  if (risultato.attivazione_provvisoria === true) {
    console.log(
      '\nOK: fermata attivata provvisoriamente.'
    );
  } else {
    console.log(
      '\nATTENZIONE: fermata non attivata provvisoriamente.'
    );
    console.log(
      'Motivo:',
      risultato.motivo_non_attivazione ??
      risultato.reason ??
      'Da verificare nel risultato'
    );
  }
} catch (error) {
  console.error(
    '\nERRORE REGISTRAZIONE PIXEL:',
    error.message
  );
  process.exitCode = 1;
}
