const User = require('../models/User');
const { istInhaber } = require('../lib/inhaber');

// Muss nach authMiddleware laufen (die legt req.user ab).
// Strenger als adminMiddleware: nur das Inhaber-Konto, nicht jeder Admin.
const inhaberMiddleware = async (req, res, next) => {
  try {
    const user = req.user || await User.findById(req.userId);
    if (!istInhaber(user)) return res.status(403).json({ error: 'Nur für den Inhaber' });
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = inhaberMiddleware;
