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

module.exports = router;
