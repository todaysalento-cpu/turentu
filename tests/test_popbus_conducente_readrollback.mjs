// Turentu - collaudo isolato del servizio di assegnazione conducenti PopBus.
// Non chiama Stripe, worker, acceptance o socket. Nessun COMMIT.
// Eseguire solo su database di test/staging, non in produzione.
import { pool } from '../db/db.js';
import { assegnaConducente } from '../services/popbus/v2/assegnazioni.service.js';

if (process.env.TURENTU_ALLOW_CONDUCENTE_ROLLBACK_TEST !== 'YES') {
  console.error('Test non avviato. Impostare TURENTU_ALLOW_CONDUCENTE_ROLLBACK_TEST=YES solo in staging.');
  process.exit(2);
}

const op = 2, conducente = 101, v1 = 353, v2 = 356;
const inizio = '2026-11-02T10:00:00+01:00'; // lunedi, Europe/Rome
const fine = '2026-11-02T11:00:00+01:00';
const check = (ok, label) => {
  if (!ok) throw new Error(`TEST FALLITO: ${label}`);
  console.log(`OK: ${label}`);
};

let client;
let started = false;
let fixtureIds = [];
let baseline = null;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  started = true;
  await client.query("SET LOCAL statement_timeout = '15000ms'");
  await client.query("SET LOCAL lock_timeout = '3000ms'");

  const { rows: [{ n }] } = await client.query('SELECT COUNT(*)::int AS n FROM assegnazioni_conducenti');
  baseline = n;
  const { rows: veicoli } = await client.query(
    'SELECT id FROM veicolo WHERE driver_id=$1 AND id=ANY($2::int[]) ORDER BY id', [op, [v1, v2]]
  );
  check(veicoli.length === 2, 'Entrambi i veicoli appartengono all’operatore');
  const { rows: rapporti } = await client.query(
    `SELECT id, assegnabile_automaticamente FROM conducenti_operatori
     WHERE operatore_id=$1 AND conducente_id=$2 AND stato='attivo'`, [op, conducente]
  );
  check(rapporti.length === 1, 'Rapporto conducente attivo');
  const { rows: automatici } = await client.query(
    `SELECT id FROM conducenti_operatori
     WHERE operatore_id=$1 AND stato='attivo' AND assegnabile_automaticamente=true`, [op]
  );
  check(automatici.length === 0, 'Nessun conducente automatico abilitato (precondizione)');
  const { rows: conflittiPre } = await client.query(
    `SELECT id FROM assegnazioni_conducenti
     WHERE conducente_id=$1 AND stato='assegnata'
       AND intervallo_operativo && tstzrange($2::timestamptz,$3::timestamptz,'[)')`,
    [conducente, inizio, fine]
  );
  check(conflittiPre.length === 0, 'Nessuna assegnazione preesistente sovrapposta');

  // Le attivazioni sono inserite solo nella transazione aperta.
  // Direttrice e opportunita NULL: fixture di servizio, non di accettazione commerciale.
  for (const veicoloId of [v1, v2]) {
    const { rows } = await client.query(
      `INSERT INTO popbus_attivazioni
       (veicolo_id,autista_id,stato,partenza,arrivo,costo,ricavo,tariffa,piano,expires_at)
       VALUES ($1,$2,'in_attesa_autista',$3::timestamptz,$4::timestamptz,0,0,0,'{}'::jsonb,$5::timestamptz)
       RETURNING id`,
      [veicoloId, op, inizio, fine, '2026-11-02T12:00:00+01:00']
    );
    fixtureIds.push(rows[0].id);
  }
  check(fixtureIds.length === 2, 'Due attivazioni temporanee create');

  const base = { operatoreId: op, conducenteId: conducente, veicoloId: v1,
    attivazioneId: fixtureIds[0], inizio, fine, modalita: 'manuale' };
  const assegnata = await assegnaConducente(client, base);
  check(Number(assegnata.conducente_id) === conducente && Number(assegnata.veicolo_id) === v1,
    'Assegnazione manuale al veicolo 353');
  check(assegnata.deroga_turno === false, 'Turno coperto senza deroga');

  await client.query('SAVEPOINT prova_sovrapposizione');
  let sovrapposizione = null;
  try {
    await assegnaConducente(client, { ...base, veicoloId: v2, attivazioneId: fixtureIds[1] });
  } catch (e) {
    sovrapposizione = e;
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT prova_sovrapposizione');
    await client.query('RELEASE SAVEPOINT prova_sovrapposizione');
  }
  check(Boolean(sovrapposizione) && /impegnato|overlap|exclude|conflict/i.test(sovrapposizione.message),
    'Conducente bloccato sul secondo veicolo nello stesso intervallo');

  await client.query('SAVEPOINT prova_automatica');
  let automatica = null;
  try {
    await assegnaConducente(client, { operatoreId: op, veicoloId: v2,
      attivazioneId: fixtureIds[1], inizio, fine, modalita: 'automatica' });
  } catch (e) {
    automatica = e;
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT prova_automatica');
    await client.query('RELEASE SAVEPOINT prova_automatica');
  }
  check(Boolean(automatica) && /Nessun conducente disponibile/i.test(automatica.message),
    'Automatica senza candidati rifiutata');

  const { rows: [{ n: durante }] } = await client.query(
    'SELECT COUNT(*)::int AS n FROM assegnazioni_conducenti'
  );
  check(durante === baseline + 1, 'Una sola assegnazione temporanea nella transazione');
  console.log('ESITO: TEST FUNZIONALI SUPERATI; avvio rollback obbligatorio');
} catch (e) {
  console.error('ESITO: TEST NON SUPERATO:', e.code ?? '', e.message);
  process.exitCode = 1;
} finally {
  if (client) {
    if (started) {
      try {
        await client.query('ROLLBACK');
        console.log('ROLLBACK eseguito');
        if (baseline != null) {
          const { rows: [{ n: dopo }] } = await client.query(
            'SELECT COUNT(*)::int AS n FROM assegnazioni_conducenti'
          );
          check(dopo === baseline, 'Conteggio assegnazioni ripristinato');
          if (fixtureIds.length) {
            const { rows: [{ n: residue }] } = await client.query(
              'SELECT COUNT(*)::int AS n FROM popbus_attivazioni WHERE id=ANY($1::bigint[])',
              [fixtureIds]
            );
            check(residue === 0, 'Nessuna attivazione temporanea residua');
          }
        }
      } catch (e) {
        console.error('VERIFICA ROLLBACK FALLITA:', e.message);
        process.exitCode = 1;
      }
    }
    client.release();
  }
  await pool.end();
}
