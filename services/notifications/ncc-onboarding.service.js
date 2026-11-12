import { pool } from '../../db/db.js';
import { vehicleChecks } from '../../routes/admin/vehicle-overview.js';
import { deliverNotification } from './notification.service.js';
import { isGmailConfigured, sendTurentuEmail } from '../auth/gmail.service.js';

const NCC_REMINDER = 'ncc_dati_mancanti';
const NCC_COMPLETION = 'ncc_dati_completi';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 40;
const ADVISORY_LOCK = 481602009;
const EMAIL_BATCH_SIZE = 25;
const EMAIL_MAX_ATTEMPTS = 5;
const titles = {
  [NCC_REMINDER]: 'Completa i tuoi dati NCC',
  [NCC_COMPLETION]: 'Configurazione NCC completata',
};

let running = false;
let timer;

function missingData(operator) {
  return [
    !['singolo', 'flotta'].includes(operator.modalita_operativa) && 'modalità operativa',
    !operator.profilo_completo && 'dati del profilo',
    operator.veicoli === 0 && 'veicolo',
    operator.tariffe_mancanti && 'tariffe standard',
    operator.disponibilita_mancanti && 'disponibilità',
  ].filter(Boolean);
}

export async function queueNccOnboardingNotifications(dbPool = pool) {
  const db = await dbPool.connect();
  const notifications = [];
  try {
    await db.query('BEGIN');
    const { rows: [lock] } = await db.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [ADVISORY_LOCK]);
    if (!lock.acquired) {
      await db.query('ROLLBACK');
      return notifications;
    }
    await db.query("SET LOCAL lock_timeout = '3s'");
    await db.query("SET LOCAL statement_timeout = '15s'");
    const { rows: operators } = await db.query(`
      WITH vehicle_setup AS (
        SELECT v.driver_id, ${vehicleChecks}
        FROM veicolo v JOIN utente owner ON owner.id = v.driver_id
        WHERE owner.eliminato_il IS NULL AND lower(btrim(owner.tipo)) = 'autista'
      ), fleet AS (
        SELECT driver_id, count(*)::int AS veicoli,
          bool_or(NOT tariffa_standard) AS tariffe_mancanti,
          bool_or(NOT disponibilita_configurata) AS disponibilita_mancanti
        FROM vehicle_setup GROUP BY driver_id
      )
      SELECT u.id, u.modalita_operativa,
        coalesce(f.veicoli, 0) AS veicoli, f.tariffe_mancanti, f.disponibilita_mancanti,
        coalesce(
          nullif(btrim(p.nome), '') IS NOT NULL AND nullif(btrim(p.cognome), '') IS NOT NULL
          AND nullif(btrim(p.telefono), '') IS NOT NULL AND nullif(btrim(p.iban), '') IS NOT NULL
          AND nullif(btrim(p.nome_banca), '') IS NOT NULL AND nullif(btrim(p.nome_titolare_conto), '') IS NOT NULL,
          false
        ) AS profilo_completo,
        s.utente_id IS NOT NULL AS stato_esistente, s.completo, s.completamento_notificato,
        (u.created_at <= now() - interval '24 hours'
          AND (s.ultimo_promemoria IS NULL OR s.ultimo_promemoria <= now() - interval '72 hours')) AS promemoria_dovuto
      FROM utente u
      LEFT JOIN notifiche_completamento_ncc s ON s.utente_id = u.id
      LEFT JOIN fleet f ON f.driver_id = u.id
      LEFT JOIN LATERAL (
        SELECT nome, cognome, telefono, iban, nome_banca, nome_titolare_conto
        FROM autista_profilo WHERE utente_id = u.id ORDER BY id DESC LIMIT 1
      ) p ON true
      WHERE lower(btrim(u.tipo)) = 'autista' AND u.eliminato_il IS NULL
      ORDER BY s.ultimo_promemoria NULLS FIRST, u.id
    `);

    let admins;
    let sentEvents = 0;
    for (const operator of operators) {
      const missing = missingData(operator);
      const complete = missing.length === 0;
      const baseline = operator.stato_esistente && operator.completo === null;
      let completionSent = Boolean(operator.completamento_notificato) || (baseline && complete);
      let reminderSent = false;

      if (complete && !completionSent && sentEvents < BATCH_SIZE) {
        admins ??= (await db.query(`
          SELECT id FROM utente WHERE lower(btrim(tipo)) = 'admin' AND eliminato_il IS NULL ORDER BY id
        `)).rows;
        if (admins.length) {
          const message = `L’operatore NCC #${operator.id} ha completato i dati di configurazione.`;
          const { rows } = await db.query(`
            INSERT INTO notifications (user_id, type, message, seen, created_at)
            SELECT id, $2, $3, false, now() FROM unnest($1::int[]) AS id
            RETURNING *
          `, [admins.map(admin => admin.id), NCC_COMPLETION, message]);
          for (const row of rows) notifications.push({ row, role: 'admin', title: titles[NCC_COMPLETION] });
          completionSent = true;
          sentEvents++;
        }
      } else if (!complete && operator.promemoria_dovuto && sentEvents < BATCH_SIZE) {
        const message = 'Completa la configurazione NCC. Mancano: ' + missing.join(', ') + '.';
        const { rows: [row] } = await db.query(`
          INSERT INTO notifications (user_id, type, message, seen, created_at)
          VALUES ($1, $2, $3, false, now()) RETURNING *
        `, [operator.id, NCC_REMINDER, message]);
        notifications.push({ row, role: 'autista', title: titles[NCC_REMINDER] });
        reminderSent = true;
        sentEvents++;
      }

      if (operator.completo !== complete || Boolean(operator.completamento_notificato) !== completionSent || reminderSent) {
        await db.query(`
          INSERT INTO notifiche_completamento_ncc (utente_id, completo, completamento_notificato, ultimo_promemoria)
          VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END)
          ON CONFLICT (utente_id) DO UPDATE SET
            completo = EXCLUDED.completo, completamento_notificato = EXCLUDED.completamento_notificato,
            ultimo_promemoria = coalesce(EXCLUDED.ultimo_promemoria, notifiche_completamento_ncc.ultimo_promemoria)
        `, [operator.id, complete, completionSent, reminderSent]);
      }
      if (complete && operator.completo === false) {
        await db.query(`
          DELETE FROM notifiche_completamento_ncc_email q USING notifications n
          WHERE q.notifica_id = n.id AND q.inviata_il IS NULL AND n.user_id = $1 AND n.type = $2
        `, [operator.id, NCC_REMINDER]);
      }
    }
    if (notifications.length) {
      await db.query(`
        INSERT INTO notifiche_completamento_ncc_email (notifica_id)
        SELECT unnest($1::int[])
      `, [notifications.map(({ row }) => row.id)]);
    }
    await db.query('COMMIT');
    return notifications;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

export async function deliverNccOnboardingEmails(dbPool = pool, sendMail = sendTurentuEmail) {
  for (let index = 0; index < EMAIL_BATCH_SIZE; index++) {
    const { rows: [job] } = await dbPool.query(`
      WITH candidate AS (
        SELECT q.notifica_id, n.type, n.message, u.email
        FROM notifiche_completamento_ncc_email q
        JOIN notifications n ON n.id = q.notifica_id
        JOIN utente u ON u.id = n.user_id
        WHERE q.inviata_il IS NULL AND q.tentativi < $1 AND q.prossimo_tentativo <= now()
          AND u.eliminato_il IS NULL AND nullif(btrim(u.email), '') IS NOT NULL
          AND ((n.type = $2 AND lower(btrim(u.tipo)) = 'autista')
            OR (n.type = $3 AND lower(btrim(u.tipo)) = 'admin'))
        ORDER BY q.prossimo_tentativo, q.notifica_id
        FOR UPDATE OF q SKIP LOCKED LIMIT 1
      )
      UPDATE notifiche_completamento_ncc_email q
        SET tentativi = q.tentativi + 1, prossimo_tentativo = now() + interval '5 minutes'
      FROM candidate c WHERE q.notifica_id = c.notifica_id
      RETURNING q.notifica_id, q.tentativi, c.type, c.message, c.email
    `, [EMAIL_MAX_ATTEMPTS, NCC_REMINDER, NCC_COMPLETION]);
    if (!job) break;

    try {
      await sendMail(job.email, 'Turentu - ' + titles[job.type], job.message);
      await dbPool.query(`
        UPDATE notifiche_completamento_ncc_email SET inviata_il = now()
        WHERE notifica_id = $1 AND tentativi = $2
      `, [job.notifica_id, job.tentativi]);
    } catch (error) {
      await dbPool.query(`
        UPDATE notifiche_completamento_ncc_email
        SET prossimo_tentativo = now() + $3::int * interval '1 minute'
        WHERE notifica_id = $1 AND tentativi = $2
      `, [job.notifica_id, job.tentativi, 5 * (2 ** (job.tentativi - 1))]);
      console.error('Invio email NCC:', error.code || error.name);
    }
  }
}

export function startNccOnboardingNotifications() {
  if (timer) return;

  async function run() {
    if (running) return;
    running = true;
    try {
      const notifications = await queueNccOnboardingNotifications();
      for (let offset = 0; offset < notifications.length; offset += 5) {
        const deliveries = await Promise.allSettled(notifications.slice(offset, offset + 5).map(({ row, role, title }) =>
          deliverNotification(row, { role, title })));
        for (const result of deliveries) {
          if (result.status === 'rejected') console.error('Consegna notifica NCC:', result.reason?.code || result.reason?.name);
        }
      }
      if (isGmailConfigured()) await deliverNccOnboardingEmails();
    } catch (error) {
      console.error('Notifiche completamento NCC:', error.code || error.name);
    } finally {
      running = false;
    }
  }

  timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref();
  void run();
}
