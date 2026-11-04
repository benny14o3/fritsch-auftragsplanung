// Wer darf an einem Auftrag WAS ändern?
//
// Zwei Stufen (Admin oder nur ansehen) reichen nicht: Ein Kundenmitarbeiter
// soll Termine verschieben und kommentieren dürfen, aber keine Mengen
// korrigieren; ein Einrichter soll Wareneingänge buchen und Aufträge
// weiterschalten, aber nicht den Bereich umhängen.
//
// Die Rechte hängen deshalb an einzelnen Feldern, nicht an der Rolle. Was
// hier nicht steht, bleibt Admins vorbehalten - eine neue Funktion ist damit
// automatisch gesperrt, statt versehentlich für alle offen zu sein.

const FELDRECHTE = {
  // Termine und Maschinenbelegung - das "Verschieben" im Planungsboard.
  // Der korrigierte Liefertermin gehört dazu: wer verschiebt, muss dem Kunden
  // einen neuen Termin nennen können. Das Datum AUS der Bestellung
  // (lieferdatum) bleibt Admins vorbehalten, das ist eine Tatsache, kein Plan.
  planen: ['maschineId', 'maschineId2', 'startDatum', 'endDatum', 'position',
    'manuellEingeplant', 'schichten', 'bearbeitungsMin',
    'lieferterminKorrigiert', 'lieferterminGrund'],

  kommentieren: ['kommentar'],

  // Charge, Wareneingangsdatum und Lieferantenangaben je Komponente.
  wareneingang: ['komponenten'],

  // Auftrag weiterschalten: Produktion -> Endbearbeitung -> Ausgeliefert.
  phase: ['phase', 'status', 'warenausgang', 'archiviertAm'],

  menge: ['menge', 'gesamtmenge', 'bestellmenge', 'lieferungen', 'teilmengen'],
};

const ALLE_RECHTE = Object.keys(FELDRECHTE);

// Lesbare Namen für die Zugangsverwaltung.
const BESCHRIFTUNG = {
  planen: 'Aufträge verschieben',
  kommentieren: 'Kommentare schreiben',
  wareneingang: 'Wareneingänge buchen',
  phase: 'Endbearbeitung und Ausgeliefert setzen',
  menge: 'Mengen anpassen',
};

function rechteVon(user) {
  if (!user) return [];
  // Admins dürfen alles - die Liste ist für die übrigen Konten da.
  if (user.role === 'admin') return [...ALLE_RECHTE];
  return (user.rechte || []).filter(r => ALLE_RECHTE.includes(r));
}

// Welche Felder im Body darf dieser Benutzer nicht setzen?
// Gibt die Feldnamen zurück; eine leere Liste heißt: alles erlaubt.
function verbotenefelder(user, body = {}) {
  if (user && user.role === 'admin') return [];
  const erlaubt = new Set();
  rechteVon(user).forEach(r => FELDRECHTE[r].forEach(f => erlaubt.add(f)));
  return Object.keys(body).filter(f => !erlaubt.has(f));
}

module.exports = { FELDRECHTE, ALLE_RECHTE, BESCHRIFTUNG, rechteVon, verbotenefelder };
