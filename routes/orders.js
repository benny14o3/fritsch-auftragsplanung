const express = require('express');
const Order = require('../models/Order');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');

const router = express.Router();

// Der komplette Plan ist geteilt (eine Firma, ein Board) - kein userId-Filter.
router.get('/', authMiddleware, async (req, res) => {
  try {
    const orders = await Order.find().sort({ position: 1 });
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ersetzt die Produktionsplanung, z.B. nach einem neuen Excel-Import. Aufträge, die
// schon in Endbearbeitung oder ausgeliefert sind, bleiben erhalten (Nachverfolgbarkeit) -
// und werden hier anhand der Auftragsnummer erkannt, damit sie nicht als neue
// Produktions-Karte doppelt auftauchen, falls sie in der Excel erneut auftaucht.
router.post('/', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { orders } = req.body;
    const bereitsWeiter = await Order.find({ phase: { $ne: 'produktion' } }).select('auftragsnummer');
    const skipSet = new Set(bereitsWeiter.map(o => o.auftragsnummer).filter(Boolean));
    const uebersprungen = orders.filter(o => o.auftragsnummer && skipSet.has(o.auftragsnummer)).length;
    const gefiltert = orders.filter(o => !o.auftragsnummer || !skipSet.has(o.auftragsnummer));

    await Order.deleteMany({ phase: 'produktion' });
    const createdOrders = await Order.insertMany(
      gefiltert.map((o, idx) => ({ ...o, position: idx, createdBy: req.userId, updatedBy: req.userId }))
    );
    res.status(201).json({ orders: createdOrders, uebersprungen });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Für Drag & Drop und Phasenwechsel (Produktion -> Endbearbeitung -> Ausgeliefert).
router.patch('/:orderId', authMiddleware, async (req, res) => {
  try {
    const { maschineId, maschineId2, startDatum, endDatum, position, status, komponenten, phase, warenausgang } = req.body;
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
    order.updatedBy = req.userId;
    await order.save();
    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Einzelnen Auftrag manuell anlegen, ohne den restlichen Plan anzurühren
// (im Gegensatz zum Excel-Import, der die ganze Produktionsplanung ersetzt).
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
