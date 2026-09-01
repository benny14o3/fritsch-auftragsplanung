const jwt = require('jsonwebtoken');

// Eigenes Token für den Shopfloor-Zugang (type: 'shopfloor'), damit ein Büro-Token
// (routes/auth.js) hier nicht funktioniert und umgekehrt.
const shopfloorAuthMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Keine Authentifizierung' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'shopfloor') return res.status(401).json({ error: 'Ungültiges Token' });
    req.shopfloorUserId = decoded.shopfloorUserId;
    req.shopfloorKuerzel = decoded.kuerzel;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Ungültiges Token' });
  }
};

module.exports = shopfloorAuthMiddleware;
