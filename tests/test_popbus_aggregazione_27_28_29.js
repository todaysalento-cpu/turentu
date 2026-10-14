// TURENTU POPBUS V2 - diagnostica aggregazione 27, 28, 29
// READ ONLY. Nessuna chiamata Google, nessuna modifica DB.
import { pool } from '../db/db.js';

const TARGET_IDS = [27, 28, 29];
const n = x => Number(x);
const round = x => Math.round(x * 100) / 100;
const radians = x => x * Math.PI / 180;
function haversine(a, b) {
  if (![a.lat,a.lon,b.lat,b.lon].every(Number.isFinite)) return null;
  const R=6371, dLat=radians(b.lat-a.lat), dLon=radians(b.lon-a.lon);
  const q=Math.sin(dLat/2)**2+Math.cos(radians(a.lat))*Math.cos(radians(b.lat))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(q)));
}
function combinations(rows, capacity) {
  const out=[];
  function walk(index, picked, seats, revenue) {
    if(picked.length) out.push({ids:picked.map(x=>x.id).sort((a,b)=>a-b),posti:seats,ricavo:round(revenue)});
    for(let j=index;j<rows.length;j++) {
      const next=seats+rows[j].posti;
      if(next<=capacity)walk(j+1,[...picked,rows[j]],next,revenue+rows[j].prezzo);
    }
  }
  walk(0,[],0,0);
  return out.sort((a,b)=>b.ricavo-a.ricavo || a.posti-b.posti);
}
function log(label,value){console.log(`\n[${label}] ${JSON.stringify(value,null,2)}`);}
async function main(){
  const client=await pool.connect();
  let begun=false;
  try {
    await client.query('BEGIN READ ONLY'); begun=true;
    await client.query("SET LOCAL statement_timeout = '20000ms'");
    const {rows:req}=await client.query(`
      SELECT id,cliente_id,start_node_id,end_node_id,start_datetime,posti_richiesti,
             prezzo,classe,stato,corsa_id
      FROM public.richieste_pop_bus WHERE id=ANY($1::int[]) ORDER BY id`,[TARGET_IDS]);
    log('RICHIESTE',req);
    const reasons=[];
    if(req.length!==TARGET_IDS.length) reasons.push('Una o piu richieste non esistono');
    if(req.some(r=>r.stato!=='in_attesa'||r.corsa_id!==null)) reasons.push('Richiesta non in_attesa o gia associata a corsa');
    if(new Set(req.map(r=>`${r.start_node_id}|${r.end_node_id}|${new Date(r.start_datetime).toISOString()}`)).size!==1)
      reasons.push('Origine/destinazione/orario differenti');
    const ids=req.map(r=>r.id);
    const {rows:active}=await client.query(`
      SELECT richiesta_id FROM public.popbus_attivazione_richieste
      WHERE richiesta_id=ANY($1::int[]) AND attiva`,[TARGET_IDS]);
    if(active.length) reasons.push('Richieste associate ad attivazioni attive');
    log('CONTROLLO_GRUPPO',{valido:reasons.length===0,motivi:reasons,attivazioni_attive:active});
    const {rows:vs}=await client.query(`
      SELECT v.id,v.modello,v.posti_totali,v.driver_id,t.euro_km,
             dv.start,dv.fine,dv.manual,dv.giorni_esclusi,dv.inattivita,
             ST_Y(COALESCE(dv.coord,v.coord)::geometry) AS lat,
             ST_X(COALESCE(dv.coord,v.coord)::geometry) AS lon
      FROM public.veicolo v
      JOIN public.disponibilita_veicolo dv ON dv.veicolo_id=v.id
      JOIN LATERAL (
        SELECT MIN(euro_km) AS euro_km FROM public.tariffe
        WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0
      ) t ON t.euro_km IS NOT NULL
      WHERE v.driver_id IS NOT NULL AND v.posti_totali>0
        AND COALESCE(dv.coord,v.coord) IS NOT NULL
      ORDER BY t.euro_km,v.id`);
    const maxSeats=Math.max(0,...vs.map(v=>n(v.posti_totali)));
    const normalized=req.map(r=>({id:n(r.id),posti:n(r.posti_richiesti),prezzo:n(r.prezzo)}));
    const forms=combinations(normalized,maxSeats);
    log('FORMAZIONI',{max_posti_flotta:maxSeats,totale:forms.length,prime_otto:forms.slice(0,8),
      aggregazione_completa_presente:forms.some(f=>f.ids.join(',')==='27,28,29')});
    const totalSeats=normalized.reduce((s,r)=>s+r.posti,0);
    const totalRevenue=normalized.reduce((s,r)=>s+r.prezzo,0);
    const nodeIds=[...new Set(req.flatMap(r=>[r.start_node_id,r.end_node_id]))];
    const {rows:nodes}=await client.query(`
      SELECT id,ST_Y(posizione::geometry) lat,ST_X(posizione::geometry) lon
      FROM public.nodi_direttrice WHERE id=ANY($1::int[])`,[nodeIds]);
    const nodeMap=new Map(nodes.map(p=>[n(p.id),{lat:n(p.lat),lon:n(p.lon)}]));
    const origin=nodeMap.get(n(req[0]?.start_node_id));
    const destination=nodeMap.get(n(req[0]?.end_node_id));
    const commercialStraight=origin&&destination?haversine(origin,destination):null;
    const candidates=vs.map(v=>{
      const seats=n(v.posti_totali),rate=n(v.euro_km);
      const base={lat:n(v.lat),lon:n(v.lon)};
      const approach=origin?haversine(base,origin):null;
      const returnKm=destination?haversine(destination,base):null;
      const straightKm=[approach,commercialStraight,returnKm].every(Number.isFinite)
        ?approach+commercialStraight+returnKm:null;
      const lowerBoundCost=straightKm===null?null:round(Math.ceil(straightKm*rate*100)/100);
      const maxMargin=lowerBoundCost===null?null:round(totalRevenue-lowerBoundCost);
      return {veicolo:n(v.id),modello:v.modello,posti:seats,euro_km:rate,
        capienza_ok:seats>=totalSeats,km_linea_aria_minimi:straightKm===null?null:round(straightKm),
        costo_minimo_geometrico_euro:lowerBoundCost,
        margine_massimo_teorico_euro:maxMargin,
        nota:'NON sono km stradali; NON verifica turno, conflitti, soglia EXPRESS o commissioni'};
    });
    log('VEICOLI_CAPIENTI_E_STIMA_GEOMETRICA',candidates.filter(v=>v.capienza_ok));
    log('CONCLUSIONE',{richieste:ids,posti_totali:totalSeats,ricavo_totale_euro:round(totalRevenue),
      mezzi_capienti:candidates.filter(v=>v.capienza_ok).length,
      routing_google_effettuato:0,modifiche_database:0,
      avvertenza:'Per spiegare esclusioni effettive serve tracing della valutazione con gli stessi percorsi stradali del test principale.'});
  } finally {
    if(begun) await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}
main().catch(e=>{console.error('[ERRORE]',e);process.exitCode=1;});
