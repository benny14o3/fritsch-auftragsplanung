const mongoose = require('mongoose');

const komponenteSchema = new mongoose.Schema({
  artikelnummer: String,
  bezeichnung: String,
  menge: Number,
}, { _id: false });

// Zeichnung und Einstelldatenblatt liegen in einer eigenen Collection
// (models/ArtikelDatei.js) und NICHT mehr hier - alle Artikel teilen sich ein
// einziges Artikelstamm-Dokument, dessen 16-MB-Limit mit den eingebetteten PDFs
// erreicht war. Die Routen hängen beim Ausliefern nur noch die Metadaten
// (Dateiname/Typ/Datum) an die Artikel an, damit die Oberfläche wie bisher
// sehen kann, ob etwas hinterlegt ist.

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
  // Wann im Auftrag geprüft wird:
  //  'erstfreigabe' - gehört zur Erstfreigabe und wird nur EINMAL je Auftrag
  //                   geprüft (z.B. die Vorhaltemaße), danach nicht wieder.
  //  'laufend'      - die serienbegleitenden Prüfungen nach Prüfintervall.
  //  'endabnahme'   - erst am Ende, wenn die Menge fertig ist oder eine
  //                   Teilsendung raus soll, und nur durch die QS (nicht durch
  //                   die Produktion) - siehe routes/shopfloor.js.
  stufe: { type: String, enum: ['erstfreigabe', 'laufend', 'endabnahme'], default: 'laufend' },
  // Prüfintervall strukturiert statt als Freitext, damit die App ausrechnen
  // kann, wann die nächste Prüfung fällig ist (Grundlage für die geplante
  // Erinnerung am Maschinen-Tablet). 'sonstige' = kein automatisches Intervall,
  // dann gilt der Freitext in pruefhaeufigkeit (z.B. "bei Werkzeugwechsel").
  // Default bewusst 'sonstige', damit bestehende Freitext-Einträge nicht
  // plötzlich als Intervall fehlinterpretiert werden.
  intervallTyp: { type: String, enum: ['einmalig', 'zeit', 'stueckzahl', 'schicht', 'sonstige'], default: 'sonstige' },
  intervallWert: Number, // nur bei intervallTyp 'zeit' (Minuten) und 'stueckzahl' (Stück)
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
  plp: [plpEintragSchema],
}, { _id: false });

const artikelstammSchema = new mongoose.Schema({
  artikel: [artikelSchema],
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastUpdated: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Artikelstamm', artikelstammSchema);
