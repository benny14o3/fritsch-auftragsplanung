// Aus Arbeitsplan, Material, Werkzeug und den Stundensätzen den Stückpreis
// eines Artikels rechnen - mit Staffel, weil sich Rüsten und Chargen auf die
// Losgröße verteilen.
//
// Eine einzige Stelle für die Formel, wie bei lib/kostensaetze.js: Anzeige
// und spätere Angebote dürfen nicht auseinanderlaufen.
//
// Grundsatz: Was fehlt, wird nicht geschätzt, sondern als Warnung gemeldet.
// Ein Preis, in dem stillschweigend ein Arbeitsgang mit 0 Euro steckt, sieht
// genauso belastbar aus wie ein vollständiger - und ist es nicht.

function zahl(wert) {
  const n = Number(wert);
  return Number.isFinite(n) ? n : 0;
}

// Arbeitsgänge, die auf der Maschine des Artikels laufen. Alles andere, was
// eine Anlage belegt, hat seine eigene (Waschanlage, Laser) oder noch keine
// mit Stundensatz (Kryo-Entgratung, Temperofen, Säge) - das darf nicht die
// Spritzmaschine oder Drehbank kosten.
const AUF_ARTIKELMASCHINE = ['ruesten_personell', 'aufheizen', 'formgebung', 'ruesten_cnc', 'drehen', 'fraesen'];
const EIGENE_ANLAGE = { waschen: 'Waschanlage', lasern: 'Laser' };

// Die Rollen im Arbeitsgang-Katalog heißen anders als die der Mitarbeiter.
const ROLLE_ZU_LOHNROLLE = { einrichter: 'einrichter', maschinenbediener: 'werker', kontrolle: 'qs' };

// Im Artikel steht die Maschine als Freitext ("DoRev", "Maplan Gummi").
// Passt er auf genau eine Maschine, gilt deren Satz; passt er auf eine Gruppe
// (Maplan Gummi -> Gummi 1 und 2), der Mittelwert - welche der beiden den
// Auftrag fährt, entscheidet erst die Planung.
function maschineDesArtikels(text, saetze) {
  const gesucht = String(text || '').trim().toLowerCase();
  if (!gesucht) return { text: '', treffer: [], satz: 0, vollstaendig: false };
  const alle = saetze.maschinen || [];
  let treffer = alle.filter(m => m.name.toLowerCase() === gesucht || m.maschineId.toLowerCase() === gesucht);
  if (treffer.length === 0) treffer = alle.filter(m => m.name.toLowerCase().startsWith(gesucht + ' '));
  const satz = treffer.length > 0 ? treffer.reduce((s, m) => s + m.stundensatz, 0) / treffer.length : 0;
  return {
    text: String(text).trim(),
    treffer: treffer.map(m => m.name),
    satz,
    vollstaendig: treffer.length > 0 && treffer.every(m => m.vollstaendig),
  };
}

function lohnsatz(gang, bereich, saetze) {
  const lohnrolle = ROLLE_ZU_LOHNROLLE[gang.rolle];
  if (!lohnrolle) return { satz: 0, fehlt: false }; // 'keine': Anlage läuft allein
  // Schritte beider Bereiche (Verpacken, Sichtkontrolle) rechnen mit dem Satz
  // über alle, die übrigen mit dem ihres Bereichs - CNC-Löhne dürfen die
  // Formgebung nicht verteuern.
  const quelle = gang.bereich === 'formgebung' || gang.bereich === 'cnc'
    ? (saetze.rollenBereich?.[gang.bereich] || [])
    : bereich && gang.bereich !== 'beide' ? (saetze.rollenBereich?.[bereich] || []) : (saetze.rollen || []);
  const eintrag = quelle.find(r => r.rolle === lohnrolle) || (saetze.rollen || []).find(r => r.rolle === lohnrolle);
  return { satz: eintrag ? eintrag.stundensatz : 0, fehlt: !eintrag };
}

