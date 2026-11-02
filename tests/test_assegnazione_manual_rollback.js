// TURENTU - Test assegnazione manuale NCC, sempre ROLLBACK.
// Posizione: tests/test_assegnazione_manual_rollback.js
// Esempio: node tests/test_assegnazione_manual_rollback.js --operatore=10 --conducente=20 --corsa=30
// Non eseguire contro dati reali senza aver verificato gli ID.
import 'dotenv/config';
import pg from 'pg';
import { assegnaConducente } from '../services/conducenti/assegnazioni.service.js';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const m = /^--([a-z]+)=(\d+)$/.exec(arg);
  if (!m) throw new Error(`Argomento non valido: ${arg}`);
  return [m[1], Number(m[2])];
}));
for (const key of ['operatore', 'conducente', 'corsa']) {
  if (!Number.isSafeInteger(args[key]) || args[key] <= 0) {
    console.error(`Uso: node tests/test_assegnazione_manual_rollback.js --operatore=ID --conducente=ID --corsa=ID`);
    process.exit(2);
  }
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000
});
let client;
let started = false;
let failed = false;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  started = true;
  await client.query("SET LOCAL statement_timeout = '12000ms'");
  await client.query("SET LOCAL lock_timeout = '2500ms'");
  const { rows: corse } = await client.query(
    `SELECT c.id, c.veicolo_id, c.tipo_corsa, c.stato,
            c.inizio_ciclo_operativo, c.fine_ciclo_operativo,
            v.driver_id AS operatore_id
       FROM corse c JOIN veicolo v ON v.id=c.veicolo_id
      WHERE c.id=$1`, [args.corsa]);
  const corsa = corse[0];
  if (!corsa) throw new Error('Corsa non trovata');
  if (Number(corsa.operatore_id) !== args.operatore) throw new Error('La corsa non appartiene all’operatore indicato');
  if (!['privata', 'condivisa'].includes(corsa.tipo_corsa) || !['prenotabile', 'da_attivare'].includes(corsa.stato)) {
    throw new Error('Corsa non assegnabile: occorre privata/condivisa in stato prenotabile/da_attivare');
  }
  if (!(corsa.inizio_ciclo_operativo instanceof Date) || !(corsa.fine_ciclo_operativo instanceof Date) ||
      corsa.inizio_ciclo_operativo <= new Date() || corsa.fine_ciclo_operativo <= corsa.inizio_ciclo_operativo) {
    throw new Error('La corsa deve avere un ciclo operativo completo e futuro');
  }
  const { rows: rapporti } = await client.query(
    `SELECT id, stato, sempre_disponibile FROM conducenti_operatori
      WHERE operatore_id=$1 AND conducente_id=$2`, [args.operatore, args.conducente]);
  if (rapporti[0]?.stato !== 'attivo') throw new Error('Rapporto conducente-operatore non attivo');
  const { rows: impostazioni } = await client.query(
    `SELECT modalita FROM impostazioni_assegnazione_operatori WHERE operatore_id=$1`, [args.operatore]);
  if ((impostazioni[0]?.modalita ?? 'manuale') !== 'manuale') {
    throw new Error('Impostare prima la modalità manuale dalla schermata operatore');
  }
  console.log('PRECHECK OK', { corsa: args.corsa, veicolo: corsa.veicolo_id,
    conducente: args.conducente, sempre_disponibile: rapporti[0].sempre_disponibile });
  const input = { operatoreId: args.operatore, conducenteId: args.conducente,
    veicoloId: Number(corsa.veicolo_id), corsaId: args.corsa,
    modalita: 'manuale', usaCicloPersistito: true };
  let assegnazione;
  try {
    await client.query('SAVEPOINT primo_tentativo');
    assegnazione = await assegnaConducente(client, input);
    console.log('PASS assegnazione manuale', { id: assegnazione.id, stato: assegnazione.stato });
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT primo_tentativo');
    if (e.code === 'CONDUCENTE_DEROGA_RICHIESTA') {
      console.log('PASS deroga richiesta per mancata copertura oraria');
      await client.query('SAVEPOINT deroga');
      assegnazione = await assegnaConducente(client, {
        ...input, confermaDeroga: true,
        motivoDeroga: 'Test tecnico autorizzato con rollback',
        autorizzatoreId: args.operatore,
      });
      console.log('PASS deroga manuale tracciata', { id: assegnazione.id, deroga: assegnazione.deroga_turno });
    } else {
      throw e;
    }
  }
  // Secondo tentativo sulla stessa corsa: deve essere rifiutato.
  await client.query('SAVEPOINT conflitto');
  try {
    await assegnaConducente(client, input);
    throw new Error('FAIL: duplicazione della stessa corsa accettata');
  } catch (e) {
    if (e.code !== 'CONDUCENTE_CONFLITTO') throw e;
    console.log('PASS conflitto sulla stessa corsa bloccato');
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT conflitto');
  }
  console.log('RISULTATO: test completato, nessuna assegnazione sarà conservata');
} catch (e) {
  failed = true;
  console.error('TEST NON SUPERATO:', e.message, e.code ? `(codice ${e.code})` : '');
} finally {
  if (client) {
    if (started) {
      try { await client.query('ROLLBACK'); console.log('ROLLBACK eseguito'); }
      catch (e) { failed = true; console.error('ERRORE ROLLBACK:', e.message); }
    }
    client.release();
  }
  await pool.end();
  if (failed) process.exitCode = 1;
}
