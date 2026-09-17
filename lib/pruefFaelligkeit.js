// Rechnet aus, welche Prüfungen eines laufenden Auftrags gerade fällig sind -
// Grundlage für die Erinnerung am Maschinen-Tablet.
//
// Bewusst ohne hinterlegten Schichtplan: die Schichtzeiten sind in der
// Fertigung individuell. Stattdessen gilt ein fester Produktionstag ab 6 Uhr
// mit 8-Stunden-Blöcken (6-14, 14-22, 22-6). Für "einmal je Schicht" reicht
// das: es geht nur darum, dass die Prüfung nicht zweimal im selben Zeitblock
// als erledigt gilt bzw. nach einem Wechsel wieder eingefordert wird.
//
// Reine Funktionen ohne Datenbankzugriff, damit die Logik ohne laufenden
// Server geprüft werden kann.

const SCHICHT_START_MIN = 6 * 60; // Produktionstag beginnt 6:00 deutscher Zeit
const SCHICHT_DAUER_MIN = 8 * 60;

// Datum in deutscher Ortszeit zerlegen - der Server läuft in UTC, die Uhrzeit
// am Schichtbeginn meint aber immer die Uhr in der Fertigung.
function berlinTeile(date) {
  const formatter = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const teile = {};
  formatter.formatToParts(date).forEach(p => { teile[p.type] = p.value; });
  return {
    jahr: Number(teile.year), monat: Number(teile.month), tag: Number(teile.day),
    stunde: Number(teile.hour) % 24, minute: Number(teile.minute), sekunde: Number(teile.second),
  };
}

// Beginn des 8-Stunden-Blocks, in dem der Zeitpunkt liegt. Rückwärts gerechnet
// vom Zeitpunkt selbst, damit keine Zeitzonen-Umrechnung nötig ist.
function schichtBeginn(zeitpunkt) {
  const t = berlinTeile(zeitpunkt);
  const minutenSeitSchichtstart = ((t.stunde * 60 + t.minute) - SCHICHT_START_MIN + 1440) % 1440;
  const imBlock = minutenSeitSchichtstart % SCHICHT_DAUER_MIN;
  return new Date(zeitpunkt.getTime() - imBlock * 60000 - t.sekunde * 1000 - zeitpunkt.getMilliseconds());
}

// Frühester tatsächlich begonnener Produktionsabschnitt (Hauptabschnitt oder
// Teilmenge) - ab hier läuft der Auftrag auf der Maschine.
function produktionsStart(order, jetzt = new Date()) {
  const kandidaten = [order.startDatum, ...(order.teilmengen || []).map(t => t.startDatum)]
    .filter(Boolean)
    .map(d => new Date(d))
    .filter(d => d <= jetzt);
  if (kandidaten.length === 0) return order.startDatum ? new Date(order.startDatum) : null;
  return new Date(Math.min(...kandidaten.map(d => d.getTime())));
}

// Gefertigte Stückzahl bis zu einem Zeitpunkt: gemeldete Runden x Kavität, plus
// eine Schätzung für die Zeit seit der letzten Meldung (aus "Zeit pro 100").
// Die Werker melden die Runden erst am Schichtende - ohne Schätzung könnte eine
// stückzahlabhängige Prüfung während der Schicht nie fällig werden.
function gefertigteStueckzahl(order, bis = new Date()) {
  const meldungen = (order.produktion || [])
    .map(e => ({ stueckzahl: e.stueckzahl || 0, zeitpunkt: new Date(e.zeitpunkt) }))
    .filter(e => e.zeitpunkt <= bis)
    .sort((a, b) => a.zeitpunkt - b.zeitpunkt);

  const gemeldet = meldungen.reduce((s, e) => s + e.stueckzahl, 0);
  const letzteMeldung = meldungen.length ? meldungen[meldungen.length - 1].zeitpunkt : null;
  const start = produktionsStart(order, bis);
  const basis = letzteMeldung || start;

  let geschaetzt = 0;
  if (basis && order.zeitProHundert > 0) {
    const minuten = Math.max(0, (bis - basis) / 60000);
    geschaetzt = Math.floor((minuten / order.zeitProHundert) * 100);
  }

  const obergrenze = order.gesamtmenge || order.menge || Infinity;
  return {
    gemeldet,
    geschaetzt,
    gesamt: Math.min(gemeldet + geschaetzt, obergrenze),
    letzteMeldung,
  };
}

function letztePruefung(order, pruefpunktId) {
  const treffer = (order.massungen || [])
    .filter(m => String(m.pruefpunktId) === String(pruefpunktId))
    .map(m => new Date(m.zeitpunkt))
    .sort((a, b) => b - a);
  return treffer[0] || null;
}

