// Maschinenliste für den Server (Maschinen-Modus am Shopfloor-Tablet).
//
// Die Planung im Büro hat dieselbe Liste in public/app.js (dort zusätzlich mit
// Kapazität pro Tag) - wird dort eine Maschine ergänzt, gehört sie auch hierher.
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
];

module.exports = { MASCHINEN };
