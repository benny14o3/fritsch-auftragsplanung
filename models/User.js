const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  company: { type: String, default: 'Formteile Fritsch GmbH' },
  // Wer den Einladungscode kennt, kann sich ein Konto anlegen - der Code laesst
  // sich weitergeben und ist damit kein Zugangsschutz. Ein neues Konto ist
  // deshalb gesperrt, bis der Inhaber es freigibt. Ohne Freigabe kommt man
  // weder durch den Login noch mit einem Token, das vorher ausgestellt wurde
  // (middleware/auth.js prueft bei jeder Anfrage).
  freigegeben: { type: Boolean, default: false },
  freigegebenAm: { type: Date, default: null },
  freigegebenVon: { type: String, default: null },
  // Warum gesperrt - erscheint in der Benutzerverwaltung, damit nach Monaten
  // noch nachvollziehbar ist, weshalb jemand draussen steht.
  sperrgrund: { type: String, default: '' },
  letzterLogin: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) { next(err); }
});

userSchema.methods.comparePassword = async function(pwd) { return bcrypt.compare(pwd, this.password); };
module.exports = mongoose.model('User', userSchema);
