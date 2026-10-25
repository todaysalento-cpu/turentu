// TURENTU POPBUS P0-C2 — verifica relazionale multi-missione.
// Da eseguire all'interno della transazione del chiamante. Solo SELECT con lock;
// nessuna scrittura, nessun accesso Stripe, nessuna apertura di transazioni.
import { validaPianoMultiMissione, validaOccupazioneMultiMissione } from './popbus-multimission-preflight.js';

const id = (v, label) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`P0-C2: ${label} non valido`);
  return n;
};
const idx = (v, label) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`P0-C2: ${label} non valido`);
  return n;
};
const fail = (message) => { throw new Error(`P0-C2: ${message}`); };
const same = (a,b) => Number(a) === Number(b);
const stamp = (v) => new Date(v).getTime();
const near = (a,b) => Number.isFinite(stamp(a)) && Number.isFinite(stamp(b)) && Math.abs(stamp(a)-stamp(b)) <= 1000;
const isV2 = (p) => p?.schemaVersion === 2 && p?.tipoItinerario === 'FERMATE_FISICHE';
const sequence = (a,b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((v,i) => same(v,b[i]));

export async function verificaMissioniPersistite(client, { attivazioneId, piano, veicoloId, postiTotali }) {
  if (!client || typeof client.query !== 'function') fail('client PostgreSQL mancante');
  const aid = id(attivazioneId, 'attivazione');
  const pre = validaPianoMultiMissione(piano, { veicoloId, postiTotali });
  const { rows: missioni } = await client.query(`
    SELECT id, ordine, direttrice_id, corridoio_pixel_id, pixel_opportunita_id, nodi_territoriali,
           partenza, arrivo, piano
    FROM public.popbus_attivazione_missioni
    WHERE attivazione_id = $1
    ORDER BY ordine
    FOR SHARE
  `, [aid]);
  if (missioni.length !== piano.missioni.length) fail('numero missioni persistite discordante');
  const v2 = isV2(piano);
  const missionIds = new Set();
  const expected = new Map();
  for (let i = 0; i < missioni.length; i++) {
    const db = missioni[i], m = piano.missioni[i];
    const mid = id(db.id, 'missione');
    if (missionIds.has(mid) || !same(db.ordine, i + 1)) fail('ordine/ID missioni non valido');
    missionIds.add(mid);
    const start = idx(m.startIndex, 'inizio missione');
    const end = idx(m.endIndex, 'fine missione');
    const territorial = db.nodi_territoriali;
    const physical = piano.nodes.slice(start,end+1);
    const expectedTerritorial = v2 ? m.nodiTerritoriali : physical;
    if (!sequence(territorial,expectedTerritorial)) fail('nodi missione discordanti');
    if (!near(db.partenza,m.partenza) || !near(db.arrivo,m.arrivo)) fail('orari missione discordanti');
    let payload;
    try { payload = typeof db.piano === 'string' ? JSON.parse(db.piano) : db.piano; }
    catch { fail('JSON piano locale non valido'); }
    if (!payload || !sequence(payload.nodes,physical) ||
        !Array.isArray(payload.legs) || payload.legs.length !== physical.length-1 ||
        !Array.isArray(payload.requests)) fail('piano locale persistito incoerente');
    if (v2) {
      if (db.direttrice_id != null) fail('direttrice legacy persistita in V2');
      if (payload.schemaVersion !== 2 || payload.tipoItinerario !== 'FERMATE_FISICHE')
        fail('marker fisico JSON persistito incoerente');
      if (!same(db.pixel_opportunita_id,m.pixelOpportunitaId) ||
          !same(payload.pixel?.opportunitaId,m.pixelOpportunitaId))
        fail('opportunita PIXEL persistita discordante');
      if (!same(payload.pixel?.direttriceId,m.pixelDirettriceId) ||
          !same(payload.pixel?.versione,m.pixelVersione))
        fail('identita/versione PIXEL persistita discordante');
      if (typeof db.corridoio_pixel_id !== 'string' ||
          db.corridoio_pixel_id !== m.corridoioPixelId ||
          payload.pixel?.engineId !== m.corridoioPixelId)
        fail('engine ID PIXEL persistito discordante');
      if (!sequence(payload.pixel?.nodiTerritoriali,expectedTerritorial))
        fail('nodi PIXEL nel JSON persistito discordanti');
    }
    // Non confrontiamo solo i nodi: anche le tratte devono corrispondere all'assembler.
    for (let j=0;j<payload.legs.length;j++) {
      const local=payload.legs[j], global=piano.legs[start+j];
      if (!local || !global || String(local.polyline)!==String(global.polyline) ||
          !same(local.seconds,global.seconds) || !same(local.metres,global.metres))
        fail('tratte missione discordanti');
    }
    for (const r of payload.requests) {
      const rid=id(r.id,'richiesta locale'), s=idx(r.start,'salita locale'), e=idx(r.end,'discesa locale');
      if (s>=e || e>=physical.length || expected.has(rid)) fail('richieste locali incoerenti');
      expected.set(rid,{ missioneId:mid, localStart:s,localEnd:e,globalStart:start+s,globalEnd:start+e });
    }
  }
  const { rows: locali } = await client.query(`
    SELECT mr.missione_id, mr.richiesta_id, mr.indice_salita, mr.indice_discesa
    FROM public.popbus_missione_richieste mr
    JOIN public.popbus_attivazione_missioni m ON m.id = mr.missione_id
    WHERE m.attivazione_id = $1
    ORDER BY mr.richiesta_id
    FOR SHARE OF mr, m
  `,[aid]);
  if (locali.length!==expected.size) fail('numero associazioni locali discordante');
  const seenLocal=new Set();
  for (const r of locali) {
    const rid=id(r.richiesta_id,'richiesta locale DB'), e=expected.get(rid);
    if (!e || seenLocal.has(rid) || !same(r.missione_id,e.missioneId) ||
        !same(r.indice_salita,e.localStart) || !same(r.indice_discesa,e.localEnd))
      fail('associazione locale discordante');
    seenLocal.add(rid);
  }
  const { rows: globali } = await client.query(`
    SELECT richiesta_id, indice_salita, indice_discesa, attiva
    FROM public.popbus_attivazione_richieste
    WHERE attivazione_id = $1
    ORDER BY richiesta_id
    FOR SHARE
  `,[aid]);
  if (globali.length!==expected.size) fail('numero associazioni globali discordante');
  const seenGlobal=new Set();
  for (const r of globali) {
    const rid=id(r.richiesta_id,'richiesta globale DB'), e=expected.get(rid);
    if (!e || seenGlobal.has(rid) || r.attiva !== true ||
        !same(r.indice_salita,e.globalStart) || !same(r.indice_discesa,e.globalEnd))
      fail('associazione globale discordante');
    seenGlobal.add(rid);
  }
  const planIds=new Set(piano.evaluation.requests.map(r=>id(r.id,'richiesta piano')));
  if (planIds.size!==expected.size) fail('richieste piano discordanti');
  for (const r of piano.evaluation.requests) {
    const e=expected.get(Number(r.id));
    if (!e || !same(r.start,e.globalStart) || !same(r.end,e.globalEnd))
      fail('mapping assembler discordante');
  }
  // La capienza viene verificata sui posti reali delle richieste bloccate.
  const { rows: richieste } = await client.query(`
    SELECT id, posti_richiesti, stato, corsa_id
    FROM public.richieste_pop_bus
    WHERE id = ANY($1::bigint[])
    ORDER BY id
    FOR UPDATE
  `,[[...expected.keys()]]);
  if (richieste.length!==expected.size || richieste.some(r=>r.stato!=='in_lavorazione' || r.corsa_id!=null))
    fail('richieste DB mancanti o non disponibili');
  const occupazione=validaOccupazioneMultiMissione(piano,richieste,postiTotali);
  return { ...pre, ...occupazione, missioniPersistite:missioni.length, richiesteVerificate:richieste.length };
}
