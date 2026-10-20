#!/usr/bin/env node
/*
 * Rücksicherung aus einer Backup-Datei (siehe routes/backup.js).
 *
 * Bewusst als Skript und nicht als Knopf in der App: eine Rücksicherung
 * überschreibt den aktuellen Stand und soll nicht versehentlich passieren.
 *
 * Verwendung:
 *   node scripts/restore.js <datei.json>                      Übersicht, ändert nichts
 *   node scripts/restore.js <datei.json> --sammlung orders    nur diese Sammlung, Probelauf
 *   node scripts/restore.js <datei.json> --sammlung orders --wirklich
 *
 * Ohne --wirklich wird NICHTS geschrieben.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');

const datei = process.argv[2];
const sammlungArg = process.argv.includes('--sammlung')
  ? process.argv[process.argv.indexOf('--sammlung') + 1]
  : null;
const wirklich = process.argv.includes('--wirklich');

if (!datei || !fs.existsSync(datei)) {
  console.error('Bitte die Backup-Datei angeben: node scripts/restore.js <datei.json>');
  process.exit(1);
}

(async () => {
  const sicherung = JSON.parse(fs.readFileSync(datei, 'utf8'));
  console.log(`Sicherung vom ${new Date(sicherung.erstelltAm).toLocaleString('de-DE')}`);
  console.log(`Dateien enthalten: ${sicherung.mitDateien ? 'ja' : 'nein'}\n`);

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const sammlungen = Object.keys(sicherung.daten);
  console.log('Sammlung'.padEnd(22), 'in der Sicherung'.padStart(16), 'aktuell'.padStart(10));
  for (const name of sammlungen) {
    const aktuell = await db.collection(name).countDocuments();
    console.log(name.padEnd(22), String(sicherung.daten[name].length).padStart(16), String(aktuell).padStart(10));
  }

  if (!sammlungArg) {
    console.log('\nNichts geändert. Zum Zurückspielen eine Sammlung wählen:');
    console.log('  node scripts/restore.js', datei, '--sammlung orders');
    await mongoose.disconnect();
    return;
  }

  const dokumente = sicherung.daten[sammlungArg];
  if (!dokumente) {
    console.error(`\nDie Sammlung "${sammlungArg}" steckt nicht in dieser Sicherung.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const aktuell = await db.collection(sammlungArg).countDocuments();
  console.log(`\n${sammlungArg}: ${aktuell} Dokumente werden ersetzt durch ${dokumente.length} aus der Sicherung.`);

  if (!wirklich) {
    console.log('PROBELAUF - nichts geschrieben. Mit --wirklich ausführen, wenn das so gewollt ist.');
    await mongoose.disconnect();
    return;
  }

  // Den aktuellen Stand vorher wegschreiben - auch eine Rücksicherung kann
  // der falsche Griff sein.
  const vorher = await db.collection(sammlungArg).find({}).toArray();
  const sicherheitsdatei = `${datei}.vor-rueckspielung-${sammlungArg}-${Date.now()}.json`;
  fs.writeFileSync(sicherheitsdatei, JSON.stringify(vorher));
  console.log('Aktueller Stand gesichert nach:', sicherheitsdatei);

  await db.collection(sammlungArg).deleteMany({});
  if (dokumente.length > 0) {
    // In Blöcken einfügen, damit große Sammlungen (Dateien) nicht am
    // 16-MB-Limit je Anfrage scheitern.
    for (let i = 0; i < dokumente.length; i += 20) {
      await db.collection(sammlungArg).insertMany(dokumente.slice(i, i + 20));
    }
  }
  console.log('Zurückgespielt:', await db.collection(sammlungArg).countDocuments(), 'Dokumente');
  await mongoose.disconnect();
})();