function minutenText(minuten) {
  const m = Math.round(minuten);
  if (m < 60) return `${m} min`;
  const stunden = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${stunden} h ${rest} min` : `${stunden} h`;
}

// Fälligkeit je Prüfpunkt des Artikels. Prozessschritte ('prozess') stehen auf
// dem Prozessbegleitschein und wiederholen sich nicht - sie bleiben außen vor.
function pruefFaelligkeit(order, plp = [], jetzt = new Date()) {
  const start = produktionsStart(order, jetzt);
  const erstfreigabe = order.erstfreigabe?.erteilt && order.erstfreigabe.zeitpunkt
    ? new Date(order.erstfreigabe.zeitpunkt)
    : null;
  const stueck = gefertigteStueckzahl(order, jetzt);

  return plp
    .filter(p => p.typ === 'masspruefung' || p.typ === 'iopruefung')
    .map(p => {
      const letzte = letztePruefung(order, p._id);
      // Ohne eigene Prüfung zählt die Erstfreigabe als letzte dokumentierte
      // Prüfung - direkt danach muss nicht sofort wieder geprüft werden.
      const basis = letzte || erstfreigabe || start;
      const eintrag = {
        pruefpunktId: String(p._id),
        bezeichnung: p.bezeichnung,
        typ: p.typ,
        intervallTyp: p.intervallTyp || 'sonstige',
        intervallWert: p.intervallWert ?? null,
        pruefhaeufigkeit: p.pruefhaeufigkeit || '',
        letztePruefung: letzte,
        status: 'ok',
        faelligAb: null,
        ueberfaelligMin: 0,
        hinweis: '',
      };

      if (eintrag.intervallTyp === 'einmalig') {
        if (letzte || erstfreigabe) {
          eintrag.hinweis = 'Einmalige Prüfung ist dokumentiert';
          return eintrag;
        }
        eintrag.status = 'faellig';
        eintrag.faelligAb = start;
        eintrag.ueberfaelligMin = start ? Math.max(0, (jetzt - start) / 60000) : 0;
        eintrag.hinweis = 'Einmalige Prüfung steht noch aus';
        return eintrag;
      }

      if (eintrag.intervallTyp === 'zeit') {
        if (!p.intervallWert || !basis) {
          eintrag.status = 'manuell';
          eintrag.hinweis = 'Kein Intervallwert hinterlegt';
          return eintrag;
        }
        const faelligAb = new Date(basis.getTime() + p.intervallWert * 60000);
        eintrag.faelligAb = faelligAb;
        if (jetzt >= faelligAb) {
          eintrag.status = 'faellig';
          eintrag.ueberfaelligMin = (jetzt - faelligAb) / 60000;
          eintrag.hinweis = `Seit ${minutenText(eintrag.ueberfaelligMin)} fällig`;
        } else {
          eintrag.hinweis = `Nächste Prüfung in ${minutenText((faelligAb - jetzt) / 60000)}`;
        }
        return eintrag;
      }

      if (eintrag.intervallTyp === 'schicht') {
        const beginn = schichtBeginn(jetzt);
        eintrag.faelligAb = beginn;
        if (!basis || basis < beginn) {
          eintrag.status = 'faellig';
          eintrag.ueberfaelligMin = (jetzt - beginn) / 60000;
          eintrag.hinweis = 'In dieser Schicht noch nicht geprüft';
        } else {
          eintrag.hinweis = 'In dieser Schicht bereits geprüft';
        }
        return eintrag;
      }

      if (eintrag.intervallTyp === 'stueckzahl') {
        if (!p.intervallWert) {
          eintrag.status = 'manuell';
          eintrag.hinweis = 'Kein Intervallwert hinterlegt';
          return eintrag;
        }
        const standBasis = basis ? gefertigteStueckzahl(order, basis).gesamt : 0;
        const seitdem = Math.max(0, stueck.gesamt - standBasis);
        eintrag.stueckSeitPruefung = seitdem;
        if (seitdem >= p.intervallWert) {
          eintrag.status = 'faellig';
          // Für die Reihenfolge: je mehr Überschuss, desto dringender.
          eintrag.ueberfaelligMin = seitdem - p.intervallWert;
          eintrag.hinweis = `${seitdem} Stk seit der letzten Prüfung (Intervall ${p.intervallWert} Stk)`;
        } else {
          eintrag.hinweis = `Noch ${p.intervallWert - seitdem} Stk bis zur nächsten Prüfung`;
        }
        return eintrag;
      }

      eintrag.status = 'manuell';
      eintrag.hinweis = p.pruefhaeufigkeit || 'Kein automatisches Intervall';
      return eintrag;
    })
    .sort((a, b) => {
      if (a.status === 'faellig' && b.status !== 'faellig') return -1;
      if (b.status === 'faellig' && a.status !== 'faellig') return 1;
      return b.ueberfaelligMin - a.ueberfaelligMin;
    });
}

module.exports = {
  SCHICHT_START_MIN,
  SCHICHT_DAUER_MIN,
  schichtBeginn,
  produktionsStart,
  gefertigteStueckzahl,
  pruefFaelligkeit,
};
