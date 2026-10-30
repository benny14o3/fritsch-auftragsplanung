// Aus den eingetragenen Zahlen die Stundensätze rechnen.
//
// Eine einzige Stelle für die Formeln, damit Anzeige und spätere Kalkulation
// nicht auseinanderlaufen.
//
// Der wichtigste Punkt dabei: geteilt wird durch die PRODUKTIVEN Stunden, nicht
// durch die bezahlten oder die nominal verfügbaren. Kosten fallen über das
// ganze Jahr an, verdient werden können sie nur in der Zeit, in der wirklich
// gefertigt wird. Wer durch 1.760 statt durch 1.350 teilt, rechnet sich den
// Satz um ein Viertel zu niedrig - und merkt es erst am Jahresende.

const { MASCHINEN } = require('./maschinen');

function zahl(wert) {
  const n = Number(wert);
  return Number.isFinite(n) ? n : 0;
}

function jahresstunden(allgemein = {}) {
  if (zahl(allgemein.jahresstundenManuell) > 0) return zahl(allgemein.jahresstundenManuell);
  const nominal = zahl(allgemein.arbeitstageProJahr) * zahl(allgemein.schichtstundenProTag);
  const auslastung = zahl(allgemein.auslastungProzent) || 100;
  return Math.round(nominal * (auslastung / 100));
}

// Jahreskosten einer Anlage: Abschreibung, kalkulatorische Zinsen, Strom und
// Wartung. Bei Hilfsbetrieben zählt die eigene Laufzeit, nicht die Zeit, in der
// produziert wird - der Kompressor läuft auch in der Pause.
function jahreskostenAnlage(anlage, allgemein, laufstunden) {
  const wert = zahl(anlage.wiederbeschaffungswert);
  const dauer = zahl(anlage.nutzungsdauerJahre);
  const abschreibung = dauer > 0 ? wert / dauer : 0;
  const zinsen = (wert / 2) * (zahl(allgemein.zinssatzProzent) / 100);
  const strompreis = zahl(allgemein.strompreisCtProKwh) / 100; // €/kWh
  const energie = zahl(anlage.kw) * (zahl(anlage.lastanteilProzent) / 100) * zahl(laufstunden) * strompreis;
  const wartung = zahl(anlage.wartungProJahr);
  return { abschreibung, zinsen, energie, wartung, summe: abschreibung + zinsen + energie + wartung };
}

// Gilt der Hilfsbetrieb für diese Maschine?
function imUmlagekreis(hilfsbetrieb, maschine) {
  const kreis = hilfsbetrieb.umlagekreis || 'alle';
  if (kreis === 'alle') return true;
  if (kreis === 'Elastomer' || kreis === 'PTFE') return maschine.type === kreis;
  return kreis === maschine.id;
}

// Formgebung und CNC haben unterschiedliche Lohnniveaus. Wer nur in einem
// Bereich arbeitet, prägt auch nur dessen Satz; 'beide' zählt überall mit.
const BEREICHE = ['formgebung', 'cnc'];

function bereichVon(m) {
  return m.bereich === 'formgebung' || m.bereich === 'cnc' ? m.bereich : 'beide';
}

function bereicheUeberlappen(a, b) {
  return a === 'beide' || b === 'beide' || a === b;
}

// Gewichteter Satz je Rolle: nach produktiven Stunden, nicht als einfacher
// Mittelwert - wer mehr Stunden leistet, prägt den Satz stärker.
function rollenSaetze(personen) {
  const rollen = {};
  personen.forEach(m => {
    if (!m.rolle) return;
    // Ohne Wochenstunden gibt es keine produktiven Stunden - solche Personen
    // würden ihre Jahreskosten auf null Stunden verteilen und den Rollensatz
    // ins Absurde treiben. Sie zählen erst mit, wenn die Stunden eingetragen sind.
    if (m.produktiveStunden <= 0) return;
    const r = rollen[m.rolle] || (rollen[m.rolle] = { rolle: m.rolle, anzahl: 0, jahreskosten: 0, produktiveStunden: 0 });
    r.anzahl++;
    r.jahreskosten += m.jahreskosten;
    r.produktiveStunden += m.produktiveStunden;
  });
  return Object.values(rollen).map(r => ({
    ...r,
    stundensatz: r.produktiveStunden > 0 ? r.jahreskosten / r.produktiveStunden : 0,
  }));
}

