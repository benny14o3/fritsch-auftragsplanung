const express = require('express');
const Artikelstamm = require('../models/Artikelstamm');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');

const router = express.Router();

async function getOrCreateDoc() {
  let doc = await Artikelstamm.findOne();
  if (!doc) doc = new Artikelstamm({ artikel: [] });
  return doc;
}

// Ein geteilter Artikelstamm für die ganze Firma (wie zuvor Datenbanken/Stückliste).
router.get('/', authMiddleware, async (req, res) => {
  try {
    const doc = await Artikelstamm.findOne();
    res.json(doc || { artikel: [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Elastomer/PTFE-Excel hochladen: ersetzt die Prozessdaten (Maschine/Kavität/
// Runden pro Schicht/Zeit pro 100) für diesen Typ vollständig, wie früher die
// eigene Datenbank pro Typ. Artikel, die aus dem Upload verschwinden, werden
// NICHT komplett gelöscht (sie könnten noch Komponenten aus der Stückliste
// tragen) - nur ihre Prozessdaten werden zurückgesetzt.
router.post('/upload/:type', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { type } = req.params;
    if (!['Elastomer', 'PTFE'].includes(type)) return res.status(400).json({ error: 'Ungültiger Typ' });
    const { articles } = req.body;
    const doc = await getOrCreateDoc();

    const incoming = new Map(articles.map(a => [a.material, a]));

    doc.artikel.forEach(entry => {
      if (entry.dbType === type && !incoming.has(entry.material)) {
        entry.dbType = null;
        entry.maschine = '';
        entry.kavitaet = 0;
        entry.rundenProSchicht = 0;
        entry.zeitProHundert = 0;
      }
    });

    incoming.forEach((row, material) => {
      let entry = doc.artikel.find(a => a.material === material);
      if (!entry) {
        // WICHTIG: nach push() zeigt die lokale Variable sonst noch auf das
        // ursprüngliche Plain-Object, nicht auf das von Mongoose gecastete
        // Subdokument im Array - Mutationen daran würden beim Speichern
        // verloren gehen.
        doc.artikel.push({ material, bezeichnung: row.beschreibung || '', komponenten: [] });
        entry = doc.artikel[doc.artikel.length - 1];
      } else if (!entry.bezeichnung && row.beschreibung) {
        entry.bezeichnung = row.beschreibung;
      }
      entry.dbType = type;
      entry.maschine = row.maschine || '';
      entry.kavitaet = row.kavitaet || 0;
      entry.rundenProSchicht = row.rundenProSchicht || 0;
      entry.zeitProHundert = row.zeitProHundert || 0;
    });

    doc.updatedBy = req.userId;
    doc.lastUpdated = new Date();
    await doc.save();
    res.json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stückliste-Excel (SAP BI) hochladen: ergänzt/aktualisiert nur Bezeichnung und
// Komponenten für die Artikel in der Datei - lässt bestehende Prozessdaten
// (Maschine/Kavität/...) unangetastet und löscht keine Artikel, die in einem
// Re-Upload fehlen (Stückliste wird seltener und meist nur teilweise gepflegt).
router.post('/upload/stueckliste', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { materialien } = req.body;
    const doc = await getOrCreateDoc();

    materialien.forEach(row => {
      let entry = doc.artikel.find(a => a.material === row.material);
      if (!entry) {
        doc.artikel.push({ material: row.material, dbType: null, maschine: '', kavitaet: 0, rundenProSchicht: 0, zeitProHundert: 0 });
        entry = doc.artikel[doc.artikel.length - 1];
      }
      entry.bezeichnung = row.bezeichnung || '';
      entry.komponenten = row.komponenten || [];
    });

    doc.updatedBy = req.userId;
    doc.lastUpdated = new Date();
    await doc.save();
    res.json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Einzelnen Artikel manuell hinzufügen - existiert er schon, werden die
// übergebenen Felder in den bestehenden Eintrag gemerged statt abgelehnt zu
// werden (z.B. Prozessdaten zu einem bisher nur aus der Stückliste bekannten
// Artikel ergänzen).
router.post('/materialien', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { material, bezeichnung, dbType, maschine, kavitaet, rundenProSchicht, zeitProHundert, komponenten } = req.body;
    if (!material) return res.status(400).json({ error: 'Artikelnummer fehlt' });

    const doc = await getOrCreateDoc();
    let entry = doc.artikel.find(a => a.material === material);
    if (!entry) {
      doc.artikel.push({ material, komponenten: [] });
      entry = doc.artikel[doc.artikel.length - 1];
    }
    if (bezeichnung !== undefined) entry.bezeichnung = bezeichnung;
    if (dbType !== undefined) entry.dbType = dbType;
    if (maschine !== undefined) entry.maschine = maschine;
    if (kavitaet !== undefined) entry.kavitaet = kavitaet;
    if (rundenProSchicht !== undefined) entry.rundenProSchicht = rundenProSchicht;
    if (zeitProHundert !== undefined) entry.zeitProHundert = zeitProHundert;
    if (komponenten !== undefined) entry.komponenten = komponenten;

    doc.updatedBy = req.userId;
    doc.lastUpdated = new Date();
    await doc.save();
    const saved = doc.artikel.find(a => a.material === material);
    res.status(201).json(saved);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Einzelnen Artikel bearbeiten.
router.patch('/materialien/:material', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const doc = await getOrCreateDoc();
    const entry = doc.artikel.find(a => a.material === req.params.material);
    if (!entry) return res.status(404).json({ error: 'Artikel nicht gefunden' });

    const { material, bezeichnung, dbType, maschine, kavitaet, rundenProSchicht, zeitProHundert, komponenten } = req.body;
    if (material !== undefined && material !== entry.material) {
      if (doc.artikel.some(a => a.material === material)) {
        return res.status(409).json({ error: `Artikel ${material} existiert bereits` });
      }
      entry.material = material;
    }
    if (bezeichnung !== undefined) entry.bezeichnung = bezeichnung;
    if (dbType !== undefined) entry.dbType = dbType;
    if (maschine !== undefined) entry.maschine = maschine;
    if (kavitaet !== undefined) entry.kavitaet = kavitaet;
    if (rundenProSchicht !== undefined) entry.rundenProSchicht = rundenProSchicht;
    if (zeitProHundert !== undefined) entry.zeitProHundert = zeitProHundert;
    if (komponenten !== undefined) entry.komponenten = komponenten;

    doc.updatedBy = req.userId;
    doc.lastUpdated = new Date();
    await doc.save();
    res.json(entry);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Einzelnen Artikel löschen.
router.delete('/materialien/:material', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const doc = await getOrCreateDoc();
    const idx = doc.artikel.findIndex(a => a.material === req.params.material);
    if (idx === -1) return res.status(404).json({ error: 'Artikel nicht gefunden' });
    doc.artikel.splice(idx, 1);
    doc.updatedBy = req.userId;
    doc.lastUpdated = new Date();
    await doc.save();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
