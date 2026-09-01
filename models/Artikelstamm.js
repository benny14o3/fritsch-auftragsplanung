const mongoose = require('mongoose');

const komponenteSchema = new mongoose.Schema({
  artikelnummer: String,
  bezeichnung: String,
  menge: Number,
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
}, { _id: false });

const artikelstammSchema = new mongoose.Schema({
  artikel: [artikelSchema],
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastUpdated: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Artikelstamm', artikelstammSchema);
