const mongoose = require('mongoose');

// Alle Zahlen, aus denen sich Maschinen- und Lohnstundensätze ergeben.
// Bewusst EIN Dokument für den ganzen Betrieb: die Sätze gelten gemeinsam und
// werden zusammen gepflegt, nicht verstreut über einzelne Einträge.

const maschineKostenSchema = new mongoose.Schema({
  maschineId: { type: String, required: true },
  wiederbeschaffungswert: Number,
  nutzungsdauerJahre: Number,
  kw: Number,                      // Anschlussleistung
  lastanteilProzent: Number,       // wie viel davon im Mittel gezogen wird
  qm: Number,                      // Stellfläche inkl. Bedienraum
  wartungProJahr: Number,
  // Weicht die Auslastung dieser Maschine stark ab, kann sie eigene
  // Jahresstunden bekommen - sonst gilt der allgemeine Wert.
  jahresstundenAbweichend: Number,
  bemerkung: String,
}, { _id: false });

// Kompressor, Kühlaggregat, Absaugung, Vakuumpumpe: laufen für mehrere
// Maschinen und werden deshalb auf die Maschinenstunde umgelegt.
const hilfsbetriebSchema = new mongoose.Schema({
  name: { type: String, required: true },
  // Auf wen wird umgelegt: alle Maschinen, nur ein Bereich oder genau eine
  // Maschine (dann wirkt es wie ein Aufschlag auf deren Stundensatz).
  umlagekreis: { type: String, default: 'alle' }, // 'alle' | 'Elastomer' | 'PTFE' | <maschineId>
  wiederbeschaffungswert: Number,
  nutzungsdauerJahre: Number,
  kw: Number,
  lastanteilProzent: Number,
  laufstundenProJahr: Number,      // läuft oft länger als produziert wird
  wartungProJahr: Number,
  bemerkung: String,
}, { _id: false });

const lohnSchema = new mongoose.Schema({
  rolle: { type: String, enum: ['einrichter', 'maschinenbediener', 'kontrolle'], required: true },
  // Arbeitgeber-Gesamtaufwand pro Jahr und Person, am besten aus dem Lohnjournal
  jahreskostenArbeitgeber: Number,
  // Stunden, in denen die Person tatsächlich an der Wertschöpfung ist -
  // nicht die bezahlten Stunden (siehe Kommentar in lib/kostensaetze.js).
  produktiveStundenProJahr: Number,
  anzahlMitarbeiter: Number,
  bemerkung: String,
}, { _id: false });

const kostensaetzeSchema = new mongoose.Schema({
  allgemein: {
    arbeitstageProJahr: { type: Number, default: 220 },
    schichtstundenProTag: { type: Number, default: 8 },
    auslastungProzent: { type: Number, default: 77 },
    jahresstundenManuell: Number,   // überschreibt die Rechnung oben
    zinssatzProzent: { type: Number, default: 5 },
    strompreisCtProKwh: Number,
    raumkostenProQmJahr: Number,
  },
  maschinen: [maschineKostenSchema],
  hilfsbetriebe: [hilfsbetriebSchema],
  loehne: [lohnSchema],
  zuschlaege: {
    verwaltungVertriebProzent: Number,
    ausschussProzent: Number,
    margeProzent: Number,
  },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastUpdated: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Kostensaetze', kostensaetzeSchema, 'kostensaetze');
