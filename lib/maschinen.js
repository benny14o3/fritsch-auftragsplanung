// Maschinenliste für den Server (Maschinen-Modus am Shopfloor-Tablet).
//
// Die Planung im Büro hat dieselbe Liste in public/app.js (dort zusätzlich mit
// Kapazität pro Tag) - wird dort eine Maschine ergänzt, gehört sie auch hierher.
//
// planbar: false heißt - die Anlage taucht in der Produktionsplanung und am
// Tablet NICHT auf, bekommt aber einen eigenen Stundensatz. Das braucht jede
// Anlage, auf der ein Arbeitsgang läuft, ohne dass Auftraege auf sie geplant
// werden: Waschanlage, Kryo-Entgratung, Temperofen. Sie unterscheiden sich
// darin von den Hilfsbetrieben (Kompressor, Kühlaggregat), die immer
// mitlaufen und deshalb auf alle Maschinenstunden umgelegt werden - eine
// Waschanlage kostet nur, wenn tatsächlich gewaschen wird.
//
// type 'beide' heißt: dient Formgebung und CNC. Bereichsbezogene
// Hilfsbetriebsumlagen ('Elastomer' oder 'PTFE') greifen bei ihr deshalb
// nicht, nur der Umlagekreis 'alle' - sonst würde dieselbe Umlage über zwei
// Bereiche doppelt zugewiesen.
const MASCHINEN = [
  { id: 'MG1', name: 'Maplan Gummi 1', type: 'Elastomer' },
  { id: 'MG2', name: 'Maplan Gummi 2', type: 'Elastomer' },
  { id: 'MS1', name: 'Maplan Silikon 1', type: 'Elastomer' },
  { id: 'MS2', name: 'Maplan Silikon 2', type: 'Elastomer' },
  { id: 'DoLa', name: 'DoLa', type: 'PTFE' },
  { id: 'DoRev', name: 'DoRev', type: 'PTFE' },
  { id: 'DoRevLa', name: 'DoRevLa', type: 'PTFE' },
  { id: 'Portalfraese', name: 'Portalfräse', type: 'PTFE' },
  { id: 'SpinnerAlterLader', name: 'Spinner alter Lader', type: 'PTFE' },
  { id: 'SpinnerFST', name: 'Spinner FST', type: 'PTFE' },
  { id: 'SpinnerNeuerLader', name: 'Spinner neuer Lader', type: 'PTFE' },
  { id: 'SpinnerRev', name: 'Spinner Rev', type: 'PTFE' },
  { id: 'Laser', name: 'Laser', type: 'PTFE' },
  { id: 'Manuell', name: 'Manuell', type: 'PTFE' },

  // --- Anlagen ohne Planung, nur für die Kalkulation ---
  { id: 'Waschanlage', name: 'Reinigungsanlage', type: 'beide', planbar: false },
];

module.exports = { MASCHINEN };
