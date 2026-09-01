const express = require('express');
const jwt = require('jsonwebtoken');
const Order = require('../models/Order');
const Artikelstamm = require('../models/Artikelstamm');
const ShopfloorUser = require('../models/ShopfloorUser');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const shopfloorAuthMiddleware = require('../middleware/shopfloorAuth');

const router = express.Router();

// Standard-Stationen für den Prozessbegleitschein, je nach Bereich - deckt sich
// mit den bestehenden Phasen (produktion -> endbearbeitung -> ausgeliefert),
// nur feiner aufgeschlüsselt für den Werkstattboden.
const LAUFZETTEL_STATIONEN = {
  Elastomer: ['Formgebung', 'Endbearbeitung', 'Qualitätskontrolle', 'Verpackung', 'Warenausgang'],
  PTFE: ['CNC', 'Endbearbeitung', 'Qualitätskontrolle', 'Verpackung', 'Warenausgang'],
};

function ensureLaufzettel(order) {
  if (order.laufzettel && order.laufzettel.length > 0) return;
  const stationen = LAUFZETTEL_STATIONEN[order.dbType] || LAUFZETTEL_STATIONEN.Elastomer;
  order.laufzettel = stationen.map(station => ({ station, erledigt: false, kuerzel: null, zeitpunkt: null }));
}

// --- Werker-Login (eigener Zugang, getrennt vom Büro-Login) ---

router.post('/login', async (req, res) => {
  try {
    const { kuerzel, pin } = req.body;
    if (!kuerzel || !pin) return res.status(400).json({ error: 'Kürzel und PIN erforderlich' });
    const user = await ShopfloorUser.findOne({ kuerzel: kuerzel.trim().toUpperCase() });
    if (!user) return res.status(401).json({ error: 'Kürzel oder PIN falsch' });
    const valid = await user.comparePin(pin);
    if (!valid) return res.status(401).json({ error: 'Kürzel oder PIN falsch' });
    const token = jwt.sign({ shopfloorUserId: user._id, kuerzel: user.kuerzel, type: 'shopfloor' }, process.env.JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: { id: user._id, kuerzel: user.kuerzel, name: user.name } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Verwaltung der Werker-Konten (aus dem normalen Büro-Login, nur Admins) ---

router.get('/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await ShopfloorUser.find().select('-pin').sort({ kuerzel: 1 });
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { kuerzel, name, pin } = req.body;
    if (!kuerzel || !name || !pin) return res.status(400).json({ error: 'Kürzel, Name und PIN erforderlich' });
    const existing = await ShopfloorUser.findOne({ kuerzel: kuerzel.trim().toUpperCase() });
    if (existing) return res.status(409).json({ error: `Kürzel ${kuerzel} existiert bereits` });
    const user = await ShopfloorUser.create({ kuerzel, name, pin });
    res.status(201).json({ id: user._id, kuerzel: user.kuerzel, name: user.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await ShopfloorUser.deleteOne({ _id: req.params.id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Board für die Werkstatt ---

// Nur laufende Aufträge (Produktion + Endbearbeitung) - Ausgeliefertes ist für
// den Shopfloor nicht mehr relevant.
router.get('/orders', shopfloorAuthMiddleware, async (req, res) => {
  try {
    const orders = await Order.find({ phase: { $in: ['produktion', 'endbearbeitung'] } })
      .select('auftragsnummer artikelnummer beschreibung menge dbType maschineId maschineId2 startDatum endDatum status phase laufzettel')
      .sort({ position: 1 });
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/orders/:orderId', shopfloorAuthMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    ensureLaufzettel(order);
    if (order.isModified()) await order.save();

    const stamm = await Artikelstamm.findOne({ 'artikel.material': order.artikelnummer }).select('artikel.$');
    const artikel = stamm?.artikel?.[0] || null;

    res.json({
      order,
      zeichnung: artikel?.zeichnung || null,
      plp: artikel?.plp || [],
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Laufzettel-Station abhaken bzw. zurücknehmen.
router.patch('/orders/:orderId/laufzettel/:station', shopfloorAuthMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    ensureLaufzettel(order);
    const eintrag = order.laufzettel.find(s => s.station === req.params.station);
    if (!eintrag) return res.status(404).json({ error: 'Station nicht gefunden' });

    const { erledigt } = req.body;
    eintrag.erledigt = erledigt !== undefined ? !!erledigt : !eintrag.erledigt;
    eintrag.kuerzel = eintrag.erledigt ? req.shopfloorKuerzel : null;
    eintrag.zeitpunkt = eintrag.erledigt ? new Date() : null;

    await order.save();
    res.json(order.laufzettel);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Fehlersammelkarte: ein Strich pro Aufruf.
router.post('/orders/:orderId/fehler', shopfloorAuthMiddleware, async (req, res) => {
  try {
    const { fehlerart } = req.body;
    if (!fehlerart) return res.status(400).json({ error: 'Fehlerart fehlt' });
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    order.fehlersammelkarte.push({ fehlerart, kuerzel: req.shopfloorKuerzel, zeitpunkt: new Date() });
    await order.save();
    res.status(201).json(order.fehlersammelkarte);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Letzten Strich einer Fehlerart zurücknehmen (Fehleingabe korrigieren).
router.delete('/orders/:orderId/fehler/:entryId', shopfloorAuthMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    order.fehlersammelkarte = order.fehlersammelkarte.filter(e => String(e._id) !== req.params.entryId);
    await order.save();
    res.json(order.fehlersammelkarte);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
