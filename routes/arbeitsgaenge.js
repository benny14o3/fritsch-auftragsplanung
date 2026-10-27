const express = require('express');
const Arbeitsgang = require('../models/Arbeitsgang');
const Artikelstamm = require('../models/Artikelstamm');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');

const router = express.Router();

// Beim ersten Aufruf mit den Schritten befüllen, die bei Fritsch tatsächlich
// vorkommen - die Werte sind Platzhalter und werden in der Oberfläche gepflegt.
const GRUNDKATALOG = [
  // --- Formgebung ---
  { schluessel: 'ruesten_personell', name: 'Rüsten Formgebung (personell)', abrechnung: 'auftrag', reihenfolge: 10,
    rolle: 'einrichter', personalanteilProzent: 100, maschinengebunden: true, bereich: 'formgebung',
    bemerkung: 'Werkzeug aus- und einbauen, anschließen - Einrichter gebunden, Maschine steht' },
  { schluessel: 'aufheizen', name: 'Aufheizen Werkzeug/Maschine', abrechnung: 'auftrag', reihenfolge: 20,
    rolle: 'keine', personalanteilProzent: 0, maschinengebunden: true, bereich: 'formgebung',
    bemerkung: 'Maschine heizt allein hoch - kostet Maschinenzeit und Energie, aber kein Personal' },
  { schluessel: 'formgebung', name: 'Formgebung (Spritzen)', abrechnung: 'stueck', reihenfolge: 30,
    rolle: 'maschinenbediener', personalanteilProzent: 100, maschinengebunden: true, bereich: 'formgebung',
    bemerkung: 'Zeit kommt aus Kavität und Zeit pro 100 im Artikelstamm; Personalanteil = 100 / bediente Maschinen' },
  { schluessel: 'entgraten_kryo', name: 'Kryogenes Entgraten', abrechnung: 'charge', reihenfolge: 40,
    rolle: 'maschinenbediener', personalanteilProzent: 20, maschinengebunden: true, bereich: 'formgebung',
    bemerkung: 'Personal nur zum Be- und Entladen' },
  { schluessel: 'nachheizen', name: 'Nachheizen / Tempern', abrechnung: 'charge', reihenfolge: 50,
    rolle: 'keine', personalanteilProzent: 10, maschinengebunden: true, bereich: 'formgebung',
    bemerkung: 'Ofen läuft allein, Personal nur zum Beschicken' },
  { schluessel: 'stechen', name: 'Stechen', abrechnung: 'stueck', reihenfolge: 70,
    rolle: 'maschinenbediener', personalanteilProzent: 100, maschinengebunden: true, bereich: 'formgebung' },

  // --- CNC ---
  { schluessel: 'programmieren', name: 'CNC-Programm erstellen', abrechnung: 'auftrag', reihenfolge: 11,
    rolle: 'einrichter', personalanteilProzent: 100, maschinengebunden: false, bereich: 'cnc',
    bemerkung: 'Nur bei neuen Teilen oder Änderungen - am Rechner, die Maschine läuft weiter' },
  { schluessel: 'ruesten_cnc', name: 'Rüsten CNC (Spannmittel/Werkzeuge)', abrechnung: 'auftrag', reihenfolge: 12,
    rolle: 'einrichter', personalanteilProzent: 100, maschinengebunden: true, bereich: 'cnc',
    bemerkung: 'Backen und Werkzeuge wechseln, Nullpunkt setzen, Programm einfahren - Maschine steht' },
  { schluessel: 'saegen', name: 'Sägen / Zuschnitt', abrechnung: 'stueck', reihenfolge: 25,
    rolle: 'maschinenbediener', personalanteilProzent: 100, maschinengebunden: true, bereich: 'cnc',
    bemerkung: 'Rundstab oder Platte auf Rohteillänge - das Zuschnittgewicht zählt beim Material, nicht das Fertigteil' },
  { schluessel: 'drehen', name: 'Drehen (CNC)', abrechnung: 'stueck', reihenfolge: 31,
    rolle: 'maschinenbediener', personalanteilProzent: 100, maschinengebunden: true, bereich: 'cnc',
    bemerkung: 'Hauptzeit je Teil. Bei Stangenlader oder Mehrmaschinenbedienung den Personalanteil senken - die Maschine läuft, der Bediener nicht nur hier' },
  { schluessel: 'fraesen', name: 'Fräsen (CNC/Portal)', abrechnung: 'stueck', reihenfolge: 32,
    rolle: 'maschinenbediener', personalanteilProzent: 100, maschinengebunden: true, bereich: 'cnc' },
  { schluessel: 'lasern', name: 'Lasern / Beschriften', abrechnung: 'stueck', reihenfolge: 33,
    rolle: 'maschinenbediener', personalanteilProzent: 100, maschinengebunden: true, bereich: 'cnc' },

  // --- beide Bereiche ---
  { schluessel: 'entgraten_manuell', name: 'Entgraten manuell', abrechnung: 'stueck', reihenfolge: 46,
    rolle: 'maschinenbediener', personalanteilProzent: 100, maschinengebunden: false, bereich: 'beide',
    bemerkung: 'Reine Handarbeit ohne Anlage' },
  { schluessel: 'befedern', name: 'Befedern (Feder einlegen)', abrechnung: 'stueck', reihenfolge: 75,
    rolle: 'maschinenbediener', personalanteilProzent: 100, maschinengebunden: false, bereich: 'beide',
    bemerkung: 'Feder einlegen/einrollen - reine Handarbeit. Die Feder selbst zählt beim Material, nicht hier' },
  { schluessel: 'waschen', name: 'Waschen', abrechnung: 'charge', reihenfolge: 60,
    rolle: 'maschinenbediener', personalanteilProzent: 20, maschinengebunden: true, bereich: 'beide' },
  { schluessel: 'sichtkontrolle', name: 'Sichtkontrolle 100 %', abrechnung: 'stueck', reihenfolge: 80,
    rolle: 'kontrolle', personalanteilProzent: 100, maschinengebunden: false, bereich: 'beide',
    bemerkung: 'Fällt bei jedem Artikel an - reine Personalzeit' },
  { schluessel: 'verpacken', name: 'Verpacken', abrechnung: 'stueck', reihenfolge: 90,
    rolle: 'kontrolle', personalanteilProzent: 100, maschinengebunden: false, bereich: 'beide' },
];

