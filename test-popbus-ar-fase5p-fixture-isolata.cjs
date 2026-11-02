'use strict';
// Fase 5P - fixture A/R in tabelle TEMPORARY, transazione PostgreSQL reale.
// NON esegue acceptance.js: prova soltanto l'atomicita' SQL con due conversioni.
// Non tocca le tabelle applicative, non crea pagamenti, non chiama Stripe.
const assert = require('node:assert/strict');
const path = require('node:path');

async function main() {
  assert.equal(process.env.TURENTU_TEST_AR_CONFIRM, 'ROLLBACK_ONLY', 'Impostare TURENTU_TEST_AR_CONFIRM=ROLLBACK_ONLY');
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL mancante');
  const { Client } = require(path.join(process.cwd(), 'node_modules', 'pg'));
  const client = new Client({connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : {rejectUnauthorized:false},
    application_name: 'turentu-5p-ar-temp-fixture'});
  let open = false;
  try {
    await client.connect();
    await client.query('BEGIN'); open = true;
    await client.query("SET LOCAL statement_timeout = '8000ms'");
    await client.query("SET LOCAL lock_timeout = '2000ms'");
    await client.query(`CREATE TEMP TABLE turentu_5p_fixture (
      id integer PRIMARY KEY, ar_group text NOT NULL, tratta text NOT NULL,
      stato text NOT NULL CHECK(stato IN ('in_lavorazione','convertita')),
      corsa_id integer,
      UNIQUE(ar_group,tratta),
      CHECK ((stato='convertita') = (corsa_id IS NOT NULL))
    ) ON COMMIT DROP`);
    await client.query(`INSERT INTO turentu_5p_fixture(id,ar_group,tratta,stato)
      VALUES(900001,'AR-5P','andata','in_lavorazione'),
            (900002,'AR-5P','ritorno','in_lavorazione')`);
    const get = async () => (await client.query('SELECT id,tratta,stato,corsa_id FROM turentu_5p_fixture ORDER BY id')).rows;
    const initial = await get();
    assert.equal(initial.length, 2);
    await client.query('SAVEPOINT test_errore_ritorno');
    let injected = false;
    try {
      await client.query("UPDATE turentu_5p_fixture SET stato='convertita',corsa_id=910001 WHERE tratta='andata'");
      // Fallimento forzato della seconda conversione: il CHECK rifiuta corsa_id NULL.
      await client.query("UPDATE turentu_5p_fixture SET stato='convertita',corsa_id=NULL WHERE tratta='ritorno'");
    } catch (e) {
      injected = e.code === '23514';
      await client.query('ROLLBACK TO SAVEPOINT test_errore_ritorno');
    }
    assert.ok(injected, 'FAIL: errore sulla seconda conversione non provocato come previsto');
    assert.deepEqual(await get(), initial, 'FAIL: rollback della prima conversione non riuscito');
    console.log('PASS 1: errore sulla seconda tratta provoca rollback anche della prima');

    await client.query('SAVEPOINT test_successo');
    await client.query("UPDATE turentu_5p_fixture SET stato='convertita',corsa_id=910001 WHERE tratta='andata'");
    await client.query("UPDATE turentu_5p_fixture SET stato='convertita',corsa_id=910002 WHERE tratta='ritorno'");
    const success = await get();
    assert.equal(success.filter(r => r.stato === 'convertita' && r.corsa_id !== null).length, 2);
    console.log('PASS 2: entrambe le tratte convertite nella stessa transazione');
    await client.query('ROLLBACK TO SAVEPOINT test_successo');
    assert.deepEqual(await get(), initial);
    console.log('PASS 3: ripristino completo delle fixture');
    console.log('FASE 5P: atomicita SQL con fixture TEMP verificata. Non e un test end-to-end del finalizzatore.');
  } finally {
    if (open) {
      try { await client.query('ROLLBACK'); console.log('ROLLBACK FINALE OK - nessuna persistenza'); }
      catch (e) { console.error('ROLLBACK FINALE FALLITO:',e.message); process.exitCode = 3; }
    }
    await client.end().catch(() => {});
  }
}
main().catch(e => { console.error('FASE 5P FAIL:',e.message); process.exitCode = 1; });
