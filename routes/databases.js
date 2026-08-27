const express = require('express');
const Database = require('../models/Database');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');

const router = express.Router();

router.get('/', authMiddleware, async (req, res) => {
  try {
    const databases = await Database.find();
    res.json(databases);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:type', authMiddleware, async (req, res) => {
  try {
    const db = await Database.findOne({ type: req.params.type });
    if (!db) return res.status(404).json({ error: 'Datenbank nicht gefunden' });
    res.json(db);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:type', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { type } = req.params;
    const { articles } = req.body;
    if (!['Elastomer', 'PTFE'].includes(type)) return res.status(400).json({ error: 'Ungültiger DB-Typ' });
    let db = await Database.findOne({ type });
    if (!db) {
      db = new Database({ type, articles, updatedBy: req.userId });
    } else {
      db.articles = articles;
      db.updatedBy = req.userId;
      db.lastUpdated = new Date();
    }
    await db.save();
    res.json(db);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:type', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await Database.deleteOne({ type: req.params.type });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
