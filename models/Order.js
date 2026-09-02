const mongoose = require('mongoose');

const komponenteSchema = new mongoose.Schema({
  artikelnummer: String,
  bezeichnung: String,
  wareneingang: { type: Date, default: null },
  // Chargennummer des Lieferanten - für ISO-9001-Rückverfolgbarkeit vom
  // Rohmaterial bis zum Fertigteil, beim Wareneingang erfasst.
  charge: { type: String, default: '' },
});

// Ein Eintrag pro Strich auf der Fehlersammelkarte - Kürzel/Zeitpunkt kommen aus
// dem Shopfloor-Login, damit die Karte nachvollziehbar bleibt (statt nur einer
// nackten Zahl je Fehlerart).
const fehlerEintragSchema = new mongoose.Schema({
  fehlerart: { type: String, required: true },
  kuerzel: { type: String, required: true },
  zeitpunkt: { type: Date, default: Date.now },
});

// Prozessbegleitschein: ein Eintrag je Prozessschritt-Prüfpunkt aus dem
// Produktionslenkungsplan des Artikels (typ: 'prozess'), am Shopfloor-Bildschirm
// abgehakt statt auf Papier mitgeführt. pruefpunktId verweist auf den Punkt im
// Artikelstamm; bezeichnung ist ein Schnappschuss, falls der Stammdatensatz
// später umbenannt/gelöscht wird.
const laufzettelEintragSchema = new mongoose.Schema({
  pruefpunktId: { type: mongoose.Schema.Types.ObjectId, required: true },
  bezeichnung: { type: String, required: true },
  erledigt: { type: Boolean, default: false },
  kuerzel: { type: String, default: null },
  zeitpunkt: { type: Date, default: null },
}, { _id: false });

// Eine Messung zu einem Maßprüfungs-Prüfpunkt (typ: 'masspruefung') - Log statt
// Einzelwert, damit mehrere Messungen je Schicht/Auftrag dokumentiert werden
// können (Fehlersammelkarte). ioNio wird serverseitig aus Istwert + Toleranz
// aus dem Artikelstamm berechnet.
const massungSchema = new mongoose.Schema({
  pruefpunktId: { type: mongoose.Schema.Types.ObjectId, required: true },
  bezeichnung: String,
  istwert: { type: Number, required: true },
  sollwert: Number,
  toleranzMin: Number,
  toleranzMax: Number,
  einheit: String,
  ioNio: { type: String, enum: ['i.O.', 'n.i.O.'] },
  kuerzel: { type: String, required: true },
  zeitpunkt: { type: Date, default: Date.now },
});

// Erstfreigabe (Erstmusterprüfung): dokumentiert vor Serienproduktion, mit
// Schnappschuss der Messergebnisse zu allen Maßprüfungs-Prüfpunkten des
// Artikels. Solange nicht erteilt, sperrt die Shopfloor-Route Laufzettel/FSK
// für diesen Auftrag (siehe routes/shopfloor.js).
const erstfreigabeMessungSchema = new mongoose.Schema({
  pruefpunktId: { type: mongoose.Schema.Types.ObjectId, required: true },
  bezeichnung: String,
  istwert: Number,
  sollwert: Number,
  toleranzMin: Number,
  toleranzMax: Number,
  einheit: String,
  ioNio: String,
}, { _id: false });

const erstfreigabeSchema = new mongoose.Schema({
  erteilt: { type: Boolean, default: false },
  kuerzel: { type: String, default: null },
  zeitpunkt: { type: Date, default: null },
  messungen: [erstfreigabeMessungSchema],
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
  // Manuell in den Zeitplan aufgenommen, obwohl noch nicht alle Komponenten da
  // sind (siehe istKomponentenBereit) - der Balken erscheint dann gelb statt
  // ausgeblendet zu werden, bis die Komponenten wirklich vollständig sind.
  manuellEingeplant: { type: Boolean, default: false },
  // Freies Notizfeld je Auftrag, z.B. für Absprachen oder Besonderheiten.
  kommentar: { type: String, default: '' },
  fehlersammelkarte: [fehlerEintragSchema],
  laufzettel: [laufzettelEintragSchema],
  massungen: [massungSchema],
  erstfreigabe: { type: erstfreigabeSchema, default: () => ({ erteilt: false, messungen: [] }) },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Order', orderSchema);
