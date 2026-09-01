const mongoose = require('mongoose');

const komponenteSchema = new mongoose.Schema({
  artikelnummer: String,
  bezeichnung: String,
  wareneingang: { type: Date, default: null },
});

// Ein Eintrag pro Strich auf der Fehlersammelkarte - Kürzel/Zeitpunkt kommen aus
// dem Shopfloor-Login, damit die Karte nachvollziehbar bleibt (statt nur einer
// nackten Zahl je Fehlerart).
const fehlerEintragSchema = new mongoose.Schema({
  fehlerart: { type: String, required: true },
  kuerzel: { type: String, required: true },
  zeitpunkt: { type: Date, default: Date.now },
});

// Prozessbegleitschein: eine Station je Arbeitsschritt, am Shopfloor-Bildschirm
// abgehakt statt auf Papier mitgeführt.
const laufzettelStationSchema = new mongoose.Schema({
  station: { type: String, required: true },
  erledigt: { type: Boolean, default: false },
  kuerzel: { type: String, default: null },
  zeitpunkt: { type: Date, default: null },
}, { _id: false });

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
  fehlersammelkarte: [fehlerEintragSchema],
  laufzettel: [laufzettelStationSchema],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Order', orderSchema);
