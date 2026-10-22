const mongoose = require('mongoose');

// Alle Zahlen, aus denen sich Maschinen- und Lohnstundensätze ergeben.
// Bewusst EIN Dokument für den ganzen Betrieb: die Sätze gelten gemeinsam und
// werden zusammen gepflegt, nicht verstreut über einzelne Einträge.

const maschineKostenSchema = new mongoose.Schema({
  maschineId: { type: String, required: true },
  // Gehört die Maschine uns oder dem Kunden? Beigestellte Maschinen binden kein
  // eigenes Kapital - Abschreibung und kalkulatorische Zinsen entfallen, Strom,
  // Fläche und Wartung fallen aber weiterhin bei uns an.
  eigentum: { type: String, enum: ['eigen', 'kunde'], default: 'eigen' },
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

// Ein Mitarbeiter mit seinen tatsächlichen Arbeitgeberkosten aus der
// Lohnabrechnung. Daraus ergibt sich der Stundensatz seiner Rolle - viel
// genauer als ein pauschaler Lohnsatz je Gruppe.
const mitarbeiterSchema = new mongoose.Schema({
  name: { type: String, required: true },
  firma: String,
  persnr: String,
  rolle: { type: String, enum: ['einrichter', 'werker', 'verpacker', 'qs', 'geschaeftsfuehrer', 'verwaltung', ''], default: '' },
  // Arbeitgeber-Gesamtkosten im Monat: Bruttolohn plus AG-Anteile zu KV, RV,
  // AV, PV und die Umlagen U1/U2/Insolvenzgeld.
  agKostenMonat: Number,
  // Statt der eigenen Kosten den Durchschnitt der übrigen Personen dieser Rolle
  // ansetzen - z.B. wenn jemand über eine andere Firma zu günstig abgerechnet
  // wird, die Leistung aber dieselbe ist. Die eigenen Kosten bleiben als
  // Information stehen.
  kostenAngleichen: { type: Boolean, default: false },
  // Stundensatz von Hand setzen statt aus den Kosten zu rechnen - etwa als
  // kalkulatorischer Unternehmerlohn, wenn sich jemand unter Marktwert bezahlt.
  // Der gerechnete Satz bleibt zum Vergleich sichtbar.
  stundensatzManuell: Number,
  wochenstunden: Number,
  aktiv: { type: Boolean, default: true },
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
    // Abzüge von den Arbeitstagen, um auf die produktiven Stunden zu kommen.
    urlaubstageProJahr: { type: Number, default: 30 },
    krankheitstageProJahr: { type: Number, default: 10 },
    strompreisCtProKwh: Number,
    raumkostenProQmJahr: Number,
  },
  maschinen: [maschineKostenSchema],
  hilfsbetriebe: [hilfsbetriebSchema],
  loehne: [lohnSchema],
  mitarbeiter: [mitarbeiterSchema],
  zuschlaege: {
    verwaltungVertriebProzent: Number,
    ausschussProzent: Number,
    margeProzent: Number,
  },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastUpdated: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Kostensaetze', kostensaetzeSchema, 'kostensaetze');
