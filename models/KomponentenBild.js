const mongoose = require('mongoose');

// Das eigentliche Foto zum Wareneingang (meist die handschriftlich notierte
// Charge) liegt in einer eigenen Sammlung - NICHT mehr im Auftrag selbst.
//
// Grund: die Fotos machten über 80 MB in der Auftrags-Sammlung aus, im Schnitt
// 531 KB je Auftrag. Dadurch konnte MongoDB die Aufträge nicht mehr sortieren
// ("Sort exceeded memory limit"), und die 16-MB-Grenze je Dokument rückte näher.
// Dasselbe Vorgehen wie bei Zeichnungen/Einstelldatenblättern (ArtikelDatei).
//
// Im Auftrag bleibt je Komponente nur der Vermerk, DASS ein Foto da ist
// (Dateiname, Typ, Datum) - der Inhalt kommt über die eigene Bild-Route.
const komponentenBildSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  // Position der Komponente in order.komponenten
  index: { type: Number, required: true },
  filename: String,
  mimeType: String,
  data: String, // base64
  uploadedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});

komponentenBildSchema.index({ orderId: 1, index: 1 }, { unique: true });

// Sammlungsname ausdrücklich: Mongoose würde sonst "komponentenbilds" daraus
// machen - deutscher Plural, damit es in der Datenbank lesbar bleibt.
module.exports = mongoose.model('KomponentenBild', komponentenBildSchema, 'komponentenbilder');
