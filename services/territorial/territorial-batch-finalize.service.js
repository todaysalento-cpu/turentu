
import { pool } from '../../db/db.js';

export async function finalizzaVerifica({
  id,
  workerId,
  esito,
  client: externalClient,
  simulazione = false
}) {
  const esitiAmmessi = [
    'raggiungibile',
    'non_raggiungibile',
    'non_valutabile'
  ];

  if (!workerId || !esitiAmmessi.includes(esito)) {
    throw new Error('Parametri finalizzazione non validi');
  }

  if (!/^[1-9]\d*$/.test(String(id))) {
    throw new Error('ID verifica non valido');
  }

  // Per ora consentiamo esclusivamente la simulazione.
  if (!simulazione || !externalClient) {
    throw new Error(
      'Finalizzazione reale disabilitata: usare simulazione con transazione esterna'
    );
  }

  // Il chiamante mantiene aperta la transazione e decide
  // se eseguire COMMIT oppure ROLLBACK.
  const client = externalClient;

  const { rows } = await client.query(`
    UPDATE territorial_hub_coda_stradale
    SET stato = 'completata',
        terminato_at = NOW(),
        lease_expires_at = NULL,
        updated_at = NOW()
    WHERE id = $1
      AND worker_id = $2
      AND stato = 'in_elaborazione'
      AND lease_expires_at > NOW()
    RETURNING id, centro_gid, hub_id, stato
  `, [id, workerId]);

  if (rows.length !== 1) {
    throw new Error(
      'Finalizzazione rifiutata: proprietario non valido, lease scaduta o stato incompatibile'
    );
  }

  return {
    ...rows[0],
    esito_simulato: esito,
    persistito: false
  };
}
