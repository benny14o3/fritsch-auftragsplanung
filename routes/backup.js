const express = require('express');
const mongoose = require('mongoose');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');

const router = express.Router();

// Vollsicherung der Datenbank zum Herunterladen.
//
// Hintergrund: Die Daten liegen bei MongoDB Atlas, und ob dort Snapshots
// laufen, hängt am gebuchten Tarif. Eine eigene Sicherung, die jemand bewusst
// auslöst und auf einem eigenen Laufwerk ablegt, ist davon unabhängig.
//
// Passwörter (users, shopfloorusers) sind als Hash gespeichert und werden
// mitgesichert - ohne sie wäre nach einer Rücksicherung niemand mehr angemeldet.
// Die Datei gehört deshalb an einen Ort, an den nicht jeder herankommt.

// Diese Sammlungen gehören zur Sicherung. Dateien (Zeichnungen, Fotos) sind die
// großen Brocken und lassen sich auf Wunsch weglassen, wenn es nur um die
// Planungsdaten geht.
const SAMMLUNGEN = [
  { name: 'orders', gross: false },
  { name: 'artikelstamms', gross: false },
  { name: 'shopfloorusers', gross: false },
  { name: 'users', gross: false },
  { name: 'databases', gross: false },
  { name: 'stuecklistes', gross: false },
  { name: 'artikeldateis', gross: true },
  { name: 'komponentenbilder', gross: true },
];

async function sammleSicherung({ mitDateien }) {
  const db = mongoose.connection.db;
  const vorhandene = new Set((await db.listCollections().toArray()).map(c => c.name));
  const daten = {};
  const zusammenfassung = [];

  for (const s of SAMMLUNGEN) {
    if (!vorhandene.has(s.name)) continue;
    if (s.gross && !mitDateien) {
      zusammenfassung.push({ sammlung: s.name, dokumente: 0, ausgelassen: true });
      continue;
    }
    const dokumente = await db.collection(s.name).find({}).toArray();
    daten[s.name] = dokumente;
    zusammenfassung.push({ sammlung: s.name, dokumente: dokumente.length });
  }

  return {
    erstelltAm: new Date().toISOString(),
    mitDateien,
    zusammenfassung,
    daten,
  };
}

// Die Sicherung selbst herunterladen.
router.get('/', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const mitDateien = req.query.dateien !== '0';
    const sicherung = await sammleSicherung({ mitDateien });
    const stempel = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const dateiname = `fritsch-backup-${stempel}${mitDateien ? '' : '-ohne-dateien'}.json`;

    // Zeitpunkt festhalten, damit die Oberfläche zeigen kann, wann zuletzt
    // gesichert wurde (siehe GET /stand).
    await mongoose.connection.db.collection('backupprotokoll').insertOne({
      zeitpunkt: new Date(),
      mitDateien,
      zusammenfassung: sicherung.zusammenfassung,
      durchgefuehrtVon: req.userId,
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${dateiname}"`);
    res.send(JSON.stringify(sicherung));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Wann wurde zuletzt gesichert, und wie viel steckt aktuell in der Datenbank?
router.get('/stand', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const letzte = await db.collection('backupprotokoll').find({}).sort({ zeitpunkt: -1 }).limit(1).toArray();
    const vorhandene = new Set((await db.listCollections().toArray()).map(c => c.name));
    let bytes = 0;
    const umfang = [];
    for (const s of SAMMLUNGEN) {
      if (!vorhandene.has(s.name)) continue;
      const stats = await db.command({ collStats: s.name });
      bytes += stats.size;
      umfang.push({ sammlung: s.name, dokumente: stats.count, bytes: stats.size });
    }
    res.json({
      letztesBackup: letzte[0] ? { zeitpunkt: letzte[0].zeitpunkt, mitDateien: letzte[0].mitDateien } : null,
      bytes,
      umfang,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
