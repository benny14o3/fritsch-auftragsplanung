require('dotenv').config();
require('express-async-errors');

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const authRoutes = require('./routes/auth');
const orderRoutes = require('./routes/orders');
const artikelstammRoutes = require('./routes/artikelstamm');
const shopfloorRoutes = require('./routes/shopfloor');

const app = express();

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", 'https://cdn.jsdelivr.net'],
      // pdf.js lädt seinen Worker als eigenes Script (teils über eine blob:-URL) -
      // ohne das bricht die PDF-Konvertierung im Bestellungskonverter.
      "worker-src": ["'self'", 'blob:', 'https://cdn.jsdelivr.net'],
      "child-src": ["'self'", 'blob:', 'https://cdn.jsdelivr.net'],
    },
  },
}));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// MongoDB Verbindung
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('✅ MongoDB verbunden');
}).catch(err => {
  console.error('❌ MongoDB Fehler:', err);
  process.exit(1);
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/artikelstamm', artikelstammRoutes);
app.use('/api/shopfloor', shopfloorRoutes);

// Frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/shopfloor', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'shopfloor.html'));
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('Fehler:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Interner Fehler'
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Nicht gefunden' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});
