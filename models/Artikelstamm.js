const mongoose = require('mongoose');

const komponenteSchema = new mongoose.Schema({
  artikelnummer: String,
  bezeichnung: String,
  menge: Number,
}, { _id: false });

// Technische Zeichnung als Datei (PDF/Bild), direkt beim Artikel hinterlegt -
// es gibt keine separate Dateiablage in dieser App.
const zeichnungSchema = new mongoose.Schema({
  filename: String,
  mimeType: String,
  data: String, // base64
  uploadedAt: { type: Date, default: Date.now },
}, { _id: false });

// Ein Punkt im Produktionslenkungsplan - ein abzuhakender Prozessschritt
// (treibt den Prozessbegleitschein), eine Maßprüfung mit Sollwert/Toleranz oder
// eine reine i.O./n.i.O.-Prüfung ohne Messwert (z.B. Sichtprüfung) - beide
// Prüfungs-Typen treiben die Erstfreigabe + Fehlersammelkarte. Behält eine
// eigene _id (anders als die übrigen Artikel-Unterlisten), damit
// Order.laufzettel/massungen/erstfreigabe per pruefpunktId auf den genauen
// Punkt verweisen können, auch wenn Bezeichnung/Sollwert später bearbeitet
// werden - die Werte auf dem Auftrag sind ein Schnappschuss zum Zeitpunkt der
// Erfassung und bleiben für die Rückverfolgbarkeit unverändert, selbst wenn
// sich der Stammdatensatz ändert.
const plpEintragSchema = new mongoose.Schema({
  bezeichnung: { type: String, required: true },
  typ: { type: String, enum: ['prozess', 'masspruefung', 'iopruefung'], default: 'prozess' },
  // Nur bei typ === 'masspruefung':
  sollwert: Number,
  toleranzMin: Number,
  toleranzMax: Number,
  einheit: String,
  // Bei masspruefung und iopruefung (nicht bei prozess):
  pruefmittel: String,
  pruefhaeufigkeit: String,
});

// Ein Eintrag pro Artikel - Prozessdaten (Maschine/Kavität/...) und Stückliste
// (Bezeichnung/Komponenten) gehören zusammen, statt in zwei getrennten
// Sammlungen zu leben, die separat gepflegt und abgeglichen werden mussten.
const artikelSchema = new mongoose.Schema({
  material: String,
  bezeichnung: String,
  dbType: { type: String, enum: ['Elastomer', 'PTFE', null], default: null },
  maschine: String,
  kavitaet: Number,
  rundenProSchicht: Number,
  zeitProHundert: Number,
  komponenten: [komponenteSchema],
  zeichnung: { type: zeichnungSchema, default: null },
  // Einstellparameter der Spritzgussmaschine (Temperaturen, Drücke, ...) -
  // nur für Formgebung (Elastomer) relevant, gleiche Dateistruktur wie Zeichnung.
  einstelldatenblatt: { type: zeichnungSchema, default: null },
  plp: [plpEintragSchema],
}, { _id: false });

const artikelstammSchema = new mongoose.Schema({
  artikel: [artikelSchema],
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastUpdated: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Artikelstamm', artikelstammSchema);