async function katalog() {
  const anzahl = await Arbeitsgang.countDocuments();
  if (anzahl === 0) await Arbeitsgang.insertMany(GRUNDKATALOG);
  return Arbeitsgang.find().sort({ reihenfolge: 1, name: 1 });
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    res.json(await katalog());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { schluessel, name, abrechnung } = req.body;
    if (!schluessel || !name) return res.status(400).json({ error: 'Schlüssel und Name erforderlich' });
    if (await Arbeitsgang.findOne({ schluessel })) {
      return res.status(409).json({ error: `Arbeitsgang ${schluessel} existiert bereits` });
    }
    const hoechste = await Arbeitsgang.findOne().sort({ reihenfolge: -1 }).select('reihenfolge');
    const neu = await Arbeitsgang.create({
      ...req.body,
      abrechnung: ['stueck', 'charge', 'auftrag'].includes(abrechnung) ? abrechnung : 'stueck',
      reihenfolge: (hoechste?.reihenfolge ?? 0) + 10,
    });
    res.status(201).json(neu);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const erlaubt = ['name', 'abrechnung', 'standardzeitSek', 'standardChargengroesse',
      'standardChargenzeitMin', 'standardRuestzeitMin', 'bemerkung', 'reihenfolge', 'aktiv',
      'rolle', 'personalanteilProzent', 'maschinengebunden', 'bereich'];
    const aenderung = {};
    erlaubt.forEach(f => { if (req.body[f] !== undefined) aenderung[f] = req.body[f]; });
    const doc = await Arbeitsgang.findByIdAndUpdate(req.params.id, aenderung, { new: true });
    if (!doc) return res.status(404).json({ error: 'Arbeitsgang nicht gefunden' });
    res.json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Löschen nur, wenn ihn kein Artikel mehr verwendet - sonst stünde in den
// Artikeln ein Schlüssel ohne Bedeutung.
router.delete('/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const doc = await Arbeitsgang.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Arbeitsgang nicht gefunden' });
    const stamm = await Artikelstamm.findOne().select('artikel.material artikel.arbeitsgaenge');
    const verwendet = (stamm?.artikel || []).filter(a => (a.arbeitsgaenge || []).some(g => g.schluessel === doc.schluessel));
    if (verwendet.length > 0) {
      return res.status(409).json({
        error: `${doc.name} ist bei ${verwendet.length} Artikel${verwendet.length === 1 ? '' : 'n'} hinterlegt - dort zuerst entfernen`,
      });
    }
    await Arbeitsgang.deleteOne({ _id: doc._id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Wie weit ist die Erfassung? Zeigt, bei wie vielen Artikeln schon ein
// Arbeitsplan hinterlegt ist - die Kalkulation braucht ihn bei jedem.
router.get('/fortschritt', authMiddleware, async (req, res) => {
  try {
    const stamm = await Artikelstamm.findOne().select('artikel.material artikel.dbType artikel.arbeitsgaenge');
    const artikel = stamm?.artikel || [];
    const mitPlan = artikel.filter(a => (a.arbeitsgaenge || []).length > 0);
    res.json({
      gesamt: artikel.length,
      mitPlan: mitPlan.length,
      ohnePlan: artikel.length - mitPlan.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
