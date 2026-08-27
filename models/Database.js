const mongoose = require('mongoose');

const articleSchema = new mongoose.Schema({
  material: String,
  beschreibung: String,
  maschine: String,
  kavitaet: Number,
  rundenProSchicht: Number,
  zeitProHundert: Number,
});

const databaseSchema = new mongoose.Schema({
  type: { type: String, enum: ['Elastomer', 'PTFE'], required: true },
  articles: [articleSchema],
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastUpdated: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

// Eine Datenbank pro Typ, geteilt für die ganze Firma (nicht pro Nutzer).
databaseSchema.index({ type: 1 }, { unique: true });
module.exports = mongoose.model('Database', databaseSchema);
