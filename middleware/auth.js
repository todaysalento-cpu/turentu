import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'segreto-di-test';

// ===================== AUTH =====================
export const authMiddleware = (req, res, next) => {
  let token = req.cookies?.token;

  // 🔹 fallback Authorization header (utile per mobile / test / socket fallback)
  if (!token && req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ error: 'Non autenticato' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    req.user = payload; // { id, role, email, nome }
    next();
  } catch (err) {
    console.error('❌ JWT error:', err.message);
    return res.status(401).json({ error: 'Token non valido' });
  }
};

// ===================== ROLE CHECK =====================
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Non autenticato' });
  }

  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Permesso negato' });
  }

  next();
};