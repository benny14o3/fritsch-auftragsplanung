const express = require('express');
const jwt = require('jsonwebtoken');
const Order = require('../models/Order');
const Artikelstamm = require('../models/Artikelstamm');
const ShopfloorUser = require('../models/ShopfloorUser');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const shopfloorAuthMiddleware = require('../middleware/shopfloorAuth');

const router = express.Router();

// Den vollen Artikelstamm-Eintrag (inkl. Prüfpunkt-_ids) zu einem Auftrag holen -
// Laufzettel, Erstfreigabe und Fehlersammelkarte hängen alle am artikel.plp.
async function getArtikelFuerOrder(order) {
  const stamm = await Artikelstamm.findOne({ 'artikel.material': order.artikelnummer }).select('artikel.$');
  return stamm?.artikel?.[0] || null;
}

// Prozessbegleitschein: ein Eintrag je Prozessschritt-Prüfpunkt (typ: 'prozess')
// aus dem Produktionslenkungsplan des Artikels - nur beim ersten Aufruf befüllt,
// damit bereits abgehakter Fortschritt nicht überschrieben wird.
function ensureLaufzettel(order, artikel) {
  if (order.laufzettel && order.laufzettel.length > 0) return;
  const prozessPunkte = (artikel?.plp || []).filter(p => p.typ === 'prozess');
  order.laufzettel = prozessPunkte.map(p => ({
    pruefpunktId: p._id, bezeichnung: p.bezeichnung, erledigt: false, kuerzel: null, zeitpunkt: null,
  }));
}

// Erstfreigabe ist nur nötig, wenn der Artikel überhaupt Prüfpunkte hat - ohne
// PLP gibt es nichts freizugeben und nichts zu sperren.
function istErstfreigabeErforderlich(artikel) {
  return !!(artikel?.plp && artikel.plp.length > 0);
}

function istErstfreigabeOffen(order, artikel) {
  return istErstfreigabeErforderlich(artikel) && !order.erstfreigabe?.erteilt;
}