function berechneSaetze(daten = {}) {
  const allgemein = daten.allgemein || {};
  const standardStunden = jahresstunden(allgemein);
  const strompreis = zahl(allgemein.strompreisCtProKwh) / 100;

  // --- Hilfsbetriebe: Jahreskosten und auf wen sie sich verteilen ---
  const hilfsbetriebe = (daten.hilfsbetriebe || []).map(h => {
    const laufstunden = zahl(h.laufstundenProJahr) || standardStunden;
    const kosten = jahreskostenAnlage(h, allgemein, laufstunden);
    const maschinenImKreis = MASCHINEN.filter(m => imUmlagekreis(h, m));
    const stundenImKreis = maschinenImKreis.reduce((summe, m) => {
      const eigene = (daten.maschinen || []).find(x => x.maschineId === m.id);
      return summe + (zahl(eigene?.jahresstundenAbweichend) || standardStunden);
    }, 0);
    return {
      name: h.name,
      umlagekreis: h.umlagekreis || 'alle',
      jahreskosten: kosten.summe,
      aufteilung: kosten,
      maschinen: maschinenImKreis.map(m => m.id),
      // Zuschlag je Maschinenstunde im Umlagekreis
      proStunde: stundenImKreis > 0 ? kosten.summe / stundenImKreis : 0,
    };
  });

  // --- Maschinen ---
  const maschinen = MASCHINEN.map(m => {
    const eigene = (daten.maschinen || []).find(x => x.maschineId === m.id) || {};
    const stunden = zahl(eigene.jahresstundenAbweichend) || standardStunden;
    const wert = zahl(eigene.wiederbeschaffungswert);
    const dauer = zahl(eigene.nutzungsdauerJahre);

    // Beigestellte Maschinen gehören dem Kunden: kein eigenes Kapital, also
    // weder Abschreibung noch kalkulatorische Zinsen.
    const beigestellt = eigene.eigentum === 'kunde';
    const abschreibung = !beigestellt && stunden > 0 && dauer > 0 ? wert / dauer / stunden : 0;
    const zinsen = !beigestellt && stunden > 0 ? (wert / 2) * (zahl(allgemein.zinssatzProzent) / 100) / stunden : 0;
    const energie = zahl(eigene.kw) * (zahl(eigene.lastanteilProzent) / 100) * strompreis;
    const raum = stunden > 0 ? zahl(eigene.qm) * zahl(allgemein.raumkostenProQmJahr) / stunden : 0;
    const wartung = stunden > 0 ? zahl(eigene.wartungProJahr) / stunden : 0;
    const hilfsbetrieb = hilfsbetriebe
      .filter(h => h.maschinen.includes(m.id))
      .reduce((summe, h) => summe + h.proStunde, 0);

    const eigenanteil = abschreibung + zinsen + energie + raum + wartung;
    // Eine Anlage, auf die nicht geplant wird, hat keine Auslastung, aus der
    // sich die Jahresstunden ableiten liessen. Mit dem Pauschalwert gerechnet
    // waere ihr Satz um ein Vielfaches zu niedrig - eine Waschanlage laeuft
    // nicht 1.300 Stunden im Jahr. Sie gilt deshalb erst als vollstaendig,
    // wenn ihre eigenen Stunden eingetragen sind.
    const eigeneStundenNoetig = m.planbar === false && zahl(eigene.jahresstundenAbweichend) <= 0;
    return {
      maschineId: m.id,
      name: m.name,
      type: m.type,
      planbar: m.planbar !== false,
      jahresstunden: stunden,
      eigentum: eigene.eigentum || 'eigen',
      posten: { abschreibung, zinsen, energie, raum, wartung, hilfsbetrieb },
      stundensatz: eigenanteil + hilfsbetrieb,
      // Beigestellte Maschinen brauchen keinen Anschaffungswert, um vollständig
      // zu sein - dort zählen nur die laufenden Kosten.
      vollstaendig: stunden > 0 && !eigeneStundenNoetig
        && (beigestellt ? (zahl(eigene.kw) > 0 || zahl(eigene.qm) > 0) : wert > 0 && dauer > 0),
      fehlendeStunden: eigeneStundenNoetig,
    };
  });

  // --- Mitarbeiter: tatsächliche Kosten je Stunde ---
  // Produktive Stunden = Arbeitstage abzüglich Urlaub und Krankheit, mal der
  // täglichen Arbeitszeit. Bezahlt werden mehr Stunden, als an der
  // Wertschöpfung ankommen - gerechnet wird mit den produktiven.
  const arbeitstageNetto = Math.max(0,
    zahl(allgemein.arbeitstageProJahr) - zahl(allgemein.urlaubstageProJahr) - zahl(allgemein.krankheitstageProJahr));
  const mitarbeiter = (daten.mitarbeiter || []).filter(m => m.aktiv !== false).map(m => {
    const wochenstunden = zahl(m.wochenstunden);
    const produktiveStunden = arbeitstageNetto * (wochenstunden / 5);
    const jahreskosten = zahl(m.agKostenMonat) * 12;
    return {
      name: m.name,
      firma: m.firma || '',
      persnr: m.persnr || '',
      rolle: m.rolle || '',
      bereich: bereichVon(m),
      agKostenMonat: zahl(m.agKostenMonat),
      kostenAngleichen: !!m.kostenAngleichen,
      wochenstunden,
      jahreskosten,
      produktiveStunden,
      stundensatz: produktiveStunden > 0 ? jahreskosten / produktiveStunden : 0,
    };
  });

  // Von Hand gesetzte Stundensätze gelten vor allem anderen - sie fließen auch
  // in den Rollenschnitt ein, weil sie das sind, was die Stunde kosten soll.
  mitarbeiter.forEach(m => {
    const manuell = zahl((daten.mitarbeiter || []).find(x => x.name === m.name)?.stundensatzManuell);
    if (manuell <= 0) return;
    m.stundensatzBerechnet = m.stundensatz;
    m.stundensatz = manuell;
    m.jahreskosten = manuell * m.produktiveStunden;
    m.agKostenEigen = m.agKostenMonat;
    m.agKostenMonat = m.jahreskosten / 12;
    m.manuell = true;
  });

  // Angeglichene Personen bekommen den Stundensatz der übrigen ihrer Rolle -
  // aber nur derjenigen, mit denen sie sich einen Bereich teilen. Sonst würde
  // eine Werkerin in der Formgebung an einem teuren CNC-Dreher gemessen.
  // Erst danach werden die Rollensätze gebildet, damit der Durchschnitt nicht
  // auf sich selbst zurückwirkt.
  const vergleichbar = mitarbeiter.filter(m => m.rolle && !m.kostenAngleichen && m.produktiveStunden > 0);
  mitarbeiter.filter(m => m.kostenAngleichen && m.rolle).forEach(m => {
    const pool = vergleichbar.filter(x => x.rolle === m.rolle && bereicheUeberlappen(x.bereich, m.bereich));
    const stunden = pool.reduce((s, x) => s + x.produktiveStunden, 0);
    if (stunden <= 0) return;
    const kosten = pool.reduce((s, x) => s + x.jahreskosten, 0);
    m.stundensatzEigen = m.stundensatz;
    m.agKostenEigen = m.agKostenMonat;
    m.stundensatz = kosten / stunden;
    m.jahreskosten = m.stundensatz * m.produktiveStunden;
    m.agKostenMonat = m.jahreskosten / 12;
    m.angeglichen = true;
  });

  // Je Rolle ein Satz - einmal über alle (für Arbeitsgänge, die keinem Bereich
  // zugeordnet sind, z.B. Verpacken) und einmal je Bereich, weil die
  // Kalkulation eines Elastomer-Artikels nicht mit CNC-Löhnen rechnen darf.
  const rollen = rollenSaetze(mitarbeiter);
  const rollenBereich = {};
  BEREICHE.forEach(bereich => {
    rollenBereich[bereich] = rollenSaetze(mitarbeiter.filter(m => bereicheUeberlappen(m.bereich, bereich)));
  });

  // --- Löhne ---
  const loehne = (daten.loehne || []).map(l => {
    const stunden = zahl(l.produktiveStundenProJahr);
    return {
      rolle: l.rolle,
      stundensatz: stunden > 0 ? zahl(l.jahreskostenArbeitgeber) / stunden : 0,
      produktiveStundenProJahr: stunden,
      anzahlMitarbeiter: zahl(l.anzahlMitarbeiter),
    };
  });

  return {
    jahresstunden: standardStunden,
    arbeitstageNetto,
    maschinen,
    hilfsbetriebe,
    loehne,
    mitarbeiter,
    rollen,
    rollenBereich,
    zuschlaege: daten.zuschlaege || {},
  };
}

module.exports = { berechneSaetze, jahresstunden, BEREICHE };
