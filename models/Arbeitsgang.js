const mongoose = require('mongoose');

// Katalog der Arbeitsgänge für die Kalkulation.
//
// Jeder Artikel durchläuft eine eigene Folge davon (siehe Artikelstamm
// artikelSchema.arbeitsgaenge). Entscheidend ist, WORAUF sich die Zeit bezieht -
// davon hängt ab, wie die Kosten auf das einzelne Teil umgelegt werden:
//
//   'stueck'  je Teil      - z.B. 100% Sichtkontrolle. Verteilt sich NICHT auf
//                            die Losgröße, bildet damit die Preisuntergrenze.
//   'charge'  je Durchgang - z.B. Ofen, Waschanlage, Kryo-Entgratung. Eine
//                            Charge kostet gleich viel, egal wie voll sie ist.
//   'auftrag' je Auftrag   - z.B. Rüsten, Erstfreigabe. Verteilt sich auf die
//                            Losgröße und macht kleine Lose teuer.
const arbeitsgangSchema = new mongoose.Schema({
  schluessel: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  abrechnung: { type: String, enum: ['stueck', 'charge', 'auftrag'], default: 'stueck' },
  // Vorgabewerte, die beim Zuordnen zum Artikel übernommen und dort bei Bedarf
  // überschrieben werden.
  standardzeitSek: { type: Number, default: 0 },     // bei 'stueck': Sekunden je Teil
  standardChargengroesse: { type: Number, default: 0 }, // bei 'charge': Teile je Durchgang
  standardChargenzeitMin: { type: Number, default: 0 }, // bei 'charge': Minuten je Durchgang
  standardRuestzeitMin: { type: Number, default: 0 },   // bei 'auftrag': Minuten je Auftrag
  // WER ist während des Arbeitsgangs gebunden - davon hängt ab, welcher
  // Lohnsatz gerechnet wird. 'keine' heißt: die Anlage läuft allein, es
  // entstehen nur Maschinenkosten (z.B. Aufheizen, Ofen über Nacht).
  rolle: { type: String, enum: ['einrichter', 'maschinenbediener', 'kontrolle', 'keine'], default: 'maschinenbediener' },
  // Anteil der Zeit, in der die Person tatsächlich gebunden ist. Beim
  // Beschicken eines Ofens steht niemand daneben, während er läuft.
  personalanteilProzent: { type: Number, default: 100 },
  // Belegt der Arbeitsgang die Maschine/Anlage? Dann zählt der
  // Maschinenstundensatz mit - beim Aufheizen steht die Spritzmaschine still
  // und verdient nichts, kostet aber.
  maschinengebunden: { type: Boolean, default: true },
  // Formgebung oder CNC? Ein Elastomer-Artikel wird nie gedreht, ein
  // PTFE-Drehteil nie kryogen entgratet - die Oberfläche zeigt beim Artikel
  // deshalb nur die Schritte seines Bereichs. 'beide' gilt überall
  // (Sichtkontrolle, Verpacken, Waschen).
  bereich: { type: String, enum: ['formgebung', 'cnc', 'beide'], default: 'beide' },
  bemerkung: { type: String, default: '' },
  reihenfolge: { type: Number, default: 0 },
  aktiv: { type: Boolean, default: true },
});

module.exports = mongoose.model('Arbeitsgang', arbeitsgangSchema, 'arbeitsgaenge');
