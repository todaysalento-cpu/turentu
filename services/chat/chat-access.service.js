export async function canAccessChat(db, corsaId, clienteId, userId) {
  const ids = [corsaId, clienteId, userId].map(Number);
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return false;
  const { rows } = await db.query(
    'SELECT 1 FROM chat_threads WHERE corsa_id = $1 AND cliente_id = $2 AND (cliente_id = $3 OR driver_id = $3) LIMIT 1',
    ids
  );
  return rows.length > 0;
}
