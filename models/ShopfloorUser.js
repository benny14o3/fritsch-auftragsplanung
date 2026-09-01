const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Eigene, einfache Konten für die Werkstatt (Kürzel + PIN) - getrennt von den
// Büro-Konten (models/User.js), damit ein Shopfloor-Zugang kein volles
// Planungskonto mit Adminrechten voraussetzt.
const shopfloorUserSchema = new mongoose.Schema({
  kuerzel: { type: String, required: true, unique: true, uppercase: true, trim: true },
  name: { type: String, required: true },
  pin: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

shopfloorUserSchema.pre('save', async function(next) {
  if (!this.isModified('pin')) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.pin = await bcrypt.hash(this.pin, salt);
    next();
  } catch (err) { next(err); }
});

shopfloorUserSchema.methods.comparePin = async function(pin) { return bcrypt.compare(pin, this.pin); };
module.exports = mongoose.model('ShopfloorUser', shopfloorUserSchema);
