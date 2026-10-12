import { analizzaPercorso } from './economicEngine.js';

const timeRome = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function minuti(date) {const p=timeRome.formatToParts(new Date(date));return Number(p.find(x=>x.type==='hour').value)*60+Number(p.find(x=>x.type==='minute').value);}
export function copreTurno(d,start,end) {
  const a=new Date(start).getTime(),b=new Date(end).getTime();
  if (!Number.isFinite(a)||!Number.isFinite(b)||b<=a) return false;
  // Non indovinare la semantica di eccezioni non ancora documentate.
  if ((d.giorni_esclusi||[]).length || (d.inattivita||[]).length) return false;
  if (d.manual) return new Date(d.start).getTime()<=a && new Date(d.fine).getTime()>=b;
  const from=minuti(d.start),to=minuti(d.fine);
  for(let t=a;t<b;t+=60000) {
    const m=minuti(t);
    if (!(from<to ? m>=from&&m<to : from>to ? m>=from||m<to : false)) return false;
  }
  return true;
}

export async function assegnaVeicoliEDirettrici(client,segmentiAttivati) {
  await client.query('SELECT pg_advisory_xact_lock(734021,1)');
  const assigned=[];
  for(const dirId of [...new Set(segmentiAttivati.map(s=>Number(s.direttrice_id)))]) {
    const {rows:ds}=await client.query('SELECT * FROM direttrici_virtuali WHERE id=$1 FOR UPDATE',[dirId]);
    const d=ds[0];if(!d||d.stato!=='in_formazione')continue;
    const {rows:ss}=await client.query(`SELECT s.*,ST_Distance(a.posizione::geography,b.posizione::geography)/1000 AS km
      FROM segmenti s JOIN nodi_direttrice a ON a.id=s.start_node_id JOIN nodi_direttrice b ON b.id=s.end_node_id
      WHERE s.direttrice_id=$1 ORDER BY s.ordine_sequenziale FOR UPDATE OF s`,[dirId]);
    const {rows:rr}=await client.query(`SELECT * FROM richieste_pop_bus WHERE direttrice_id=$1
      AND stato IN ('in_attesa','in_lavorazione') FOR UPDATE`,[dirId]);
    let route;try {route=analizzaPercorso(ss,rr,d.partenza_prevista);} catch(e){throw new Error(`Direttrice ${dirId}: ${e.message}`);}
    const km=ss.reduce((acc,s)=>acc+Number(s.km),0),ricavo=rr.reduce((acc,r)=>acc+Number(r.prezzo),0);
    const {rows:vs}=await client.query(`SELECT v.id,v.driver_id,v.posti_totali,t.euro_km,
      dv.start,dv.fine,dv.manual,dv.giorni_esclusi,dv.inattivita
      FROM veicolo v JOIN disponibilita_veicolo dv ON dv.veicolo_id=v.id
      JOIN LATERAL (SELECT MIN(euro_km) AS euro_km FROM tariffe WHERE veicolo_id=v.id AND tipo='standard' AND euro_km>0) t ON t.euro_km IS NOT NULL
      WHERE v.driver_id IS NOT NULL AND v.posti_totali >= $1
        AND ($3::int IS NULL OR v.id=$3::int)
        AND NOT EXISTS (SELECT 1 FROM direttrici_virtuali od JOIN veicolo ov ON ov.id=od.veicolo_id
          WHERE od.id<>$2 AND od.stato IN ('in_formazione','in_attesa_autista','attivo','confermata')
            AND (ov.id=v.id OR ov.driver_id=v.driver_id))
        AND NOT EXISTS (SELECT 1 FROM corse c JOIN veicolo cv ON cv.id=c.veicolo_id
          WHERE c.stato IN ('prenotabile','in_corso','da_attivare') AND (cv.id=v.id OR cv.driver_id=v.driver_id)
            AND (c.arrivo_datetime IS NULL OR (c.start_datetime<$5::timestamptz AND c.arrivo_datetime>$4::timestamptz)))
      ORDER BY t.euro_km,v.id FOR UPDATE OF v`,[route.picco,dirId,d.veicolo_id,d.partenza_prevista,route.arrivo]);
    // Sostenibilità minima dell'intera andata: nessun ricavo contato due volte.
    const v=vs.find(v=>ricavo>=km*Number(v.euro_km)&&copreTurno(v,d.partenza_prevista,route.arrivo));
    if(!v) {
      await client.query(`UPDATE segmenti SET stato='in_attesa' WHERE direttrice_id=$1 AND stato='attivo'`,[dirId]);
      continue;
    }
    await client.query(`UPDATE direttrici_virtuali SET veicolo_id=$2,stato='in_attesa_autista',
      distanza_totale_km=$3,soglia_attivazione=$4 WHERE id=$1`,[dirId,v.id,km,km*Number(v.euro_km)]);
    assigned.push(...segmentiAttivati.filter(s=>Number(s.direttrice_id)===dirId));
  }
  return assigned;
}
