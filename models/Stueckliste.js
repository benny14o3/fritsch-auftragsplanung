const mongoose = require('mongoose');

const komponenteSchema = new mongoose.Schema({
  artikelnummer: String,
  bezeichnung: String,
  menge: Number,
}, { _id: false });

const materialSchema = new mongoose.Schema({
  material: String,
  bezeichnung: String,
  komponenten: [komponenteSchema],
}, { _id: false });

const stuecklisteSchema = new mongoose.Schema({
  materialien: [materialSchema],
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastUpdated: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Stueckliste', stuecklisteSchema);
