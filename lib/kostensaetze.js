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

    const abschreibung = stunden > 0 && dauer > 0 ? wert / dauer / stunden : 0;
    const zinsen = stunden > 0 ? (wert / 2) * (zahl(allgemein.zinssatzProzent) / 100) / stunden : 0;
    const energie = zahl(eigene.kw) * (zahl(eigene.lastanteilProzent) / 100) * strompreis;
    const raum = stunden > 0 ? zahl(eigene.qm) * zahl(allgemein.raumkostenProQmJahr) / stunden : 0;
    const wartung = stunden > 0 ? zahl(eigene.wartungProJahr) / stunden : 0;
    const hilfsbetrieb = hilfsbetriebe
      .filter(h => h.maschinen.includes(m.id))
      .reduce((summe, h) => summe + h.proStunde, 0);

    const eigenanteil = abschreibung + zinsen + energie + raum + wartung;
    return {
      maschineId: m.id,
      name: m.name,
      type: m.type,
      jahresstunden: stunden,
      posten: { abschreibung, zinsen, energie, raum, wartung, hilfsbetrieb },
      stundensatz: eigenanteil + hilfsbetrieb,
      vollstaendig: wert > 0 && dauer > 0 && stunden > 0,
    };
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
    maschinen,
    hilfsbetriebe,
    loehne,
    zuschlaege: daten.zuschlaege || {},
  };
}

module.exports = { berechneSaetze, jahresstunden };
