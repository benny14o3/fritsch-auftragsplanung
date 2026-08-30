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

// Einzelnen Artikel hinzufügen, ohne die ganze Datenbank per Excel neu hochzuladen.
router.post('/:type/articles', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { type } = req.params;
    if (!['Elastomer', 'PTFE'].includes(type)) return res.status(400).json({ error: 'Ungültiger DB-Typ' });
    const { material, beschreibung, maschine, kavitaet, rundenProSchicht, zeitProHundert } = req.body;
    if (!material) return res.status(400).json({ error: 'Artikelnummer fehlt' });

    let db = await Database.findOne({ type });
    if (!db) db = new Database({ type, articles: [] });
    if (db.articles.some(a => a.material === material)) {
      return res.status(409).json({ error: `Artikel ${material} existiert bereits` });
    }
    db.articles.push({ material, beschreibung, maschine, kavitaet, rundenProSchicht, zeitProHundert });
    db.updatedBy = req.userId;
    db.lastUpdated = new Date();
    await db.save();
    res.status(201).json(db.articles[db.articles.length - 1]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Einzelnen Artikel bearbeiten.
router.patch('/:type/articles/:articleId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = await Database.findOne({ type: req.params.type });
    if (!db) return res.status(404).json({ error: 'Datenbank nicht gefunden' });
    const article = db.articles.id(req.params.articleId);
    if (!article) return res.status(404).json({ error: 'Artikel nicht gefunden' });

    const { material, beschreibung, maschine, kavitaet, rundenProSchicht, zeitProHundert } = req.body;
    if (material !== undefined) article.material = material;
    if (beschreibung !== undefined) article.beschreibung = beschreibung;
    if (maschine !== undefined) article.maschine = maschine;
    if (kavitaet !== undefined) article.kavitaet = kavitaet;
    if (rundenProSchicht !== undefined) article.rundenProSchicht = rundenProSchicht;
    if (zeitProHundert !== undefined) article.zeitProHundert = zeitProHundert;
    db.updatedBy = req.userId;
    db.lastUpdated = new Date();
    await db.save();
    res.json(article);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Einzelnen Artikel löschen.
router.delete('/:type/articles/:articleId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = await Database.findOne({ type: req.params.type });
    if (!db) return res.status(404).json({ error: 'Datenbank nicht gefunden' });
    const article = db.articles.id(req.params.articleId);
    if (!article) return res.status(404).json({ error: 'Artikel nicht gefunden' });
    article.deleteOne();
    db.updatedBy = req.userId;
    db.lastUpdated = new Date();
    await db.save();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
