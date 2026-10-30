const express = require('express');
const Kostensaetze = require('../models/Kostensaetze');
const Order = require('../models/Order');
const { MASCHINEN } = require('../lib/maschinen');
const { berechneSaetze } = require('../lib/kostensaetze');
const authMiddleware = require('../middleware/auth');
const inhaberMiddleware = require('../middleware/inhaber');

const router = express.Router();

// Kostensätze sind Geschäftsgeheimnis - Lohnkosten, Maschinenwerte, Marge.
// Deshalb durchgehend inhaberMiddleware, auch beim Lesen: nicht jeder Admin,
// sondern ausschließlich das Inhaber-Konto (siehe lib/inhaber.js).

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

// Tatsächliche Auslastung je Maschine aus dem Zeitplan der nächsten acht
// Wochen - als Hinweis, mit welchen Jahresstunden realistisch zu rechnen ist.
// Ohne das rechnet man Fixkosten auf Stunden um, die es gar nicht gibt.
async function istAuslastung() {
  const orders = await Order.find({ phase: 'produktion' })
    .select('komponenten manuellEingeplant maschineId maschineId2 startDatum endDatum bearbeitungsMin teilmengen').lean();
  const tag = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const istWerktag = d => d.getDay() !== 0 && d.getDay() !== 6;
  const werktage = (von, bis) => {
    const liste = [];
    const d = new Date(von);
    while (d <= bis) { if (istWerktag(d)) liste.push(new Date(d)); d.setDate(d.getDate() + 1); }
    return liste;
  };
  const imPlan = o => (o.komponenten || []).every(k => k.wareneingang) || o.manuellEingeplant;

  const abschnitte = [];
  orders.filter(imPlan).forEach(o => {
    if (o.startDatum && o.endDatum) abschnitte.push({ m: [o.maschineId, o.maschineId2].filter(Boolean), s: tag(o.startDatum), e: tag(o.endDatum), min: o.bearbeitungsMin || 0 });
    (o.teilmengen || []).forEach(t => {
      if (t.startDatum && t.endDatum) abschnitte.push({ m: [t.maschineId, t.maschineId2].filter(Boolean), s: tag(t.startDatum), e: tag(t.endDatum), min: t.bearbeitungsMin || 0 });
    });
  });

  const heute = tag(new Date());
  const montag = new Date(heute);
  montag.setDate(montag.getDate() + (montag.getDay() === 0 ? -6 : 1 - montag.getDay()));
  const bis = new Date(montag);
  bis.setDate(bis.getDate() + 7 * 8 - 3);
  const tage = werktage(montag, bis);

  const ergebnis = {};
  // Nur beplante Maschinen: fuer eine reine Kostenstelle gaebe es sonst einen
  // Eintrag mit 0 %, und die Oberflaeche wuerde "Auslastung laut Zeitplan 0 %"
  // behaupten, wo es gar keinen Zeitplan gibt.
  MASCHINEN.filter(m => m.planbar !== false).forEach(m => {
    let minuten = 0;
    tage.forEach(t => abschnitte.forEach(a => {
      if (!a.m.includes(m.id)) return;
      if (a.s <= t && a.e >= t) {
        const dauer = werktage(a.s, a.e).length || 1;
        minuten += a.min / dauer;
      }
    }));
    ergebnis[m.id] = {
      prozent: tage.length > 0 ? Math.round((minuten / (tage.length * 480)) * 100) : 0,
      stundenProJahr: Math.round((minuten / tage.length) / 60 * 220),
    };
  });
  return ergebnis;
}

async function antwort(doc) {
  const daten = doc.toObject();
  return {
    daten,
    berechnet: berechneSaetze(daten),
    maschinenListe: MASCHINEN,
    auslastung: await istAuslastung(),
  };
}

router.get('/', authMiddleware, inhaberMiddleware, async (req, res) => {
  try {
    res.json(await antwort(await holeOderLege()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Speichern und direkt die neu gerechneten Sätze zurückgeben, damit die
// Oberfläche ohne zweiten Aufruf zeigen kann, was sich geändert hat.
router.put('/', authMiddleware, inhaberMiddleware, async (req, res) => {
  try {
    const doc = await holeOderLege();
    const { allgemein, maschinen, hilfsbetriebe, loehne, zuschlaege } = req.body;
    if (allgemein !== undefined) doc.allgemein = allgemein;
    if (maschinen !== undefined) doc.maschinen = maschinen;
    if (hilfsbetriebe !== undefined) doc.hilfsbetriebe = hilfsbetriebe;
    if (loehne !== undefined) doc.loehne = loehne;
    if (req.body.mitarbeiter !== undefined) doc.mitarbeiter = req.body.mitarbeiter;
    if (zuschlaege !== undefined) doc.zuschlaege = zuschlaege;
    doc.updatedBy = req.userId;
    doc.lastUpdated = new Date();
    await doc.save();
    res.json(await antwort(doc));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
