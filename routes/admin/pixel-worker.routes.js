import express from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../../config/security.js';
import {getPixelFirstWorkerStatus,stopPixelFirstWorker} from '../../workers/popbus-pixel-first.worker.js';

export function createPixelWorkerControlRouter({status=getPixelFirstWorkerStatus,stop=stopPixelFirstWorker}={}) {
  const router=express.Router();
  // Explicit Bearer authentication also prevents a cookie-only cross-site stop.
  router.use((req,res,next)=>{
    const header=req.headers.authorization;
    if(!header?.startsWith('Bearer '))return res.status(401).json({error:'Bearer token richiesto'});
    let user;
    try {user=jwt.verify(header.slice(7),JWT_SECRET);} catch {return res.status(401).json({error:'Token non valido'});}
    if(!['Admin','admin'].includes(user?.role))return res.status(403).json({error:'Permesso negato'});
    next();
  });
  router.get('/',(req,res)=>{res.set('Cache-Control','no-store');res.json(status());});
  router.post('/stop',async(req,res,next)=>{
    try {
      const waitMs=req.body?.waitMs ?? 10000;
      if(!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>30000)return res.status(400).json({error:'waitMs deve essere un intero tra 0 e 30000'});
      await stop({waitMs});
      const current=status();
      res.set('Cache-Control','no-store');res.status(current.running?202:200).json(current);
    } catch(error){next(error);}
  });
  return router;
}
export default createPixelWorkerControlRouter();