function berechneIoNio(istwert, toleranzMin, toleranzMax) {
  const hatMin = toleranzMin !== undefined && toleranzMin !== null;
  const hatMax = toleranzMax !== undefined && toleranzMax !== null;
  if (hatMin && istwert < toleranzMin) return 'n.i.O.';
  if (hatMax && istwert > toleranzMax) return 'n.i.O.';
  return 'i.O.';
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
      .select('auftragsnummer artikelnummer beschreibung menge dbType maschineId maschineId2 startDatum endDatum status phase laufzettel erstfreigabe')
      .sort({ position: 1 });
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Alle Aufträge eines Artikels über alle Phasen hinweg - für den FSK-Historie-
// Export direkt am Shopfloor-Bildschirm (nicht nur die aktuell laufenden).
router.get('/artikel/:material/auftraege', shopfloorAuthMiddleware, async (req, res) => {
  try {
    const orders = await Order.find({ artikelnummer: req.params.material })
      .select('auftragsnummer bestellnummer startDatum endDatum phase status fehlersammelkarte massungen erstfreigabe laufzettel createdAt')
      .sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/orders/:orderId', shopfloorAuthMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    const artikel = await getArtikelFuerOrder(order);
    ensureLaufzettel(order, artikel);
    if (order.isModified()) await order.save();

    res.json({
      order,
      zeichnung: artikel?.zeichnung || null,
      einstelldatenblatt: artikel?.einstelldatenblatt || null,
      plp: artikel?.plp || [],
      erstfreigabeErforderlich: istErstfreigabeErforderlich(artikel),
      erstfreigabeOffen: istErstfreigabeOffen(order, artikel),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Erstfreigabe erteilen: Istwerte zu allen Maßprüfungs-Prüfpunkten des Artikels
// müssen vorhanden und i.O. sein, sonst wird nicht freigegeben (ISO 9001 -
// eine Erstfreigabe mit n.i.O.-Werten wäre keine Freigabe). Solange sie
// aussteht, sperren die Routen unten Laufzettel/FSK für diesen Auftrag.
router.post('/orders/:orderId/erstfreigabe', shopfloorAuthMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    const artikel = await getArtikelFuerOrder(order);
    if (!istErstfreigabeErforderlich(artikel)) {
      return res.status(400).json({ error: 'Für diesen Artikel sind keine Prüfpunkte hinterlegt - keine Erstfreigabe nötig' });
    }
    if (order.erstfreigabe?.erteilt) {
      return res.status(409).json({ error: 'Erstfreigabe wurde bereits erteilt' });
    }

    const massPunkte = artikel.plp.filter(p => p.typ === 'masspruefung');
    const eingaben = new Map((req.body.messungen || []).map(m => [String(m.pruefpunktId), m.istwert]));

    const messungen = [];
    const fehlend = [];
    const nichtIo = [];
    massPunkte.forEach(p => {
      const istwert = eingaben.get(String(p._id));
      if (istwert === undefined || istwert === null || istwert === '') {
        fehlend.push(p.bezeichnung);
        return;
      }
      const wert = Number(istwert);
      const ioNio = berechneIoNio(wert, p.toleranzMin, p.toleranzMax);
      if (ioNio === 'n.i.O.') nichtIo.push(p.bezeichnung);
      messungen.push({
        pruefpunktId: p._id, bezeichnung: p.bezeichnung, istwert: wert,
        sollwert: p.sollwert, toleranzMin: p.toleranzMin, toleranzMax: p.toleranzMax, einheit: p.einheit,
        ioNio,
      });
    });

    if (fehlend.length > 0) {
      return res.status(400).json({ error: `Istwert fehlt für: ${fehlend.join(', ')}` });
    }
    if (nichtIo.length > 0) {
      return res.status(400).json({ error: `Nicht i.O.: ${nichtIo.join(', ')} - Erstfreigabe kann nicht erteilt werden` });
    }

    order.erstfreigabe = { erteilt: true, kuerzel: req.shopfloorKuerzel, zeitpunkt: new Date(), messungen };
    await order.save();
    res.status(201).json(order.erstfreigabe);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Laufzettel-Prüfpunkt abhaken bzw. zurücknehmen.
router.patch('/orders/:orderId/laufzettel/:pruefpunktId', shopfloorAuthMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    const artikel = await getArtikelFuerOrder(order);
    if (istErstfreigabeOffen(order, artikel)) {
      return res.status(403).json({ error: 'Erstfreigabe steht noch aus' });
    }
    ensureLaufzettel(order, artikel);
    const eintrag = order.laufzettel.find(s => String(s.pruefpunktId) === req.params.pruefpunktId);
    if (!eintrag) return res.status(404).json({ error: 'Prüfpunkt nicht gefunden' });

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
    const artikel = await getArtikelFuerOrder(order);
    if (istErstfreigabeOffen(order, artikel)) {
      return res.status(403).json({ error: 'Erstfreigabe steht noch aus' });
    }
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

// Maßprüfung: eine Messung zu einem Prüfpunkt eintragen (Log, nicht überschreiben -
// mehrere Messungen je Schicht/Auftrag sind auf der Fehlersammelkarte üblich).
router.post('/orders/:orderId/massung', shopfloorAuthMiddleware, async (req, res) => {
  try {
    const { pruefpunktId, istwert } = req.body;
    if (!pruefpunktId || istwert === undefined || istwert === null || istwert === '') {
      return res.status(400).json({ error: 'Prüfpunkt und Istwert erforderlich' });
    }
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    const artikel = await getArtikelFuerOrder(order);
    if (istErstfreigabeOffen(order, artikel)) {
      return res.status(403).json({ error: 'Erstfreigabe steht noch aus' });
    }
    const punkt = artikel?.plp?.find(p => String(p._id) === pruefpunktId && p.typ === 'masspruefung');
    if (!punkt) return res.status(404).json({ error: 'Maßprüfungs-Prüfpunkt nicht gefunden' });

    const wert = Number(istwert);
    order.massungen.push({
      pruefpunktId: punkt._id, bezeichnung: punkt.bezeichnung, istwert: wert,
      sollwert: punkt.sollwert, toleranzMin: punkt.toleranzMin, toleranzMax: punkt.toleranzMax, einheit: punkt.einheit,
      ioNio: berechneIoNio(wert, punkt.toleranzMin, punkt.toleranzMax),
      kuerzel: req.shopfloorKuerzel, zeitpunkt: new Date(),
    });
    await order.save();
    res.status(201).json(order.massungen);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Fehlerhafte Messung zurücknehmen.
router.delete('/orders/:orderId/massung/:entryId', shopfloorAuthMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    order.massungen = order.massungen.filter(m => String(m._id) !== req.params.entryId);
    await order.save();
    res.json(order.massungen);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
