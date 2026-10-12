
import assert from 'node:assert/strict';
import { pool } from '../db/db.js';

const TOLLERANZA_MINUTI = 10;

const SCENARI = [
  {
    nome: 'Richiesta originale',
    id: 101,
    start_node_id: 1,
    end_node_id: 4,
    start_datetime: '2026-10-12T17:00:00Z'
  },
  {
    nome: 'Richiesta compatibile',
    id: 102,
    start_node_id: 1,
    end_node_id: 4,
    start_datetime: '2026-10-12T17:05:00Z'
  },
  {
    nome: 'Richiesta incompatibile stesso slot',
    id: 103,
    start_node_id: 1,
    end_node_id: 4,
    start_datetime: '2026-10-12T17:55:00Z'
  },
  {
    nome: 'Richiesta incompatibile altro slot',
    id: 104,
    start_node_id: 1,
    end_node_id: 4,
    start_datetime: '2026-10-12T21:00:00Z'
  }
];

function slotOrario(datetime) {
  const ms = new Date(datetime).getTime();
  return new Date(Math.floor(ms / 3600000) * 3600000)
    .toISOString();
}

function differenzaMinuti(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / 60000;
}

function simulaUpdateAttuale(richiesta, cluster) {
  // Riproduce i filtri dell'UPDATE attuale:
  // stato, nodi e direttrice_id.
  // Non riproduce il clustering né la selezione
  // della direttrice.
  return (
    richiesta.stato === 'in_attesa' &&
    richiesta.direttrice_id == null &&
    richiesta.start_node_id === cluster.start_node_id &&
    richiesta.end_node_id === cluster.end_node_id
  );
}

function testSimulato() {
  console.log('\n🧪 TEST LOGICA TEMPORALE');

  const principale = SCENARI[0];

  const cluster = {
    start_node_id: principale.start_node_id,
    end_node_id: principale.end_node_id
  };

  const risultati = SCENARI.map(r => {
    const richiesta = {
      ...r,
      stato: 'in_attesa',
      direttrice_id: null
    };

    const diff = differenzaMinuti(
      principale.start_datetime,
      r.start_datetime
    );

    const compatibile = diff <= TOLLERANZA_MINUTI;
    const selezionataDaUpdate =
      simulaUpdateAttuale(richiesta, cluster);

    return {
      id: r.id,
      scenario: r.nome,
      slot: slotOrario(r.start_datetime),
      differenza_minuti: diff,
      compatibile_teorico: compatibile,
      selezionata_da_update: selezionataDaUpdate,
      falso_positivo:
        selezionataDaUpdate && !compatibile
    };
  });

  console.table(risultati);

  const falsiPositivi = risultati.filter(
    r => r.falso_positivo
  );

  assert.equal(
    falsiPositivi.length,
    2,
    'La simulazione non ha riprodotto i due falsi positivi attesi'
  );

  console.log(
    `⚠️ Riprodotti ${falsiPositivi.length} ` +
    'falsi positivi nei filtri dell’UPDATE.'
  );

  console.log(
    'ℹ️ Il test non dimostra che entrambe le richieste ' +
    'supererebbero anche la selezione della direttrice.'
  );
}

async function testDatabase(client) {
  console.log('\n🔌 VERIFICA DATABASE');

  const { rows: info } = await client.query(`
    SELECT
      current_database() AS database,
      current_setting('transaction_read_only')
        AS sola_lettura
  `);

  console.table(info);

  assert.equal(info[0].sola_lettura, 'on');

  const { rows: richieste } = await client.query(`
    SELECT
      id,
      start_node_id,
      end_node_id,
      start_datetime,
      stato,
      direttrice_id
    FROM richieste_pop_bus
    ORDER BY start_datetime DESC, id DESC
    LIMIT 1000
  `);

  console.log(
    `📊 Richieste presenti nel campione: ${richieste.length}`
  );

  // Ricerca coppie con stessi nodi e orari
  // distanti più della tolleranza.
  const gruppi = new Map();

  for (const r of richieste) {
    const key = `${r.start_node_id}_${r.end_node_id}`;

    if (!gruppi.has(key)) gruppi.set(key, []);
    gruppi.get(key).push(r);
  }

  const coppie = [];

  for (const gruppo of gruppi.values()) {
    for (let i = 0; i < gruppo.length; i++) {
      for (let j = i + 1; j < gruppo.length; j++) {
        const a = gruppo[i];
        const b = gruppo[j];

        if (!a.start_datetime || !b.start_datetime) {
          continue;
        }

        const diff = differenzaMinuti(
          a.start_datetime,
          b.start_datetime
        );

        if (diff > TOLLERANZA_MINUTI) {
          coppie.push({
            richiesta_1: a.id,
            richiesta_2: b.id,
            start_node_id: a.start_node_id,
            end_node_id: a.end_node_id,
            differenza_minuti: diff,
            direttrice_1: a.direttrice_id,
            direttrice_2: b.direttrice_id,
            stessa_direttrice:
              a.direttrice_id != null &&
              String(a.direttrice_id) ===
              String(b.direttrice_id)
          });
        }
      }
    }
  }

  console.log('\n📋 COPPIE TEMPORALMENTE DISTANTI');
  console.log(`Totale nel campione: ${coppie.length}`);
  console.table(coppie.slice(0, 30));

  const stessaDirettrice = coppie.filter(
    c => c.stessa_direttrice
  );

  console.log(
    `⚠️ Coppie con stessi nodi, scarto >10 minuti ` +
    `e stessa direttrice: ${stessaDirettrice.length}`
  );

  console.log(
    'ℹ️ Queste coppie sono indicatori diagnostici: ' +
    'senza gli orari di transito non costituiscono ' +
    'automaticamente errori di matching.'
  );
}

async function main() {
  let client;
  let transaction = false;

  try {
    console.log('====================================');
    console.log('🚌 TURENTU POPBUS');
    console.log('TEST BUG MATCHING TEMPORALE');
    console.log('MODALITÀ SOLA LETTURA');
    console.log('====================================');

    testSimulato();

    client = await pool.connect();

    await client.query(
      'BEGIN TRANSACTION READ ONLY'
    );

    transaction = true;

    await client.query(
      "SET LOCAL statement_timeout = '15000ms'"
    );

    await testDatabase(client);

    console.log('\n✅ TEST DIAGNOSTICO COMPLETATO');
    console.log('🔒 Nessun dato modificato.');

  } catch (err) {
    console.error('\n❌ TEST FALLITO');
    console.error(err.stack ?? err);
    process.exitCode = 1;

  } finally {
    if (client) {
      if (transaction) {
        try {
          await client.query('ROLLBACK');
        } catch (err) {
          console.error('Errore rollback:', err);
          process.exitCode = 1;
        }
      }

      client.release();
    }

    await pool.end();
  }
}

main();
