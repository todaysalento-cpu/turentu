import { getIO } from '../../socket.js';

// La coda è emessa dal worker esclusivamente dopo il COMMIT.
export async function dispatchDirettriciAttive(segmenti,client,eventi) {
  if(!client||!Array.isArray(eventi))throw new Error('Dispatch richiede transazione e coda post-commit');
  let count=0;
  for(const id of [...new Set(segmenti.map(s=>Number(s.direttrice_id)))]) {
    const {rows:ds}=await client.query(`SELECT d.id,d.tipo_servizio,d.veicolo_id,v.driver_id,
      (SELECT MAX(posti_occupati) FROM segmenti WHERE direttrice_id=d.id) AS posti,
      (SELECT id FROM segmenti WHERE direttrice_id=d.id AND stato='attivo' ORDER BY ordine_sequenziale,id LIMIT 1) AS segmento_id
      FROM direttrici_virtuali d JOIN veicolo v ON v.id=d.veicolo_id
      WHERE d.id=$1 AND d.stato='in_attesa_autista' FOR UPDATE OF d`,[id]);
    const d=ds[0];if(!d?.driver_id||!d.segmento_id)continue;
    const {rows:old}=await client.query(`SELECT id FROM offerte_autisti WHERE direttrice_id=$1
      AND stato IN ('accettata','inviata') AND (stato='accettata' OR expires_at>NOW())`,[id]);
    if(old.length)continue;
    const {rows:offer}=await client.query(`INSERT INTO offerte_autisti(direttrice_id,autista_id,stato,expires_at,created_at)
      VALUES ($1,$2,'inviata',NOW()+INTERVAL '10 minutes',NOW()) RETURNING id`,[id,d.driver_id]);
    eventi.push({room:`autista_${d.driver_id}`,payload:{id:offer[0].id,direttrice_id:id,
      segmento_id:d.segmento_id,veicolo_id:d.veicolo_id,classe:d.tipo_servizio,posti_richiesti:Number(d.posti)}});
    count++;
  }
  return count;
}
export function emettiDispatch(eventi) {
  for(const e of eventi) {
    try {getIO().to(e.room).emit('nuova_proposta_popbus',e.payload);}
    catch(err) {console.error('[DISPATCH POST-COMMIT] Offerta salvata, evento non emesso:',err.message);}
  }
}
