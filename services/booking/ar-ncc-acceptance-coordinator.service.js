/**
 * TURENTU — Coordinamento provvisorio NCC A/R (NON LIVE).
 * Nessuna creazione corse, conferma, notifica o cattura Stripe.
 * Il default ROLLBACK_ONLY impedisce modifiche persistenti durante il collaudo.
 */
import { pool } from '../../db/db.js';
import { accettaTrattaARAtomica } from './ar-atomic-acceptance.service.js';
import { verificaCoppiaAR } from './ar-acceptance.service.js';
import { verificaGruppoARTransazionale } from './ar-transaction.service.js';
import { transitionArGroup } from './ar-coordinator.service.js';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  error.status = 409;
  throw error;
}
function positiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * @param {object} input
 * @param {string} input.arGroupId UUID del gruppo
 * @param {number} input.operatoreId ID autenticato dell'operatore NCC (mai dal body HTTP)
 * @param {boolean} [input.rollbackOnly=true] default: non persiste nulla
 * @param {object} [input.movement] SOLO test, non esporre su endpoint HTTP
 * @param {object} [input.routing] SOLO test
 * @param {object} [input.client] Connessione esterna gia in transazione, SOLO test
 */
export async function coordinaAccettazioneProvvisoriaNccAR({
  arGroupId, operatoreId, rollbackOnly = true, movement, routing, client: externalClient = null
} = {}) {
  if (typeof arGroupId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arGroupId)) {
    fail('AR_GROUP_ID_INVALID');
  }
  const oid = positiveInt(operatoreId);
  if (!oid) fail('AR_OPERATOR_ID_INVALID');
  // Questo modulo non e' abilitato al COMMIT finche' lock protocol,
  // verifica del ciclo operativo e test concorrenti non saranno completati.
  if (rollbackOnly !== true) fail('AR_NCC_COORDINATOR_COMMIT_DISABLED');

  const ownClient = !externalClient;
  const client = externalClient ?? await pool.connect();
  let tx = false;
  let savepoint = false;
  try {
    if (ownClient) {
      await client.query('BEGIN');
      tx = true;
    } else {
      // Il chiamante deve avere gia aperto BEGIN sulla stessa connessione.
      await client.query('SAVEPOINT ar_ncc_coordinator_test');
      savepoint = true;
    }
    await client.query("SET LOCAL lock_timeout = '2000ms'");
    await client.query("SET LOCAL statement_timeout = '15000ms'");

    // Lock unico sul gruppo: serializza le accettazioni dello stesso A/R.
    const { rows: groups } = await client.query(`
      SELECT id, stato, expires_at
      FROM ar_gruppi WHERE id = $1 FOR UPDATE
    `, [arGroupId]);
    const group = groups[0];
    if (!group || !['autorizzato', 'in_attesa'].includes(group.stato) ||
        !(new Date(group.expires_at).getTime() > Date.now())) {
      fail('AR_GROUP_NOT_ACCEPTING');
    }

    // Lettura iniziale senza lock: verra' rivalidata dai servizi esistenti.
    const { rows: legs } = await client.query(`
      SELECT p.id, p.veicolo_id, p.ar_tratta, p.ar_vincolata, p.stato,
             p.expires_at, v.driver_id AS operatore_veicolo
      FROM pending p
      JOIN veicolo v ON v.id = p.veicolo_id
      WHERE p.ar_group_id = $1
      ORDER BY p.id
    `, [arGroupId]);
    if (legs.length !== 2 ||
        legs.filter(x => x.ar_tratta === 'andata').length !== 1 ||
        legs.filter(x => x.ar_tratta === 'ritorno').length !== 1 ||
        legs.some(x => x.ar_vincolata !== true || x.stato !== 'pending' ||
          !(new Date(x.expires_at).getTime() > Date.now()) ||
          !positiveInt(x.veicolo_id) || !positiveInt(x.operatore_veicolo))) {
      fail('AR_LEGS_INVALID');
    }

    // AR_COORDINATOR_ROLLBACK_V2: in simulazione ammette accettazioni preesistenti.
    const mine = legs.filter(x => Number(x.operatore_veicolo) === oid);
    if (!mine.length) fail('AR_OPERATOR_NOT_AUTHORIZED');
    const sameOperator = legs.every(x => Number(x.operatore_veicolo) === oid);
    if (sameOperator && mine.length !== 2) fail('AR_OPERATOR_PAIR_INVALID');

    // Ordine globale deterministico dei lock veicolo.
    const vehicleIds = [...new Set(legs.map(x => Number(x.veicolo_id)))].sort((a, b) => a - b);
    for (const vehicleId of vehicleIds) {
      const { rows } = await client.query('SELECT id FROM veicolo WHERE id = $1 FOR UPDATE', [vehicleId]);
      if (rows.length !== 1) fail('AR_VEHICLE_NOT_FOUND');
    }

    // Simula la transizione senza persisterla: la transazione verra' annullata.
    if (group.stato === 'autorizzato') {
      await transitionArGroup(client, arGroupId, 'autorizzato', 'in_attesa');
      group.stato = 'in_attesa';
    }

    // Legge le accettazioni sotto lock: una tratta gia' accettata non viene duplicata.
    const { rows: existingAcceptances } = await client.query(
      'SELECT id, pending_id, veicolo_id, ar_group_id, stato, expires_at FROM ar_accettazioni WHERE ar_group_id = $1 ORDER BY pending_id FOR UPDATE',
      [arGroupId]
    );
    const byPending = new Map(existingAcceptances.map(a => [Number(a.pending_id), a]));
    if (existingAcceptances.some(a =>
      !legs.some(l => Number(l.id) === Number(a.pending_id)) ||
      a.stato !== 'provvisoria' ||
      !(new Date(a.expires_at).getTime() > Date.now()) ||
      Number(a.veicolo_id) !== Number(legs.find(l => Number(l.id) === Number(a.pending_id))?.veicolo_id)
    )) fail('AR_EXISTING_ACCEPTANCE_INVALID');

    const accepted = [];
    for (const leg of [...mine].sort((a, b) => Number(a.id) - Number(b.id))) {
      const old = byPending.get(Number(leg.id));
      if (old) {
        accepted.push({ pendingId: Number(leg.id), veicoloId: Number(leg.veicolo_id), creata: false });
      } else {
        accepted.push(await accettaTrattaARAtomica({
          pendingId: Number(leg.id), operatoreId: oid, client, movement, routing
        }));
      }
    }

    // Lettura orientativa: non certifica il ciclo completo e non abilita 'pronto'.
    const pair = await verificaCoppiaAR(client, arGroupId);
    let preliminary = null;
    if (pair.completa) {
      // Il verificatore richiede 'in_attesa'/'pronto': non transizioniamo
      // nel test ROLLBACK_ONLY; restituiamo la coppia senza falsa certificazione.
      preliminary = { eseguibile: false, motivo: 'AR_GROUP_REMAINS_AUTHORIZED_IN_ROLLBACK_TEST' };
      if (group.stato === 'in_attesa') {
        preliminary = await verificaGruppoARTransazionale(arGroupId, { client, movement, routing });
      }
    }

    if (ownClient) {
      await client.query('ROLLBACK');
      tx = false;
    } else {
      await client.query('ROLLBACK TO SAVEPOINT ar_ncc_coordinator_test');
      await client.query('RELEASE SAVEPOINT ar_ncc_coordinator_test');
      savepoint = false;
    }
    return {
      rollbackOnly: true,
      gruppoId: arGroupId,
      operatoreId: oid,
      stessoOperatore: sameOperator,
      tratteAccettate: accepted.map(x => ({ pendingId: x.pendingId, veicoloId: x.veicoloId, creata: x.creata })),
      coppiaCompletaNelTest: pair.completa,
      verificaPreliminare: preliminary,
      statoPersistito: false,
      confermata: false,
      catturaStripeAbilitata: false
    };
  } catch (error) {
    if (ownClient && tx) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
    } else if (!ownClient && savepoint) {
      try {
        await client.query('ROLLBACK TO SAVEPOINT ar_ncc_coordinator_test');
        await client.query('RELEASE SAVEPOINT ar_ncc_coordinator_test');
      } catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  } finally {
    if (ownClient) client.release();
  }
}
