// STAGING ONLY — Turentu POPBUS V2 / PIXEL-first.
// Non importare nel worker operativo prima del test E2E.
// Il chiamante DEVE aprire BEGIN e decidere COMMIT/ROLLBACK.
// Il modulo non invia socket, non gestisce pagamenti e non crea direttrici legacy.
import { fingerprintRichiesta } from './request-fingerprint.js';
import { registraMissioniAttivazione } from './popbus-cycle-persistence.js';

const fail = msg => { throw new Error(`PIXEL_FIRST_TX: ${msg}`); };
const positive = (v, name) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) fail(`${name} non valido`);
  return n;
};
const instant = (v, name) => {
  const n = new Date(v).getTime();
  if (!Number.isFinite(n)) fail(`${name} non valido`);
  return n;
};
const money = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(`${name} non valido`);
  return n;
};

// L'identita' e' deterministica ma NON sostituisce gli indici SQL.
export function chiaveFormazionePixel(c) {
  const ids = c?.evaluation?.requests?.map(r => positive(r.id, 'richiesta'));
  if (!ids?.length || new Set(ids).size !== ids.length) fail('richieste duplicate/vuote');
  return [positive(c.pixelOpportunitaId, 'opportunita'),
    positive(c.pixelDirettriceId, 'direttrice'),
    positive(c.pixelVersione, 'versione'),
    ...[ids.slice().sort((a, b) => a - b).join(',')],
    instant(c.evaluation.departure, 'partenza')].join('|');
}

