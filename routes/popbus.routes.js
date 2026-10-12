import express from 'express';
import {pool} from '../db/db.js';
import {authMiddleware} from '../middleware/auth.js';
import {getIO} from '../socket.js';
import {CacheManager} from '../utils/cacheManager.js';
import {upsertCorsa} from '../services/search/search.cache.js';
import {accettaAttivazione} from '../services/popbus/v2/acceptance.js';
const router=express.Router();router.use(authMiddleware);
router.get('/offerte/veicolo/:veicolo_id',async(req,res)=>{
 try{const {rows}=await pool.query(`SELECT o.id,o.attivazione_id,a.direttrice_id,a.veicolo_id,a.autista_id,
   a.partenza AS orario,a.ricavo AS prezzo,a.piano->>'classe' AS classe,a.piano->'evaluation'->>'peak' AS posti_richiesti,
   a.piano->'coordinates'->0->>'nome_nodo' AS origine_address,
   a.piano->'coordinates'->-1->>'nome_nodo' AS destinazione_address,o.expires_at
   FROM offerte_autisti o JOIN popbus_attivazioni a ON a.id=o.attivazione_id
   JOIN veicolo v ON v.id=a.veicolo_id WHERE o.autista_id=$1 AND v.driver_id=$1 AND v.id=$2
   AND o.stato='inviata' AND a.stato='in_attesa_autista' AND o.expires_at>NOW()`,[req.user.id,req.params.veicolo_id]);res.json({offerte:rows});}
 catch(e){res.status(500).json({error:e.message});}
});
router.post('/:offerta_id/accetta',async(req,res)=>{
 const client=await pool.connect();let tx=false;
 try{
  const id=Number(req.params.offerta_id);if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:'ID non valido'});
  await client.query('BEGIN');tx=true;
  const corsa=await accettaAttivazione(client,id,req.user.id);
  await client.query('COMMIT');tx=false;
  if(!corsa.giaAccettata){try{CacheManager.corsa.update(corsa);upsertCorsa(corsa);getIO().to(`autista_${req.user.id}`).emit('nuova_corsa_popbus',corsa);}catch(e){console.error('[V2 POST-COMMIT]',e.message);}}
  res.json({ok:true,corsa_id:corsa.id});
 }catch(e){if(tx)await client.query('ROLLBACK');res.status(409).json({error:e.message});}finally{client.release();}
});
export {router as popbusRouter};
