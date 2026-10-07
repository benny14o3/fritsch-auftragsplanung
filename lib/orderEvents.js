// Live-Benachrichtigung, wenn sich an den Aufträgen etwas ändert.
//
// Statt dass jeder Bildschirm im Sekundentakt nachfragt ("ist was Neues da?"),
// hält er eine offene Verbindung und bekommt Bescheid, sobald jemand etwas
// ändert - egal ob aus dem Büro oder vom Shopfloor. Ausgelöst wird das zentral
// über die Mongoose-Hooks in models/Order.js, damit keine Route vergessen
// werden kann.
//
// Zusätzlich zählt eine Version mit: ein Bildschirm, der die Verbindung
// verloren hat (Standby, WLAN-Wechsel, Proxy), erkennt damit beim nächsten
// Abgleich, ob er etwas verpasst hat.

let version = Date.now();
const abonnenten = new Set();

function aktuelleVersion() {
  return version;
}

// Wird von jedem schreibenden Zugriff auf Aufträge aufgerufen.
function meldeAenderung() {
  version = Date.now();
  const nachricht = `event: aenderung\ndata: ${JSON.stringify({ version })}\n\n`;
  abonnenten.forEach(res => {
    try { res.write(nachricht); } catch (err) { abonnenten.delete(res); }
  });
}

function abonniere(res) {
  abonnenten.add(res);
  return () => abonnenten.delete(res);
}

function anzahlAbonnenten() {
  return abonnenten.size;
}

module.exports = { aktuelleVersion, meldeAenderung, abonniere, anzahlAbonnenten };
