import jwt from 'jsonwebtoken';

export const authMiddleware = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Non autenticato' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'segreto-di-test');
    req.user = payload; // { id, role, email, nome }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token non valido' });
  }
};

export const requireRole = (role) => (req, res, next) => {
  if (!req.user || req.user.role !== role) return res.status(403).json({ error: 'Permesso negato' });
  next();
};
