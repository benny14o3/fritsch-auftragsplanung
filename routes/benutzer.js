const express = require('express');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const inhaberMiddleware = require('../middleware/inhaber');
const { istInhaber } = require('../lib/inhaber');
const { ALLE_RECHTE, BESCHRIFTUNG, rechteVon } = require('../lib/auftragsrechte');

// Zugangsverwaltung. Bewusst nur für den Inhaber, nicht für jeden Admin:
// wer Zugänge freigeben darf, kann sich sonst Mitwisser ins System holen,
// ohne dass es auffällt.
const router = express.Router();

function alsAntwort(u) {
  return {
    id: u._id,
    email: u.email,
    name: u.name,
    role: u.role,
    // Bei Admins die vollen Rechte zeigen, auch wenn nichts gespeichert ist -
    // sonst sieht es in der Oberflaeche so aus, als duerften sie nichts.
    rechte: rechteVon(u),
    freigegeben: u.freigegeben,
    freigegebenAm: u.freigegebenAm,
    freigegebenVon: u.freigegebenVon,
    sperrgrund: u.sperrgrund || '',
    letzterLogin: u.letzterLogin,
    createdAt: u.createdAt,
    inhaber: istInhaber(u),
    // Adressen ausserhalb der eigenen Firmen-Domains sichtbar machen - bei
    // einem Zugang von aussen soll man zweimal hinsehen.
    extern: !/@fritsch-weinheim\.com$/i.test(String(u.email || '')),
  };
}

router.get('/', authMiddleware, inhaberMiddleware, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ freigegeben: 1, createdAt: 1 });
    const liste = users.map(alsAntwort);
    res.json({
      benutzer: liste,
      offen: liste.filter(u => !u.freigegeben).length,
      // Die Oberflaeche baut die Auswahl daraus - so steht die Liste der
      // Rechte an einer Stelle (lib/auftragsrechte.js) und nicht doppelt.
      rechteKatalog: ALLE_RECHTE.map(r => ({ schluessel: r, name: BESCHRIFTUNG[r] })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Freigeben, sperren oder die Rolle ändern.
router.patch('/:id', authMiddleware, inhaberMiddleware, async (req, res) => {
  try {
    const { freigegeben, role, sperrgrund, rechte } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    // Das eigene Konto nicht sperren und nicht degradieren - sonst steht
    // niemand mehr zur Verfügung, der die Sperre zurücknehmen könnte.
    if (istInhaber(user) && (freigegeben === false || (role && role !== 'admin'))) {
      return res.status(400).json({ error: 'Das Inhaberkonto kann sich nicht selbst sperren' });
    }
    if (freigegeben !== undefined && freigegeben !== user.freigegeben) {
      user.freigegeben = !!freigegeben;
      if (user.freigegeben) {
        user.freigegebenAm = new Date();
        user.freigegebenVon = req.user.email;
        user.sperrgrund = '';
      } else {
        user.freigegebenAm = null;
        user.sperrgrund = String(sperrgrund || '').trim();
      }
    } else if (sperrgrund !== undefined && !user.freigegeben) {
      user.sperrgrund = String(sperrgrund).trim();
    }
    if (role && ['admin', 'user'].includes(role)) user.role = role;
    // Unbekannte Schluessel verwerfen, statt sie zu speichern - sonst stuende
    // im Konto ein Recht, das es nicht gibt.
    if (Array.isArray(rechte)) user.rechte = rechte.filter(r => ALLE_RECHTE.includes(r));
    await user.save();
    res.json(alsAntwort(user));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', authMiddleware, inhaberMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    if (istInhaber(user)) return res.status(400).json({ error: 'Das Inhaberkonto kann nicht gelöscht werden' });
    await User.deleteOne({ _id: user._id });
    res.json({ success: true, email: user.email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
