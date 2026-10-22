// Die Kostensätze - der Lohn jedes einzelnen Mitarbeiters, die Maschinenwerte,
// die Marge - sind auch unter Admins nichts, was geteilt werden soll. Sie hängen
// deshalb nicht an der Rolle, sondern an genau einem Konto. Sonst würde ein
// zweiter Admin (Vertretung, QS) die Löhne mitlesen, ohne dass es jemand merkt.
//
// Über INHABER_EMAIL umstellbar, damit ein Wechsel ohne Code-Änderung geht.

const STANDARD = 'b.fritsch@fritsch-weinheim.com';

function inhaberEmail() {
  return String(process.env.INHABER_EMAIL || STANDARD).trim().toLowerCase();
}

function istInhaber(user) {
  if (!user || !user.email) return false;
  return String(user.email).trim().toLowerCase() === inhaberEmail();
}

module.exports = { istInhaber, inhaberEmail };
