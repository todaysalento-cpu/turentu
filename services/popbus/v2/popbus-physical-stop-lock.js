
const fail = message => {
  throw new Error(`POPBUS_PHYSICAL_STOP_LOCK: ${message}`);
};

const validId = value =>
  value !== null &&
  value !== undefined &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) > 0;

const validCoord = (lat, lon) =>
  Number.isFinite(Number(lat)) &&
  Number.isFinite(Number(lon)) &&
  Math.abs(Number(lat)) <= 90 &&
  Math.abs(Number(lon)) <= 180;

const coordinateUguali = (a, b) =>
  Math.abs(Number(a.lat) - Number(b.lat)) <= 0.000001 &&
  Math.abs(Number(a.lon) - Number(b.lon)) <= 0.000001;

/**
 * Rivalida le fermate fisiche in una transazione PostgreSQL.
 *
 * Il chiamante deve avere giÃ  aperto BEGIN.
 * Non esegue COMMIT e non crea offerte.
 *
 * Richiede un protocollo di sincronizzazione condiviso
 * per le modifiche concorrenti alle evidenze collegate.
 */
export async function validaFermateFisicheTransazionali({
  client,
  missioni
} = {}) {
  if (!client || typeof client.query !== 'function') {
    fail('client PostgreSQL mancante');
  }

  if (!Array.isArray(missioni) || missioni.length === 0) {
    fail('missioni fisiche mancanti');
  }

  const catalogo = new Map();

  for (const missione of missioni) {
    if (
      missione?.schemaVersion !== 2 ||
      missione?.tipoItinerario !== 'FERMATE_FISICHE' ||
      !Array.isArray(missione.plan?.nodes) ||
      !Array.isArray(missione.nodiFisici)
    ) {
      fail('contratto missione fisica non valido');
    }

    const nodi = new Map();

    for (const fermata of missione.nodiFisici) {
      if (
        !validId(fermata?.id) ||
        !validCoord(fermata.lat, fermata.lon)
      ) {
        fail('fermata candidata non valida');
      }

      const id = Number(fermata.id);
      const precedente = nodi.get(id);

      if (precedente && !coordinateUguali(precedente, fermata)) {
        fail(`coordinate divergenti per fermata ${id}`);
      }

      nodi.set(id, fermata);
    }

    for (const rawId of missione.plan.nodes) {
      if (!validId(rawId)) {
        fail('ID fermata non valido nel piano');
      }

      const id = Number(rawId);
      const fermata = nodi.get(id);

      if (!fermata) {
        fail(`fermata ${id} assente da nodiFisici`);
      }

      const precedente = catalogo.get(id);

      if (precedente && !coordinateUguali(precedente, fermata)) {
        fail(`coordinate discordanti tra missioni: ${id}`);
      }

      catalogo.set(id, fermata);
    }
  }

  const ids = [...catalogo.keys()].sort((a, b) => a - b);

  // Il lock protegge le righe censite da UPDATE/DELETE
  // concorrenti fino alla conclusione della transazione.
  const result = await client.query(
    `
    SELECT
      f.id,
      f.attiva,
      f.verificata,
      f.nome,
      f.nodo_territoriale_id,
      ST_Y(f.posizione::geometry) AS lat,
      ST_X(f.posizione::geometry) AS lon,
      n.attivo AS nodo_attivo
    FROM public.pixel_fermate f
    JOIN public.nodi_territoriali n
      ON n.id = f.nodo_territoriale_id
    WHERE f.id = ANY($1::bigint[])
    ORDER BY f.id
    FOR SHARE OF f, n
    `,
    [ids]
  );

  if (result.rows.length !== ids.length) {
    fail('una o piÃ¹ fermate non esistono nel catalogo');
  }

  for (const row of result.rows) {
    const id = Number(row.id);
    const attesa = catalogo.get(id);

    if (!attesa) {
      fail(`fermata inattesa: ${id}`);
    }

    if (row.attiva !== true || row.nodo_attivo !== true) {
      fail(`fermata o nodo territoriale non attivo: ${id}`);
    }

    if (
      !validCoord(row.lat, row.lon) ||
      !coordinateUguali(attesa, row)
    ) {
      fail(`coordinate fermata modificate: ${id}`);
    }
  }

  // Stesse esclusioni del servizio candidati POPBUS V2.
  const esclusioni = await client.query(
    `
    SELECT f.id
    FROM public.pixel_fermate f
    WHERE f.id = ANY($1::bigint[])
      AND (
        EXISTS (
          SELECT 1
          FROM public.pixel_fermate_test_metadata tm
          WHERE tm.fermata_id = f.id
        )
        OR f.nome ~*
          '^[[:space:]]*(\\[TEST PIXEL\\]|TEST PIXEL([[:space:]]|$))'
        OR EXISTS (
          SELECT 1
          FROM public.pixel_fermate_fonti ff
          WHERE ff.fermata_id = f.id
            AND ff.stato_verifica = 'non_ammessa'
        )
      )
    LIMIT 1
    `,
    [ids]
  );

  if (esclusioni.rows.length > 0) {
    fail(`fermata esclusa: ${esclusioni.rows[0].id}`);
  }

  return {
    ok: true,
    numeroFermate: ids.length,
    fermateIds: ids,
    attivabile: false
  };
}