// Un singolo candidato mono-missione. Le missioni multiple richiedono
// l'assembler e il relativo test di acceptance prima di usare questo percorso.
export async function persistiCandidatoPixelInTransazione(client, c, { coordinates } = {}) {
  if (!client?.query) fail('client PostgreSQL mancante');
  if (c?.source !== 'PIXEL') fail('origine non PIXEL');
  if (!Array.isArray(c.plan?.nodes) || !Array.isArray(c.plan?.legs) ||
      c.plan.nodes.length < 2 || c.plan.legs.length !== c.plan.nodes.length - 1)
    fail('piano territoriale incompleto');
  if (!Array.isArray(coordinates) || coordinates.length !== c.plan.nodes.length)
    fail('coordinate non coerenti');
  if (!Array.isArray(c.evaluation?.times) || c.evaluation.times.length !== c.plan.nodes.length)
    fail('tempi ai nodi incompleti');
  if (!c.approach || !c.returnTrip || !c.economia?.economicamenteAttivabile)
    fail('ciclo/economia non validati');
  const key = chiaveFormazionePixel(c);
  const ids = c.evaluation.requests.map(r => positive(r.id, 'richiesta')).sort((a,b) => a-b);
  const veicoloId = positive(c.vehicle?.id, 'veicolo');
  const ownerId = positive(c.vehicle?.driver_id, 'titolare');
  const start = instant(c.busyStart, 'busyStart');
  const end = instant(c.busyEnd, 'busyEnd');
  const departure = instant(c.evaluation.departure, 'departure');
  const arrival = instant(c.evaluation.arrival, 'arrival');
  if (!(start < departure && departure < arrival && arrival < end)) fail('ciclo temporale incoerente');
  if (start <= Date.now()) fail('ciclo gia iniziato');
  if (!Number.isFinite(Number(c.evaluation.peak)) || Number(c.evaluation.peak) <= 0)
    fail('picco non valido');

  // Lock globale condiviso con worker legacy e acceptance: evita interleaving
  // tra percorsi POPBUS che rispettano lo stesso protocollo.
  await client.query('SELECT pg_advisory_xact_lock(734021, 1)');
  // Per-veicolo: NON blocca altri veicoli dello stesso titolare.
  const { rows: vehicles } = await client.query(
    'SELECT id, driver_id, posti_totali FROM veicolo WHERE id=$1 AND driver_id=$2 FOR UPDATE',
    [veicoloId, ownerId]);
  if (vehicles.length !== 1 || Number(vehicles[0].posti_totali) < Number(c.evaluation.peak))
    fail('veicolo non disponibile/capienza insufficiente');

  // Rilettura e lock ordinato: non fidarsi dello snapshot in memoria.
  const { rows: locked } = await client.query(
    'SELECT * FROM richieste_pop_bus WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
  if (locked.length !== ids.length) fail('richieste mancanti');
  const byId = new Map(locked.map(r => [Number(r.id), r]));
  for (const r of c.evaluation.requests) {
    const current = byId.get(Number(r.id));
    if (!current || current.stato !== 'in_attesa' || current.corsa_id != null)
      fail(`richiesta ${r.id} non prenotabile`);
    // evaluation.requests puo' contenere proiezioni del modello senza start_datetime.
    // Non calcolare il fingerprint sulla proiezione: usare la riga DB completa
    // e validare esplicitamente l'identita' e la compatibilita' del candidato.
    if (!Number.isSafeInteger(Number(r.start)) || !Number.isSafeInteger(Number(r.end)) ||
        Number(r.start) < 0 || Number(r.end) <= Number(r.start) ||
        Number(r.end) >= c.plan.nodes.length)
      fail(`richiesta ${r.id}: indici salita/discesa invalidi`);
    if (Number(current.start_node_id ?? current.origine_nodo_territoriale_id) !==
          Number(c.plan.nodes[Number(r.start)]) ||
        Number(current.end_node_id ?? current.destinazione_nodo_territoriale_id) !==
          Number(c.plan.nodes[Number(r.end)]))
      fail(`richiesta ${r.id}: nodi non coerenti con il DB`);
    const desired = new Date(current.start_datetime).getTime();
    const passing = departure + Number(c.evaluation.times[Number(r.start)]);
    if (!Number.isFinite(desired) || !Number.isFinite(passing) ||
        Math.abs(desired - passing) > 30 * 60 * 1000)
      fail(`richiesta ${r.id}: orario al nodo non compatibile`);
    // Se il modello include lo snapshot originale, confrontarlo; non e' obbligatorio
    // che una proiezione di evaluation contenga tutte le colonne della richiesta.
    if (r.start_datetime != null &&
        new Date(r.start_datetime).getTime() !== desired)
      fail(`richiesta ${r.id}: orario candidato modificato`);
    if (r.prezzo != null && Number(r.prezzo) !== Number(current.prezzo))
      fail(`richiesta ${r.id}: prezzo candidato modificato`);
    fingerprintRichiesta(current); // fail-closed se la riga DB non e' valida.
  }
  const { rows: reserved } = await client.query(
    'SELECT richiesta_id FROM popbus_attivazione_richieste WHERE richiesta_id=ANY($1::int[]) AND attiva LIMIT 1', [ids]);
  if (reserved.length) fail('richiesta gia riservata');
  const { rows: conflicts } = await client.query(`
    SELECT id FROM popbus_attivazioni
    WHERE veicolo_id=$1 AND stato IN ('in_attesa_autista','confermata')
      AND COALESCE((piano->>'busyStart')::timestamptz,partenza) < $3::timestamptz
      AND COALESCE((piano->>'busyEnd')::timestamptz,arrivo) > $2::timestamptz
    LIMIT 1`, [veicoloId, new Date(start), new Date(end)]);
  if (conflicts.length) fail('veicolo gia impegnato in altra attivazione');
  const { rows: rides } = await client.query(`
    SELECT id FROM corse WHERE veicolo_id=$1
      AND stato IN ('prenotabile','in_corso','da_attivare')
      AND start_datetime < $3::timestamptz
      AND (arrivo_datetime IS NULL OR arrivo_datetime > $2::timestamptz)
    LIMIT 1`, [veicoloId, new Date(start), new Date(end)]);
  if (rides.length) fail('veicolo impegnato in corsa');
  const { rows: legacy } = await client.query(`
    SELECT d.id FROM direttrici_virtuali d JOIN segmenti s ON s.direttrice_id=d.id
    WHERE d.veicolo_id=$1 AND d.stato IN ('in_attesa_autista','attivo','confermata')
      AND d.partenza_prevista < $3::timestamptz
      AND NOT EXISTS (SELECT 1 FROM popbus_attivazioni a WHERE a.direttrice_id=d.id
        AND a.veicolo_id=d.veicolo_id AND a.stato IN ('in_attesa_autista','confermata'))
    GROUP BY d.id HAVING MAX(s.start_datetime+s.tempo_stimato*INTERVAL '1 minute') > $2::timestamptz
    LIMIT 1`, [veicoloId, new Date(start), new Date(end)]);
  if (legacy.length) fail('veicolo impegnato in direttrice legacy');

  // ATTENZIONE: verifica del turno e ricalcolo economico con tariffe correnti
  // DEVONO essere aggiunti prima di usare il ramo in produzione.
  // Il fail-closed evita di scambiare questa fase di staging per il cutover.
  if (process.env.POPBUS_PIXEL_TX_STAGING !== 'ROLLBACK_ONLY')
    fail('modulo abilitato solo in collaudo ROLLBACK_ONLY');

  const piano = {
    ...c.plan, coordinates,
    evaluation: c.evaluation, approach: c.approach, returnTrip: c.returnTrip,
    busyStart: new Date(start).toISOString(), busyEnd: new Date(end).toISOString(),
    requestSnapshot: locked.map(r => ({ id: r.id, fingerprint: fingerprintRichiesta(r) })),
    pixel: { opportunitaId: c.pixelOpportunitaId, direttriceId: c.pixelDirettriceId,
      versione: c.pixelVersione, formazioneKey: key }
  };
  const expiresAt = new Date(Math.min(Date.now()+600000, start));
  if (expiresAt.getTime() <= Date.now()) fail('offerta gia scaduta');
  const { rows: acts } = await client.query(`
    INSERT INTO popbus_attivazioni
      (direttrice_id,pixel_opportunita_id,veicolo_id,autista_id,stato,partenza,arrivo,
       costo,ricavo,tariffa,piano,expires_at)
    VALUES (NULL,$1,$2,$3,'in_attesa_autista',$4,$5,$6,$7,$8,$9::jsonb,$10)
    RETURNING id,expires_at`, [positive(c.pixelOpportunitaId, 'opportunita'), veicoloId,
      ownerId, new Date(departure), new Date(arrival), money(c.cost,'costo'),
      money(c.evaluation.revenue,'ricavo'), money(c.vehicle.euro_km,'tariffa'),
      JSON.stringify(piano), expiresAt]);
  const act = acts[0];
  await registraMissioniAttivazione(client, { attivazioneId: act.id,
    missioni: [{ pixelOpportunitaId: c.pixelOpportunitaId,
      pixelDirettriceId: c.pixelDirettriceId, pixelVersione: c.pixelVersione,
      nodes: c.plan.nodes, legs: c.plan.legs, departure, arrival,
      requests: c.evaluation.requests }] });
  for (const r of c.evaluation.requests) {
    await client.query(`INSERT INTO popbus_attivazione_richieste
      (attivazione_id,richiesta_id,indice_salita,indice_discesa,attiva)
      VALUES ($1,$2,$3,$4,TRUE)`, [act.id,r.id,r.start,r.end]);
  }
  const { rowCount } = await client.query(`UPDATE richieste_pop_bus
    SET stato='in_lavorazione' WHERE id=ANY($1::int[]) AND stato='in_attesa' AND corsa_id IS NULL`, [ids]);
  if (rowCount !== ids.length) fail('rivalidazione finale richieste fallita');
  const { rows: offers } = await client.query(`INSERT INTO offerte_autisti
    (direttrice_id,autista_id,attivazione_id,stato,expires_at)
    VALUES (NULL,$1,$2,'inviata',$3) RETURNING id`, [ownerId,act.id,act.expires_at]);
  return { attivazioneId: act.id, offertaId: offers[0].id,
    formazioneKey: key, richiestaIds: ids, veicoloId, pixelOpportunitaId: c.pixelOpportunitaId };
}
