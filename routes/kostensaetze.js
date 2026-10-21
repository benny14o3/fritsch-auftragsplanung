const express = require('express');
const Kostensaetze = require('../models/Kostensaetze');
const { MASCHINEN } = require('../lib/maschinen');
const { berechneSaetze } = require('../lib/kostensaetze');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');

const router = express.Router();

// Kostensätze sind Geschäftsgeheimnis - Lohnkosten, Maschinenwerte, Marge.
// Deshalb durchgehend adminMiddleware, auch beim Lesen.

async function holeOderLege() {
  let doc = await Kostensaetze.findOne();
  if (!doc) {
    doc = await Kostensaetze.create({
      maschinen: MASCHINEN.map(m => ({ maschineId: m.id })),
      loehne: [
        { rolle: 'einrichter' },
        { rolle: 'maschinenbediener' },
        { rolle: 'kontrolle' },
      ],
    });
  }
  return doc;
}

function antwort(doc) {
  const daten = doc.toObject();
  return { daten, berechnet: berechneSaetze(daten), maschinenListe: MASCHINEN };
}

router.get('/', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    res.json(antwort(await holeOderLege()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Speichern und direkt die neu gerechneten Sätze zurückgeben, damit die
// Oberfläche ohne zweiten Aufruf zeigen kann, was sich geändert hat.
router.put('/', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const doc = await holeOderLege();
    const { allgemein, maschinen, hilfsbetriebe, loehne, zuschlaege } = req.body;
    if (allgemein !== undefined) doc.allgemein = allgemein;
    if (maschinen !== undefined) doc.maschinen = maschinen;
    if (hilfsbetriebe !== undefined) doc.hilfsbetriebe = hilfsbetriebe;
    if (loehne !== undefined) doc.loehne = loehne;
    if (zuschlaege !== undefined) doc.zuschlaege = zuschlaege;
    doc.updatedBy = req.userId;
    doc.lastUpdated = new Date();
    await doc.save();
    res.json(antwort(doc));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
