// routes/admin/notifications.routes.js
import express from 'express'
import { pool } from '../../db/db.js'
import { sendNotification } from '../../socket.js' // <-- aggiornato
import { authMiddleware } from '../../middleware/auth.js'

const router = express.Router()

// GET ultime 20 notifiche admin
router.get('/', authMiddleware, async (req,res)=>{
  try{
    const notifications = await pool.query(`
      SELECT 
        n.id,
        n.type,
        n.message,
        n.created_at,
        false AS seen
      FROM notifications n
      ORDER BY n.created_at DESC
      LIMIT 20
    `)

    const formatted = notifications.rows.map(n => ({
      ...n,
      displayDate: new Date(n.created_at).toLocaleString('it-IT', { 
        weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      })
    }))

    res.json(formatted)
  }catch(err){
    console.error('❌ Fetch admin notifications error:', err)
    res.status(500).json({error:'Errore caricamento notifiche'})
  }
})

// POST mark-seen
router.post('/mark-seen', authMiddleware, async (req,res)=>{
  try{
    const { id } = req.body
    await pool.query(`UPDATE notifications SET seen = true WHERE id = $1`, [id])
    res.json({ success: true })
  }catch(err){
    console.error('❌ Mark notification seen error:', err)
    res.status(500).json({ error:'Errore server' })
  }
})

// POST crea notifica admin
router.post('/create', authMiddleware, async (req,res)=>{
  try {
    const { type, message } = req.body

    const result = await pool.query(`
      INSERT INTO notifications(type, message, created_at)
      VALUES($1,$2,NOW())
      RETURNING id, type, message, created_at
    `, [type, message])

    const notification = result.rows[0]
    notification.displayDate = new Date(notification.created_at).toLocaleString('it-IT', { 
      weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    })
    notification.seen = false

    // Invia live a tutti gli admin
    const adminsRes = await pool.query(`SELECT id FROM utente WHERE LOWER(TRIM(tipo))='admin'`)
    const adminIds = adminsRes.rows.map(a => a.id)
    adminIds.forEach(adminId => sendNotification({ userId: adminId, role: 'Admin', notification }))

    res.json(notification)
  } catch(err){
    console.error('❌ Create admin notification error:', err)
    res.status(500).json({ error:'Errore server' })
  }
})

export default router