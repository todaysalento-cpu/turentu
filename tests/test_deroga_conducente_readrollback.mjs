// Turentu - test deroga manuale. Nessuna modifica persistente: ROLLBACK finale.
import { pool } from '../db/db.js';
import { assegnaConducente } from '../services/conducenti/assegnazioni.service.js';

const client = await pool.connect();
let tx = false;
const base = {
  operatoreId: 2,
  conducenteId: 101,
  veicoloId: 364,
  corsaId: 923,
  inizio: '2026-12-01T08:00:00+01:00',
  fine: '2026-12-01T12:00:00+01:00',
  modalita: 'manuale'
};
function check(condition, message) {
  if (!condition) throw new Error(`TEST FALLITO: ${message}`);
  console.log(`OK: ${message}`);
}
try {
  await client.query('BEGIN');
  tx = true;
  const { rows: rel } = await client.query(
    `SELECT id FROM conducenti_operatori
     WHERE operatore_id=$1 AND conducente_id=$2 AND stato='attivo'`,
    [base.operatoreId, base.conducenteId]
  );
  check(rel.length === 1, 'Conducente associato e attivo');
  const { rows: vehicle } = await client.query(
    'SELECT id FROM veicolo WHERE id=$1 AND driver_id=$2',
    [base.veicoloId, base.operatoreId]
  );
  check(vehicle.length === 1, 'Veicolo appartenente allâ€™operatore');
  const { rows: ride } = await client.query(
    'SELECT id FROM corse WHERE id=$1 AND veicolo_id=$2',
    [base.corsaId, base.veicoloId]
  );
  check(ride.length === 1, 'Corsa associata al veicolo');

  const { rows: preexisting } = await client.query(
    `SELECT id FROM assegnazioni_conducenti
     WHERE conducente_id=$1 AND stato='assegnata'
       AND intervallo_operativo && tstzrange($2::timestamptz,$3::timestamptz,'[)')`,
    [base.conducenteId, base.inizio, base.fine]
  );
  check(preexisting.length === 0, 'Nessun incarico preesistente nellâ€™intervallo di test');

  let blocked = null;
  try {
    await assegnaConducente(client, base);
  } catch (e) {
    blocked = e;
  }
  console.log('DIAGNOSTICA:', { code: blocked?.code, message: blocked?.message, detail: blocked?.detail });
  check(blocked?.code === 'CONDUCENTE_DEROGA_RICHIESTA',
    'Fuori turno senza conferma bloccato con codice corretto');

  const assigned = await assegnaConducente(client, {
    ...base,
    confermaDeroga: true,
    motivoDeroga: 'Autorizzazione esplicita per collaudo Turentu',
    autorizzatoreId: 2
  });
  check(assigned.deroga_turno === true, 'Deroga registrata');
  check(assigned.deroga_autorizzata_da === 2, 'Autorizzatore registrato');
  check(Boolean(assigned.deroga_autorizzata_il), 'Data autorizzazione registrata');
  check(assigned.deroga_motivo === 'Autorizzazione esplicita per collaudo Turentu',
    'Motivazione registrata');

  let overlap = null;
  try {
    await assegnaConducente(client, {
      ...base,
      inizio: '2026-12-01T10:00:00+01:00',
      fine: '2026-12-01T14:00:00+01:00',
      confermaDeroga: true,
      motivoDeroga: 'Seconda autorizzazione per test sovrapposizione',
      autorizzatoreId: 2
    });
  } catch (e) {
    overlap = e;
  }
  check(overlap?.code === 'CONDUCENTE_CONFLITTO',
    'Sovrapposizione bloccata anche con deroga');
  console.log('ESITO: TUTTI I TEST SUPERATI');
} catch (e) {
  console.error('ESITO: TEST NON SUPERATO:', e.code ?? '', e.message);
  process.exitCode = 1;
} finally {
  if (tx) {
    try { await client.query('ROLLBACK'); console.log('ROLLBACK eseguito'); }
    catch (e) { console.error('ERRORE ROLLBACK:', e.message); process.exitCode = 1; }
  }
  client.release();
  await pool.end();
}

