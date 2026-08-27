const mongoose = require('mongoose');

const komponenteSchema = new mongoose.Schema({
  artikelnummer: String,
  bezeichnung: String,
  wareneingang: { type: Date, default: null },
});

const orderSchema = new mongoose.Schema({
  auftragsnummer: String,
  bestellnummer: String,
  lieferdatum: { type: Date, default: null },
  artikelnummer: String,
  beschreibung: String,
  komponenten: [komponenteSchema],
  menge: Number,
  kavitaet: Number,
  rundenProSchicht: Number,
  zeitProHundert: Number,
  dbType: { type: String, enum: ['Elastomer', 'PTFE', 'Unbekannt'] },
  maschineId: { type: String, default: null },
  maschineId2: { type: String, default: null },
  startDatum: { type: Date, default: null },
  endDatum: { type: Date, default: null },
  bearbeitungsMin: Number,
  schichten: Number,
  status: { type: String, enum: ['ausstehend', 'geplant', 'ueberlastet'], default: 'ausstehend' },
  phase: { type: String, enum: ['produktion', 'endbearbeitung', 'ausgeliefert'], default: 'produktion' },
  warenausgang: { type: Date, default: null },
  position: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Order', orderSchema);
