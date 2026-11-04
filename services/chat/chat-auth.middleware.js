import { pool } from "../../db/db.js";
import { canAccessChat } from "./chat-access.service.js";

export async function requireChatAccess(req,res,next) {
  try {
    const source = req.method === "GET" ? req.query : req.body;
    const allowed = await canAccessChat(pool,source?.corsa_id,source?.cliente_id,req.user?.id);
    if (!allowed) return res.status(403).json({message:"Accesso chat non autorizzato"});
    next();
  } catch (err) {
    console.error("CHAT_ACCESS_ERROR",err.message);
    return res.status(500).json({message:"Errore verifica accesso chat"});
  }
}