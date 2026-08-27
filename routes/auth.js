const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { email, name, password, passwordConfirm, inviteCode } = req.body;
    if (!email || !name || !password || !passwordConfirm) return res.status(400).json({ error: 'Alle Felder erforderlich' });
    if (password !== passwordConfirm) return res.status(400).json({ error: 'Passwörter stimmen nicht überein' });
    if (!inviteCode || inviteCode !== process.env.INVITE_CODE) return res.status(403).json({ error: 'Ungültiger Einladungscode' });
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: 'Email bereits registriert' });
    const userCount = await User.countDocuments();
    const role = userCount === 0 ? 'admin' : 'user';
    const user = await User.create({ email, name, password, company: 'Formteile Fritsch GmbH', role });
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: user._id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/invite', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Nur Admins können einladen' });
    res.json({ inviteCode: process.env.INVITE_CODE });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email und Passwort erforderlich' });
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Email oder Passwort falsch' });
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) return res.status(401).json({ error: 'Email oder Passwort falsch' });
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
