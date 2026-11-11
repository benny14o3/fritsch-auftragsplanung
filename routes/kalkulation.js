const express = require('express');
const Artikelstamm = require('../models/Artikelstamm');
const Arbeitsgang = require('../models/Arbeitsgang');
const Kostensaetze = require('../models/Kostensaetze');
const authMiddleware = require('../middleware/auth');
const inhaberMiddleware = require('../middleware/inhaber');
const { berechneSaetze } = require('../lib/kostensaetze');
const { kalkuliere } = require('../lib/kalkulation');

// Stückpreis eines Artikels aus Arbeitsplan und Stundensätzen.
//
// Nur für den Inhaber, wie die Kostensätze selbst: aus Rüstkosten und
// Minuten lässt sich der Lohnsatz eines Einrichters zurückrechnen, und die
// Marge steht offen in der Staffel.
const router = express.Router();

// ?mengen=100,500,1000 - Losgrößen der Staffel
// ?ausschuss=0&marge=25 - überschreiben die hinterlegten Zuschläge nur für
// diese eine Rechnung (z.B. Gravur ohne Ausschuss), gespeichert wird nichts.
router.get('/:material', authMiddleware, inhaberMiddleware, async (req, res) => {
  try {
    const stamm = await Artikelstamm.findOne().lean();
    const artikel = (stamm?.artikel || []).find(a => String(a.material) === String(req.params.material));
    if (!artikel) return res.status(404).json({ error: 'Artikel nicht gefunden' });
    const kosten = await Kostensaetze.findOne();
    if (!kosten) return res.status(409).json({ error: 'Es sind noch keine Kostensätze hinterlegt' });
    const katalog = await Arbeitsgang.find().lean();
    const mengen = String(req.query.mengen || '').split(/[,;\s]+/).map(Number).filter(n => n > 0).slice(0, 12);
    res.json(kalkuliere(artikel, katalog, berechneSaetze(kosten.toObject()), {
      mengen,
      ausschussProzent: req.query.ausschuss,
      margeProzent: req.query.marge,
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