// Dieselben Formeln wie die Vorschau in public/app.js (materialProTeil,
// werkzeugProTeil) - dort nur zur Anzeige neben dem Eingabefeld.
function materialProTeil(m) {
  const preis = zahl(m.preis);
  if (!preis) return 0;
  switch (m.preisEinheit) {
    case 'hundert': return preis / 100;
    case 'kg': return preis * (zahl(m.gewichtG) / 1000);
    case 'platte': return zahl(m.teileProPlatte) > 0 ? preis / zahl(m.teileProPlatte) : 0;
    default: return preis;
  }
}

function werkzeugProTeil(w, zeitProHundert) {
  const preis = zahl(w.preis);
  const schneiden = zahl(w.schneidenProPlatte);
  if (!preis || !schneiden) return 0;
  if ((w.standzeitArt || 'teile') === 'teile') {
    return zahl(w.teileProSchneide) > 0 ? preis / (schneiden * zahl(w.teileProSchneide)) : 0;
  }
  if (zahl(w.minutenProSchneide) <= 0) return 0;
  return (preis / (schneiden * zahl(w.minutenProSchneide))) * (zahl(zeitProHundert) / 100);
}

// artikel: Eintrag aus dem Artikelstamm, katalog: Arbeitsgänge,
// saetze: Ergebnis von berechneSaetze(), optionen: { mengen, ausschussProzent,
// margeProzent, verwaltungProzent } - die Prozente überschreiben für diese
// eine Rechnung die hinterlegten Zuschläge (z.B. Gravur ohne Ausschuss).
function kalkuliere(artikel, katalog, saetze, optionen = {}) {
  const warnungen = [];
  const bereich = artikel.dbType === 'PTFE' ? 'cnc' : artikel.dbType === 'Elastomer' ? 'formgebung' : null;
  const maschine = maschineDesArtikels(artikel.maschine, saetze);

  const z = saetze.zuschlaege || {};
  const prozent = (eigen, hinterlegt) => (eigen !== undefined && eigen !== null && eigen !== '' ? zahl(eigen) : zahl(hinterlegt));
  const zuschlaege = {
    ausschussProzent: prozent(optionen.ausschussProzent, z.ausschussProzent),
    verwaltungVertriebProzent: prozent(optionen.verwaltungProzent, z.verwaltungVertriebProzent),
    margeProzent: prozent(optionen.margeProzent, z.margeProzent),
  };

  const plan = artikel.arbeitsgaenge || [];
  if (plan.length === 0) warnungen.push('Kein Arbeitsplan hinterlegt - ohne Arbeitsgänge gibt es keine Fertigungskosten.');

  let brauchtArtikelmaschine = false;
  const schritte = plan.map(eintrag => {
    const gang = katalog.find(g => g.schluessel === eintrag.schluessel);
    if (!gang) {
      warnungen.push(`Arbeitsgang "${eintrag.schluessel}" steht nicht mehr im Katalog und zählt nicht mit.`);
      return null;
    }

    // --- Zeit ---
    let minuten = 0;          // je Teil, je Charge oder je Auftrag
    let zeitText = '';
    let chargengroesse = 0;
    if (gang.abrechnung === 'stueck') {
      let sek = zahl(eintrag.zeitSek) || zahl(gang.standardzeitSek);
      // Die Formgebung hat ihre Zeit schon im Artikelstamm: eine Runde dauert
      // 480 min / Runden je Schicht und bringt so viele Teile wie Kavitäten.
      // Dieselbe Formel wie in der Planung (berechneBearbeitungszeit).
      if (!sek && gang.schluessel === 'formgebung' && zahl(artikel.kavitaet) > 0 && zahl(artikel.rundenProSchicht) > 0) {
        sek = (480 * 60 / zahl(artikel.rundenProSchicht)) / zahl(artikel.kavitaet);
        zeitText = `${sek.toLocaleString('de-DE', { maximumFractionDigits: 1 })} s/Teil (aus ${artikel.kavitaet} Kavitäten, ${artikel.rundenProSchicht} Runden/Schicht)`;
      }
      if (!sek) warnungen.push(`${gang.name}: keine Zeit je Teil eingetragen - zählt mit 0 €.`);
      minuten = sek / 60;
      zeitText = zeitText || `${sek.toLocaleString('de-DE', { maximumFractionDigits: 2 })} s/Teil`;
    } else if (gang.abrechnung === 'charge') {
      minuten = zahl(eintrag.chargenzeitMin) || zahl(gang.standardChargenzeitMin);
      chargengroesse = zahl(eintrag.chargengroesse) || zahl(gang.standardChargengroesse);
      if (!minuten) warnungen.push(`${gang.name}: keine Dauer je Charge eingetragen - zählt mit 0 €.`);
      if (!chargengroesse) warnungen.push(`${gang.name}: keine Teile je Charge eingetragen - der Schritt lässt sich nicht aufs Teil umlegen und zählt mit 0 €.`);
      zeitText = `${minuten.toLocaleString('de-DE')} min je ${chargengroesse || '?'} Teile`;
    } else {
      minuten = zahl(eintrag.ruestzeitMin) || zahl(gang.standardRuestzeitMin);
      if (!minuten) warnungen.push(`${gang.name}: keine Zeit je Auftrag eingetragen - zählt mit 0 €.`);
      zeitText = `${minuten.toLocaleString('de-DE')} min je Auftrag`;
    }

    // --- Personal ---
    const lohn = lohnsatz(gang, bereich, saetze);
    if (lohn.fehlt) warnungen.push(`${gang.name}: für die Rolle gibt es keinen Lohnsatz - Personal zählt mit 0 €.`);
    const personalanteil = gang.rolle === 'keine' ? 0 : zahl(gang.personalanteilProzent) / 100;

    // --- Maschine ---
    let maschinensatz = 0;
    let maschinenName = '';
    if (gang.maschinengebunden) {
      if (EIGENE_ANLAGE[gang.schluessel]) {
        const anlage = (saetze.maschinen || []).find(m => m.maschineId === EIGENE_ANLAGE[gang.schluessel]);
        maschinensatz = anlage ? anlage.stundensatz : 0;
        maschinenName = anlage ? anlage.name : '';
        if (!anlage) warnungen.push(`${gang.name}: Anlage hat keinen Stundensatz - Maschinenkosten zählen mit 0 €.`);
        else if (!anlage.vollstaendig) warnungen.push(`${gang.name}: Stundensatz der Anlage "${anlage.name}" ist unvollständig (Kostensätze prüfen).`);
      } else if (AUF_ARTIKELMASCHINE.includes(gang.schluessel)) {
        brauchtArtikelmaschine = true;
        maschinensatz = maschine.satz;
        maschinenName = maschine.treffer.join(' / ');
      } else {
        warnungen.push(`${gang.name}: läuft auf einer eigenen Anlage, für die kein Stundensatz hinterlegt ist - nur Personal gerechnet.`);
      }
    }

    const stunden = minuten / 60;
    const personal = stunden * lohn.satz * personalanteil;
    const maschinenkosten = stunden * maschinensatz;
    return {
      schluessel: gang.schluessel,
      name: gang.name,
      abrechnung: gang.abrechnung,
      zeitText,
      chargengroesse,
      lohnsatz: lohn.satz,
      personalanteilProzent: personalanteil * 100,
      maschinensatz,
      maschinenName,
      personal,
      maschine: maschinenkosten,
      // Kosten je Einheit der Abrechnung: je Teil, je Charge oder je Auftrag
      kosten: personal + maschinenkosten,
    };
  }).filter(Boolean);

  if (brauchtArtikelmaschine) {
    if (!maschine.text) warnungen.push('Beim Artikel ist keine Maschine eingetragen - Maschinenkosten zählen mit 0 €.');
    else if (maschine.treffer.length === 0) warnungen.push(`Maschine "${maschine.text}" hat keinen Stundensatz in den Kostensätzen - Maschinenkosten zählen mit 0 €.`);
    else if (!maschine.vollstaendig) warnungen.push(`Stundensatz von ${maschine.treffer.join(' / ')} ist unvollständig (Kostensätze prüfen).`);
  }

  // --- Material und Werkzeug je Teil ---
  const material = [];
  (artikel.komponenten || []).filter(k => k.beschaffung === 'zukauf').forEach(k => {
    const proTeil = materialProTeil(k);
    if (!proTeil) warnungen.push(`Material ${k.artikelnummer || k.bezeichnung}: als Zukauf markiert, aber ohne vollständigen Preis - zählt mit 0 €.`);
    material.push({ bezeichnung: [k.artikelnummer, k.bezeichnung].filter(Boolean).join(' '), proTeil });
  });
  (artikel.zusatzmaterial || []).forEach(m => {
    const proTeil = materialProTeil(m);
    if (!proTeil) warnungen.push(`Material ${m.bezeichnung}: Preis oder Ausbeute fehlt - zählt mit 0 €.`);
    material.push({ bezeichnung: m.bezeichnung, proTeil });
  });
  const werkzeug = (artikel.werkzeugverbrauch || []).map(w => {
    const proTeil = werkzeugProTeil(w, artikel.zeitProHundert);
    if (!proTeil) warnungen.push(`Werkzeug ${w.bezeichnung}: Preis oder Standzeit fehlt - zählt mit 0 €.`);
    return { bezeichnung: w.bezeichnung, proTeil };
  });

  const summe = (liste, feld) => liste.reduce((s, x) => s + x[feld], 0);
  const stueckProTeil = summe(schritte.filter(s => s.abrechnung === 'stueck'), 'kosten');
  const ruestenProAuftrag = summe(schritte.filter(s => s.abrechnung === 'auftrag'), 'kosten');
  const materialSumme = summe(material, 'proTeil');
  const werkzeugSumme = summe(werkzeug, 'proTeil');

  const mengen = (optionen.mengen || []).map(zahl).filter(m => m > 0);
  const staffel = (mengen.length > 0 ? mengen : [100, 500, 1000, 5000]).map(menge => {
    // Eine Charge kostet gleich viel, egal wie voll sie ist - die letzte,
    // angebrochene zählt deshalb ganz.
    const chargeProTeil = schritte.filter(s => s.abrechnung === 'charge' && s.chargengroesse > 0)
      .reduce((s, x) => s + Math.ceil(menge / x.chargengroesse) * x.kosten / menge, 0);
    const ruestProTeil = ruestenProAuftrag / menge;
    const herstellkosten = ruestProTeil + chargeProTeil + stueckProTeil + materialSumme + werkzeugSumme;
    // Für 100 gute Teile müssen 100 / (1 - Ausschuss) gefertigt werden.
    const ausschuss = Math.min(zuschlaege.ausschussProzent, 99) / 100;
    const mitAusschuss = herstellkosten / (1 - ausschuss);
    const selbstkosten = mitAusschuss * (1 + zuschlaege.verwaltungVertriebProzent / 100);
    const preis = selbstkosten * (1 + zuschlaege.margeProzent / 100);
    return { menge, ruestProTeil, chargeProTeil, stueckProTeil, materialProTeil: materialSumme, werkzeugProTeil: werkzeugSumme,
      herstellkosten, mitAusschuss, selbstkosten, preis, auftragswert: preis * menge };
  });

  return {
    material: artikel.material,
    bezeichnung: artikel.bezeichnung || '',
    maschine,
    schritte,
    materialPositionen: material,
    werkzeugPositionen: werkzeug,
    ruestenProAuftrag,
    zuschlaege,
    staffel,
    warnungen,
    vollstaendig: warnungen.length === 0,
  };
}

module.exports = { kalkuliere };
