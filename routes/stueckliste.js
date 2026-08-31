const express = require('express');
const Stueckliste = require('../models/Stueckliste');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');

const router = express.Router();

// Eine geteilte Stückliste für die ganze Firma (wie die Elastomer/PTFE-Datenbank).
router.get('/', authMiddleware, async (req, res) => {
  try {
    const doc = await Stueckliste.findOne();
    res.json(doc || { materialien: [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { materialien } = req.body;
    let doc = await Stueckliste.findOne();
    if (!doc) {
      doc = new Stueckliste({ materialien, updatedBy: req.userId });
    } else {
      doc.materialien = materialien;
      doc.updatedBy = req.userId;
      doc.lastUpdated = new Date();
    }
    await doc.save();
    res.json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Einzelnes Material (Artikel) hinzufügen, ohne die ganze Stückliste per Excel
// neu hochzuladen. material dient als eindeutiger Schlüssel (wie Artikelnummer).
router.post('/materialien', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { material, bezeichnung, komponenten } = req.body;
    if (!material) return res.status(400).json({ error: 'Artikelnummer fehlt' });

    let doc = await Stueckliste.findOne();
    if (!doc) doc = new Stueckliste({ materialien: [] });
    if (doc.materialien.some(m => m.material === material)) {
      return res.status(409).json({ error: `Artikel ${material} existiert bereits` });
    }
    doc.materialien.push({ material, bezeichnung, komponenten: komponenten || [] });
    doc.updatedBy = req.userId;
    doc.lastUpdated = new Date();
    await doc.save();
    res.status(201).json(doc.materialien[doc.materialien.length - 1]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Einzelnes Material bearbeiten (auch Umbenennen der Artikelnummer selbst).
router.patch('/materialien/:material', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const doc = await Stueckliste.findOne();
    if (!doc) return res.status(404).json({ error: 'Stückliste nicht gefunden' });
    const entry = doc.materialien.find(m => m.material === req.params.material);
    if (!entry) return res.status(404).json({ error: 'Artikel nicht gefunden' });

    const { material, bezeichnung, komponenten } = req.body;
    if (material !== undefined && material !== entry.material) {
      if (doc.materialien.some(m => m.material === material)) {
        return res.status(409).json({ error: `Artikel ${material} existiert bereits` });
      }
      entry.material = material;
    }
    if (bezeichnung !== undefined) entry.bezeichnung = bezeichnung;
    if (komponenten !== undefined) entry.komponenten = komponenten;
    doc.updatedBy = req.userId;
    doc.lastUpdated = new Date();
    await doc.save();
    res.json(entry);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Einzelnes Material löschen.
router.delete('/materialien/:material', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const doc = await Stueckliste.findOne();
    if (!doc) return res.status(404).json({ error: 'Stückliste nicht gefunden' });
    const idx = doc.materialien.findIndex(m => m.material === req.params.material);
    if (idx === -1) return res.status(404).json({ error: 'Artikel nicht gefunden' });
    doc.materialien.splice(idx, 1);
    doc.updatedBy = req.userId;
    doc.lastUpdated = new Date();
    await doc.save();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
