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
  bemerkung: { type: String, default: '' },
  reihenfolge: { type: Number, default: 0 },
  aktiv: { type: Boolean, default: true },
});

module.exports = mongoose.model('Arbeitsgang', arbeitsgangSchema, 'arbeitsgaenge');
