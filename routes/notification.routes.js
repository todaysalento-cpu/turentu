// routes/notification.routes.js
import express from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { pool } from '../db/db.js'
import { sendNotification } from '../socket.js' // <-- IMPORT CORRETTO

const router = express.Router()

// Funzioni di utilità...
function generateNotificationMessage({ type, corsaId, startAddress, endAddress, userRole }) {
  if (type === 'pending') {
    return userRole === 'autista'
      ? `Nuova corsa da confermare 🏁 ${startAddress} → ${endAddress}`
      : `Hai richiesto una corsa 🏁 ${startAddress} → ${endAddress}`
  }
  if (type === 'info') return `La corsa è stata completata ✅`
  return 'Nuova notifica'
}

function formatNotificationDate(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return ''
  const now = new Date()
  const time = date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })

  const isToday = date.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday = date.toDateString() === yesterday.toDateString()

  if (isToday) return `oggi alle ${time}`
  if (isYesterday) return `ieri alle ${time}`
  const dayName = date.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit' })
  return `${dayName} alle ${time}`
}

// GET tutte le notifiche
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id
    const result = await pool.query(
      `SELECT id, type, message, seen, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    )

    const notifications = result.rows.map(n => ({
      ...n,
      displayDate: formatNotificationDate(n.created_at),
      seen: n.seen === true || n.seen === 't'
    }))

    res.json(notifications)
  } catch (err) {
    console.error('❌ Fetch notifications error:', err)
    res.status(500).json({ message: 'Errore server' })
  }
})

// POST mark-seen
router.post('/mark-seen', authMiddleware, async (req, res) => {
  try {
    const { id } = req.body
    const userId = req.user.id
    await pool.query(
      `UPDATE notifications SET seen = true WHERE user_id = $1 AND id = $2`,
      [userId, id]
    )
    res.json({ success: true })
  } catch (err) {
    console.error('❌ Mark notification seen error:', err)
    res.status(500).json({ message: 'Errore server' })
  }
})

// POST crea notifica
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { type, targetUserId, corsaId, startAddress, endAddress } = req.body
    const userId = targetUserId || req.user.id

    const roleRes = await pool.query(`SELECT role FROM users WHERE id = $1`, [userId])
    const userRole = roleRes.rows[0]?.role
    if (!userRole) return res.status(400).json({ message: 'Utente non trovato' })

    const message = generateNotificationMessage({ type, corsaId, startAddress, endAddress, userRole })

    const result = await pool.query(
      `INSERT INTO notifications(user_id, type, message, seen, created_at)
       VALUES($1, $2, $3, false, NOW()) RETURNING *`,
      [userId, type, message]
    )

    const notification = result.rows[0]
    notification.displayDate = formatNotificationDate(notification.created_at)
    notification.seen = false

    // 🔔 INVIO LIVE VIA SOCKET
    sendNotification({ userId, role: userRole, notification })

    res.json(notification)
  } catch (err) {
    console.error('❌ Create notification error:', err)
    res.status(500).json({ message: 'Errore server' })
  }
})

export { router as notificationsRouter }