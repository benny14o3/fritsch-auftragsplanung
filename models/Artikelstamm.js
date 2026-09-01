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

// Eine Zeile im Produktionslenkungsplan (Prüfmerkmal mit Sollwert/Toleranz/Prüfmittel).
const plpZeileSchema = new mongoose.Schema({
  merkmal: String,
  sollwert: String,
  toleranz: String,
  pruefmittel: String,
  pruefhaeufigkeit: String,
}, { _id: false });

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
  plp: [plpZeileSchema],
}, { _id: false });

const artikelstammSchema = new mongoose.Schema({
  artikel: [artikelSchema],
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastUpdated: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Artikelstamm', artikelstammSchema);
