const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { istInhaber } = require('../lib/inhaber');

// Prüft das Token UND ob das Konto noch freigegeben ist.
//
// Die Freigabe bei jeder Anfrage nachzusehen kostet einen Datenbankzugriff,
// ist aber der einzige Weg, jemanden sofort auszusperren: Tokens laufen sieben
// Tage, ein gesperrtes Konto käme sonst eine Woche lang weiter durch.
//
// Der geladene Benutzer landet in req.user, damit admin- und inhaberMiddleware
// ihn nicht erneut holen müssen.
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Keine Authentifizierung' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'Ungültiges Token' });
    // Das Inhaberkonto bleibt immer offen - sonst könnte eine falsch gesetzte
    // Freigabe den Einzigen aussperren, der sie zurücknehmen kann.
    if (!user.freigegeben && !istInhaber(user)) {
      return res.status(403).json({
        error: user.sperrgrund
          ? `Zugang gesperrt: ${user.sperrgrund}`
          : 'Dein Konto ist noch nicht freigegeben.',
        freigabeFehlt: true,
      });
    }
    req.userId = user._id;
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Ungültiges Token' });
    }
    res.status(500).json({ error: err.message });
  }
};

module.exports = authMiddleware;
