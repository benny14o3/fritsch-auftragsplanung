const mongoose = require('mongoose');

// Zeichnungen und Einstelldatenblätter liegen bewusst NICHT mehr im
// Artikelstamm-Dokument: dort teilen sich ALLE Artikel ein einziges
// MongoDB-Dokument, und dessen hartes 16-MB-Limit war mit 34 PDFs erreicht -
// weitere Uploads sind danach fehlgeschlagen, und jedes Laden des
// Artikelstamms hat die kompletten PDFs mitgeschleppt.
//
// Ein Dokument je Datei (~400 KB) hat dieses Problem nicht. Die Datei wird nur
// geladen, wenn sie wirklich gebraucht wird (Vorschau, Artikelmappe) - der
// Artikelstamm liefert nur noch Dateiname/Typ/Datum als Hinweis, dass etwas
// hinterlegt ist.
const artikelDateiSchema = new mongoose.Schema({
  material: { type: String, required: true },
  feld: { type: String, enum: ['zeichnung', 'einstelldatenblatt', 'qpa'], required: true },
  filename: String,
  mimeType: String,
  data: String, // base64
  uploadedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});

// Je Artikel und Feld gibt es genau eine Datei - ein erneuter Upload ersetzt
// die bisherige (wie vorher beim eingebetteten Feld).
artikelDateiSchema.index({ material: 1, feld: 1 }, { unique: true });

module.exports = mongoose.model('ArtikelDatei', artikelDateiSchema);
