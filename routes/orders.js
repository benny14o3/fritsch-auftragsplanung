const express = require('express');
const Order = require('../models/Order');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');

const router = express.Router();

// Der komplette Plan ist geteilt (eine Firma, ein Board) - kein userId-Filter.
// Optionaler ?artikelnummer=-Filter für die FSK-Historie (alle Aufträge eines
// Artikels über alle Phasen hinweg, für den Export in der Artikelverwaltung).
router.get('/', authMiddleware, async (req, res) => {
  try {
    const filter = req.query.artikelnummer ? { artikelnummer: req.query.artikelnummer } : {};
    const orders = await Order.find(filter).sort({ position: 1 });
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Fügt einen neuen Excel-Import zur bestehenden Planung hinzu, statt sie zu
// ersetzen - bestehende Aufträge (in jeder Phase) bleiben unangetastet. Anhand
// der Auftragsnummer erkannte Duplikate (egal in welcher Phase) werden
// übersprungen, damit ein erneuter Upload derselben Excel nichts verdoppelt.
router.post('/', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { orders } = req.body;
    const vorhandene = await Order.find({}).select('auftragsnummer');
    const skipSet = new Set(vorhandene.map(o => o.auftragsnummer).filter(Boolean));
    const uebersprungen = orders.filter(o => o.auftragsnummer && skipSet.has(o.auftragsnummer)).length;
    const gefiltert = orders.filter(o => !o.auftragsnummer || !skipSet.has(o.auftragsnummer));

    const maxPos = await Order.findOne().sort({ position: -1 }).select('position');
    const startPos = (maxPos?.position ?? -1) + 1;
    const createdOrders = await Order.insertMany(
      gefiltert.map((o, idx) => ({ ...o, position: startPos + idx, createdBy: req.userId, updatedBy: req.userId }))
    );
    res.status(201).json({ orders: createdOrders, uebersprungen });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Für Drag & Drop und Phasenwechsel (Produktion -> Endbearbeitung -> Ausgeliefert).
router.patch('/:orderId', authMiddleware, async (req, res) => {
  try {
    const { maschineId, maschineId2, startDatum, endDatum, position, status, komponenten, phase, warenausgang, dbType, manuellEingeplant } = req.body;
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    if (maschineId !== undefined) order.maschineId = maschineId;
    if (maschineId2 !== undefined) order.maschineId2 = maschineId2;
    if (startDatum !== undefined) order.startDatum = startDatum;
    if (endDatum !== undefined) order.endDatum = endDatum;
    if (position !== undefined) order.position = position;
    if (status !== undefined) order.status = status;
    if (komponenten !== undefined) order.komponenten = komponenten;
    if (phase !== undefined) order.phase = phase;
    if (warenausgang !== undefined) order.warenausgang = warenausgang;
    if (dbType !== undefined) order.dbType = dbType;
    if (manuellEingeplant !== undefined) order.manuellEingeplant = manuellEingeplant;
    order.updatedBy = req.userId;
    await order.save();
    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Einzelnen Auftrag manuell anlegen, ohne den restlichen Plan anzurühren.
router.post('/manual', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { order } = req.body;
    if (!order || !order.auftragsnummer) {
      return res.status(400).json({ error: 'Auftragsnummer fehlt' });
    }
    const bereitsVorhanden = await Order.findOne({ auftragsnummer: order.auftragsnummer });
    if (bereitsVorhanden) {
      return res.status(409).json({ error: `Auftrag ${order.auftragsnummer} existiert bereits` });
    }
    const maxPos = await Order.findOne({ phase: 'produktion' }).sort({ position: -1 }).select('position');
    const created = await Order.create({
      ...order,
      phase: order.phase || 'produktion',
      position: (maxPos?.position ?? -1) + 1,
      createdBy: req.userId,
      updatedBy: req.userId,
    });
    res.status(201).json(created);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:orderId', authMiddleware, async (req, res) => {
  try {
    await Order.deleteOne({ _id: req.params.orderId });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Alle Aufträge unwiderruflich löschen (Produktion, Endbearbeitung, Ausgeliefert).
// Formgebung und CNC sind getrennte Bereiche - optional per ?dbType= auf einen davon
// einschränken, ohne query löscht es wirklich alles.
router.delete('/', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { dbType } = req.query;
    const filter = dbType ? { dbType } : {};
    const result = await Order.deleteMany(filter);
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
