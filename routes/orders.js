const express = require('express');
const Order = require('../models/Order');
const Artikelstamm = require('../models/Artikelstamm');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');

const router = express.Router();

// Der komplette Plan ist geteilt (eine Firma, ein Board) - kein userId-Filter.
// Optionaler ?artikelnummer=-Filter für die FSK-Historie (alle Aufträge eines
// Artikels über alle Phasen hinweg, für den Export in der Artikelverwaltung).
router.get('/', authMiddleware, async (req, res) => {
  try {
    const filter = req.query.artikelnummer ? { artikelnummer: req.query.artikelnummer } : {};
    // Bilddaten (base64) hier bewusst ausblenden - dieser Endpunkt wird alle 6s
    // fürs Board gepollt, Dateiname/Datum reichen dafür als Vorschau-Hinweis.
    // Der eigentliche Bildinhalt kommt über die eigene Bild-Route (s.u.).
    const orders = await Order.find(filter).sort({ position: 1 }).select('-komponenten.bild.data');
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Fügt einen neuen Excel-Import zur bestehenden Planung hinzu, statt sie zu
// ersetzen - bestehende Aufträge (in jeder Phase) bleiben unangetastet. Anhand
// der Auftragsnummer erkannte Duplikate (egal in welcher Phase) werden
// übersprungen, damit ein erneuter Upload derselben Excel nichts verdoppelt.
router.post('/', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { orders } = req.body;
    const vorhandene = await Order.find({}).select('auftragsnummer');
    const skipSet = new Set(vorhandene.map(o => o.auftragsnummer).filter(Boolean));
    const uebersprungen = orders.filter(o => o.auftragsnummer && skipSet.has(o.auftragsnummer)).length;
    const gefiltert = orders.filter(o => !o.auftragsnummer || !skipSet.has(o.auftragsnummer));

    const maxPos = await Order.findOne().sort({ position: -1 }).select('position');
    const startPos = (maxPos?.position ?? -1) + 1;
    // insertMany() löst anders als create()/save() keine pre('save')-Hooks aus -
    // gesamtmenge (Basis für Teilmengen-Aufteilung) deshalb hier explizit setzen.
    const createdOrders = await Order.insertMany(
      gefiltert.map((o, idx) => ({ ...o, gesamtmenge: o.menge, position: startPos + idx, createdBy: req.userId, updatedBy: req.userId }))
    );
    res.status(201).json({ orders: createdOrders, uebersprungen });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Für Drag & Drop und Phasenwechsel (Produktion -> Endbearbeitung -> Ausgeliefert).
router.patch('/:orderId', authMiddleware, async (req, res) => {
  try {
    const { maschineId, maschineId2, startDatum, endDatum, position, status, komponenten, phase, warenausgang, dbType, manuellEingeplant, kommentar, menge, gesamtmenge, bearbeitungsMin, schichten, teilmengen } = req.body;
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    if (maschineId !== undefined) order.maschineId = maschineId;
    if (maschineId2 !== undefined) order.maschineId2 = maschineId2;
    if (startDatum !== undefined) order.startDatum = startDatum;
    if (endDatum !== undefined) order.endDatum = endDatum;
    if (position !== undefined) order.position = position;
    if (status !== undefined) order.status = status;
    if (komponenten !== undefined) {
      // Der Client hält Wareneingangs-Fotos bewusst nie im Speicher (siehe
      // GET /-Route oben) - beim Zurückschreiben der Komponenten-Liste (z.B.
      // Charge/Datum geändert) deshalb je Index das serverseitig hinterlegte
      // Bild übernehmen, statt es durch das PATCH zu löschen.
      const alte = order.komponenten;
      order.komponenten = komponenten.map((k, i) => ({ ...k, bild: alte[i]?.bild ?? null }));
    }
    if (phase !== undefined) order.phase = phase;
    if (warenausgang !== undefined) order.warenausgang = warenausgang;
    if (dbType !== undefined) order.dbType = dbType;
    if (manuellEingeplant !== undefined) order.manuellEingeplant = manuellEingeplant;
    if (kommentar !== undefined) order.kommentar = kommentar;
    // Für Teilmengen-Aufteilung: die "Hauptmenge" (Top-Level-Felder) schrumpft,
    // wenn ein Teil abgespalten wird, bzw. wächst wieder, wenn eine Teilmenge
    // rückgängig gemacht wird (siehe public/app.js splitTeilmenge/removeTeilmenge).
    if (menge !== undefined) order.menge = menge;
    // Nur bei nachträglicher Mengen-Korrektur mitgegeben (siehe setMenge in
    // public/app.js) - wandert im selben Umfang wie menge mit, damit sie weiter
    // der wahren Gesamtmenge entspricht.
    if (gesamtmenge !== undefined) order.gesamtmenge = gesamtmenge;
    if (bearbeitungsMin !== undefined) order.bearbeitungsMin = bearbeitungsMin;
    if (schichten !== undefined) order.schichten = schichten;
    if (teilmengen !== undefined) order.teilmengen = teilmengen;
    order.updatedBy = req.userId;
    await order.save();
    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Wareneingangs-Foto einer Komponente (z.B. die handschriftliche Charge) -
// eigene Route statt Teil des allgemeinen PATCH, weil das Bild als base64
// deutlich größer ist als die übrigen Felder und sonst bei jeder kleinen
// Änderung (Charge, Datum, ...) unnötig mitgeschickt werden müsste.
router.put('/:orderId/komponenten/:idx/bild', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    const komponente = order.komponenten[req.params.idx];
    if (!komponente) return res.status(404).json({ error: 'Komponente nicht gefunden' });
    const { filename, mimeType, data } = req.body;
    if (!filename || !mimeType || !data) return res.status(400).json({ error: 'Datei unvollständig' });
    komponente.bild = { filename, mimeType, data, uploadedAt: new Date() };
    order.updatedBy = req.userId;
    await order.save();
    res.json({ filename: komponente.bild.filename, mimeType: komponente.bild.mimeType, uploadedAt: komponente.bild.uploadedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bild inkl. Daten nur bei Bedarf abrufen (Lightbox), nicht im Board-Poll.
router.get('/:orderId/komponenten/:idx/bild', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId).select('komponenten');
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    const komponente = order.komponenten[req.params.idx];
    if (!komponente || !komponente.bild) return res.status(404).json({ error: 'Kein Bild hinterlegt' });
    res.json(komponente.bild);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:orderId/komponenten/:idx/bild', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    const komponente = order.komponenten[req.params.idx];
    if (!komponente) return res.status(404).json({ error: 'Komponente nicht gefunden' });
    komponente.bild = null;
    order.updatedBy = req.userId;
    await order.save();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Einzelnen Auftrag manuell anlegen, ohne den restlichen Plan anzurühren.
router.post('/manual', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { order } = req.body;
    if (!order || !order.auftragsnummer) {
      return res.status(400).json({ error: 'Auftragsnummer fehlt' });
    }
    const bereitsVorhanden = await Order.findOne({ auftragsnummer: order.auftragsnummer });
    if (bereitsVorhanden) {
      return res.status(409).json({ error: `Auftrag ${order.auftragsnummer} existiert bereits` });
    }
    const maxPos = await Order.findOne({ phase: 'produktion' }).sort({ position: -1 }).select('position');
    const created = await Order.create({
      ...order,
      phase: order.phase || 'produktion',
      position: (maxPos?.position ?? -1) + 1,
      createdBy: req.userId,
      updatedBy: req.userId,
    });
    res.status(201).json(created);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function istWochentag(date) {
  const tag = date.getDay();
  return tag !== 0 && tag !== 6;
}

function addWorkdays(date, tage) {
  const d = new Date(date);
  let hinzugefuegt = 0;
  while (hinzugefuegt < tage) {
    d.setDate(d.getDate() + 1);
    if (istWochentag(d)) hinzugefuegt++;
  }
  return d;
}

// Gleiche Formel wie berechneBearbeitungszeit() in public/app.js.
function berechneBearbeitungszeit(dbType, menge, kavitaet, rundenProSchicht, zeitProHundert) {
  const bearbeitungsMin = dbType === 'PTFE'
    ? (menge / 100) * (zeitProHundert || 0)
    : Math.ceil(menge / (kavitaet || 1)) * (480 / (rundenProSchicht || 1));
  const schichten = Math.ceil(bearbeitungsMin / 480);
  return { bearbeitungsMin, schichten, tage: Math.max(1, schichten) };
}

// Gleicht laufende Aufträge mit den aktuellen Artikelstamm-Daten ab - z.B.
// nachdem eine Stückliste oder ein Prozesswert (Kavität/Runden pro Schicht/
// Zeit pro 100) nachträglich korrigiert wurde und bereits geplante Aufträge
// noch die alten Werte tragen (die werden beim Import/Anlegen einmalig
// kopiert, siehe planMachines in app.js, und danach nicht mehr automatisch
// nachgezogen). Komponenten: bereits erfasster Wareneingang/Charge/Foto bleibt
// je Komponente erhalten (per Komponenten-Artikelnummer gematcht), nur die
// Liste selbst (neue/entfallene Komponenten, geänderte Bezeichnung) wird
// nachgezogen. Prozesszeiten: bearbeitungsMin/schichten (Haupt- und jeder
// Teilmengen-Abschnitt) werden neu berechnet, ein bereits gesetztes Startdatum
// bleibt fix, nur das Enddatum verschiebt sich entsprechend.
router.post('/sync-artikeldaten', authMiddleware, async (req, res) => {
  try {
    const { dbType } = req.body;
    const filter = { phase: 'produktion' };
    if (dbType) filter.dbType = dbType;
    const orders = await Order.find(filter);
    const artikelstamm = await Artikelstamm.findOne();
    const artikelByMaterial = new Map((artikelstamm?.artikel || []).map(a => [a.material, a]));

    const schluessel = k => k.artikelnummer || `#${k.bezeichnung}`;
    let aktualisiert = 0;

    for (const order of orders) {
      const artikel = artikelByMaterial.get(order.artikelnummer);
      if (!artikel) continue; // Artikel nicht (mehr) im Stamm - Auftrag unangetastet lassen

      let geaendert = false;

      const sollListe = (artikel.komponenten || []).map(k => ({ artikelnummer: k.artikelnummer || '', bezeichnung: k.bezeichnung }));
      // Das Werkzeug steht nicht in der Stückliste, gilt aber für jeden
      // Formgebungs-Artikel (siehe planMachines/manuelle Auftragsanlage in app.js).
      if (order.dbType === 'Elastomer') {
        sollListe.push({ artikelnummer: '', bezeichnung: 'Werkzeug' });
      }

      const bestehende = new Map(order.komponenten.map(k => [schluessel(k), k]));
      const komponentenUnveraendert = sollListe.length === order.komponenten.length &&
        sollListe.every((soll, i) => schluessel(soll) === schluessel(order.komponenten[i]) && soll.bezeichnung === order.komponenten[i].bezeichnung);
      if (!komponentenUnveraendert) {
        order.komponenten = sollListe.map(soll => {
          const alt = bestehende.get(schluessel(soll));
          return {
            artikelnummer: soll.artikelnummer,
            bezeichnung: soll.bezeichnung,
            wareneingang: alt?.wareneingang ?? null,
            charge: alt?.charge ?? '',
            bild: alt?.bild ?? null,
          };
        });
        geaendert = true;
      }

      const zeitenUnveraendert = (order.kavitaet ?? 0) === (artikel.kavitaet ?? 0)
        && (order.rundenProSchicht ?? 0) === (artikel.rundenProSchicht ?? 0)
        && (order.zeitProHundert ?? 0) === (artikel.zeitProHundert ?? 0);
      if (!zeitenUnveraendert) {
        order.kavitaet = artikel.kavitaet;
        order.rundenProSchicht = artikel.rundenProSchicht;
        order.zeitProHundert = artikel.zeitProHundert;

        const haupt = berechneBearbeitungszeit(order.dbType, order.menge, artikel.kavitaet, artikel.rundenProSchicht, artikel.zeitProHundert);
        order.bearbeitungsMin = haupt.bearbeitungsMin;
        order.schichten = haupt.schichten;
        if (order.startDatum) order.endDatum = addWorkdays(new Date(order.startDatum), haupt.tage - 1);

        order.teilmengen.forEach(t => {
          const teil = berechneBearbeitungszeit(order.dbType, t.menge, artikel.kavitaet, artikel.rundenProSchicht, artikel.zeitProHundert);
          t.bearbeitungsMin = teil.bearbeitungsMin;
          t.schichten = teil.schichten;
          if (t.startDatum) t.endDatum = addWorkdays(new Date(t.startDatum), teil.tage - 1);
        });
        geaendert = true;
      }

      if (!geaendert) continue;
      order.updatedBy = req.userId;
      await order.save();
      aktualisiert++;
    }

    res.json({ aktualisiert, geprueft: orders.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:orderId', authMiddleware, async (req, res) => {
  try {
    await Order.deleteOne({ _id: req.params.orderId });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Alle Aufträge unwiderruflich löschen (Produktion, Endbearbeitung, Ausgeliefert).
// Formgebung und CNC sind getrennte Bereiche - optional per ?dbType= auf einen davon
// einschränken, ohne query löscht es wirklich alles.
router.delete('/', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { dbType } = req.query;
    const filter = dbType ? { dbType } : {};
    const result = await Order.deleteMany(filter);
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
