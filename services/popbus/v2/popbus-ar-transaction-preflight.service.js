// TURENTU POPBUS V2 - FASE 5A
// Preflight transazionale A/R, SENZA scritture e SENZA conversione.
// NON collegare al router e NON usare come autorizzazione a confermare corse.
// Il chiamante deve aprire BEGIN (READ WRITE) e terminare con ROLLBACK.
import { analizzaDipendenzeAR } from './popbus-ar-coordinator.service.js';

function errore(message, code = 'AR_PREFLIGHT_NOT_READY') {
  const e = new Error(message);
  e.code = code;
  e.status = 409;
  return e;
}

function interoPositivo(v) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw errore('ID attivazione non valido');
  return n;
}

// Solo diagnostica. La funzione NON crea corse, prenotazioni o pagamenti.
// I lock non sostituiscono il preflight PIXEL/veicolo/pagamenti di acceptance.js.
export async function preflightTransazionaleAR(client, attivazioneId) {
  if (!client || typeof client.query !== 'function') throw errore('Client PostgreSQL non valido');
  const root = interoPositivo(attivazioneId);

  // Stesso lock globale dell'accettazione ordinaria: PRIMA dei row lock.
  await client.query('SELECT pg_advisory_xact_lock(734021, 1)');

  // Ricognizione iniziale. La closure verra' ricalcolata dopo i lock.
  const prima = await analizzaDipendenzeAR(client, root);
  const ids = [...new Set(prima.attivazioni.map(interoPositivo))].sort((a, b) => a - b);
  if (!ids.length || !ids.includes(root)) {
    return { ...prima, fase: 'preflight_transazionale', confermaAbilitata: false };
  }

  // Lock deterministici sulle attivazioni. Non richiede lock in sola lettura.
  const { rows: locked } = await client.query(
    `SELECT id FROM popbus_attivazioni
     WHERE id = ANY($1::bigint[])
     ORDER BY id FOR UPDATE`, [ids]
  );
  if (locked.length !== ids.length) throw errore('Attivazioni mutate durante il preflight');

  // Lock deterministici sulle richieste collegate, inclusi passeggeri ordinari.
  await client.query(
    `SELECT r.id FROM richieste_pop_bus r
     JOIN popbus_attivazione_richieste ar ON ar.richiesta_id = r.id
     WHERE ar.attiva AND ar.attivazione_id = ANY($1::bigint[])
     ORDER BY r.id FOR UPDATE OF r`, [ids]
  );

  // Lock sui gruppi e sulle accettazioni provvisorie/offerte.
  const gids = [...new Set(prima.gruppi.map(g => String(g.id)))].sort();
  if (gids.length) {
    await client.query(
      `SELECT id FROM ar_gruppi WHERE id = ANY($1::uuid[])
       ORDER BY id FOR UPDATE`, [gids]
    );
  }
  await client.query(
    `SELECT id FROM popbus_ar_accettazioni
     WHERE attivazione_id = ANY($1::bigint[])
     ORDER BY id FOR UPDATE`, [ids]
  );
  await client.query(
    `SELECT o.id FROM offerte_autisti o
     JOIN popbus_ar_accettazioni p ON p.offerta_id = o.id
     WHERE p.attivazione_id = ANY($1::bigint[])
     ORDER BY o.id FOR UPDATE OF o`, [ids]
  );

  // Ricalcolo con i lock detenuti: se cambia la closure, fail closed.
  const dopo = await analizzaDipendenzeAR(client, root);
  const dopoIds = [...new Set(dopo.attivazioni.map(interoPositivo))].sort((a, b) => a - b);
  const dopoGids = [...new Set(dopo.gruppi.map(g => String(g.id)))].sort();
  if (JSON.stringify(ids) !== JSON.stringify(dopoIds) ||
      JSON.stringify(gids) !== JSON.stringify(dopoGids)) {
    throw errore('Dipendenze A/R cambiate durante il preflight');
  }

  return {
    ...dopo,
    fase: 'preflight_transazionale',
    attivazioniBloccate: ids,
    gruppiBloccati: gids,
    // Anche quando stato === 'pronta', NON autorizza la conversione.
    confermaAbilitata: false
  };
}
