const API_URL = '/api';
let token = localStorage.getItem('token');
let currentUser = null;
let converterData = [];
let converterPdfData = [];
// Prozessdaten (Maschine/Kavität/...) und Stückliste (Bezeichnung/Komponenten)
// in einer gemeinsamen Liste statt getrennter Elastomer-/PTFE-/Stückliste-Sammlungen.
let artikelstamm = { artikel: [] };

function findArtikel(material) {
    return artikelstamm.artikel.find(a => a.material === material) || null;
}

if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

function toggleRegister() {
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    if (loginForm) {
        loginForm.classList.toggle('hidden');
    }
    if (registerForm) {
        registerForm.classList.toggle('hidden');
    }
}

async function handleLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    try {
        const res = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error);

        token = data.token;
        currentUser = data.user;
        localStorage.setItem('token', token);
        showApp();
        loadArtikelstamm();
        loadInviteInfo();
    } catch (err) {
        document.getElementById('authError').textContent = err.message;
        document.getElementById('authError').classList.remove('hidden');
    }
}

async function handleRegister() {
    const name = document.getElementById('registerName').value.trim();
    const email = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;
    const passwordConfirm = document.getElementById('registerPasswordConfirm').value;
    const inviteCode = document.getElementById('registerInviteCode').value.trim();

    try {
        const res = await fetch(`${API_URL}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password, passwordConfirm, inviteCode }),
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error);

        token = data.token;
        currentUser = data.user;
        localStorage.setItem('token', token);
        showApp();
        loadArtikelstamm();
        loadInviteInfo();
    } catch (err) {
        document.getElementById('regError').textContent = err.message;
        document.getElementById('regError').classList.remove('hidden');
    }
}

function handleLogout() {
    localStorage.removeItem('token');
    location.reload();
}

function showApp() {
    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('appScreen').classList.remove('hidden');
    document.getElementById('userGreeting').textContent = `Angemeldet als ${currentUser.name}`;
    document.querySelectorAll('.admin-only').forEach(el => {
        el.classList.toggle('hidden', currentUser.role !== 'admin');
    });
    initFehlendeKomponentenToggle();
    loadExistingBoard();
}

function switchPage(event) {
    showPage(event.currentTarget.getAttribute('data-page'));
}

const ADMIN_ONLY_PAGES = ['converter', 'planner', 'databases'];
// Formgebung (Elastomer/Maplan) und CNC (PTFE) sind komplett getrennte Bereiche -
// eigenes Board, eigene Endbearbeitung, eigenes Ausgeliefert je Bereich.
const BOARD_PAGES = ['boardFormgebung', 'boardCnc', 'endbearbeitungFormgebung', 'endbearbeitungCnc', 'ausgeliefertFormgebung', 'ausgeliefertCnc'];
const DBTYPE_SUFFIX = { Elastomer: 'Formgebung', PTFE: 'Cnc' };

function showPage(page) {
    if (ADMIN_ONLY_PAGES.includes(page) && currentUser?.role !== 'admin') {
        page = 'boardFormgebung';
    }
    document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
    document.getElementById(page + 'Page').classList.remove('hidden');
    document.querySelectorAll('.sidebar-item[data-page]').forEach(el => {
        el.classList.toggle('active', el.getAttribute('data-page') === page);
    });

    if (BOARD_PAGES.includes(page)) loadExistingBoard();
    if (page === 'databases') fetchWerker();
}

async function loadExistingBoard() {
    try {
        const res = await fetch(`${API_URL}/orders`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) return;
        boardOrders = await res.json();
        renderAll();
        startBoardPolling();
    } catch (err) {
        // Board konnte nicht geladen werden, Schritt 3 kann neu geplant werden
    }
}

function readWorkbook(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                resolve(XLSX.read(data, { type: 'array' }));
            } catch (err) {
                reject(err);
            }
        };
        reader.readAsArrayBuffer(file);
    });
}

function parseExcel(file) {
    return readWorkbook(file).then(workbook => {
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        return XLSX.utils.sheet_to_json(worksheet);
    });
}

// Datenbank-Workbooks (elastomer.xlsm / ptfe.xlsm) haben mehrere Tabellenblätter
// (Dropdown, Simmerring, gelieferte Artikel, ...). Wir suchen gezielt das Blatt
// "<Typ> Datenbank" statt blind das erste Blatt zu nehmen.
function pickDatabaseSheet(workbook, keyword) {
    const names = workbook.SheetNames;
    const lower = names.map(n => n.toLowerCase());
    let idx = lower.findIndex(n => n.includes(keyword) && n.includes('datenbank'));
    if (idx === -1) idx = lower.findIndex(n => n.includes(keyword));
    if (idx === -1) {
        let best = 0, bestRows = -1;
        names.forEach((n, i) => {
            const ref = workbook.Sheets[n]['!ref'];
            const rows = ref ? XLSX.utils.decode_range(ref).e.r + 1 : 0;
            if (rows > bestRows) { bestRows = rows; best = i; }
        });
        idx = best;
    }
    return workbook.Sheets[names[idx]];
}

function findColumn(columns, ...keywords) {
    const norm = c => c.toLowerCase().replace(/\s+/g, ' ').trim();
    return columns.find(c => keywords.some(k => norm(c).includes(k)));
}

// Menge robust parsen - deutsche Zahlen nutzen "." als Tausender- und "," als
// Dezimaltrennzeichen (z.B. "2.200" = 2200, aus PDF/Excel oft mit Einheit
// dahinter wie "2.200 ST"). parseInt("2.200") würde fälschlich nur 2 liefern,
// weil es beim ersten Nicht-Ziffern-Zeichen abbricht - Mengen hier sind immer
// ganze Stückzahlen, deshalb werden Punkte konsequent als Tausendertrennzeichen
// behandelt.
function parseMenge(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (typeof value === 'number') return Math.round(value);
    let str = value.toString().trim().replace(/[^\d.,]/g, '');
    if (!str) return 0;
    str = str.replace(/\./g, '').replace(',', '.');
    const num = parseFloat(str);
    return isNaN(num) ? 0 : Math.round(num);
}

async function parseDatabaseFile(file, type) {
    const workbook = await readWorkbook(file);
    const sheet = pickDatabaseSheet(workbook, type.toLowerCase());
    const rows = XLSX.utils.sheet_to_json(sheet);
    const columns = Object.keys(rows[0] || {});

    const materialCol = findColumn(columns, 'material');
    const beschreibungCol = findColumn(columns, 'beschreibung');
    const maschineCol = findColumn(columns, 'maschine');

    if (type === 'PTFE') {
        const zeitCol = findColumn(columns, 'zeit für 100', 'zeit fuer 100', '100 stk', 'zeit');
        return rows.map(r => ({
            material: (r[materialCol] ?? '').toString().trim(),
            beschreibung: (r[beschreibungCol] ?? '').toString().trim(),
            maschine: (r[maschineCol] ?? '').toString().trim(),
            zeitProHundert: parseFloat(r[zeitCol]) || 0,
        })).filter(a => a.material);
    }

    const kavitaetCol = findColumn(columns, 'fachheit', 'kavit');
    const rundenCol = findColumn(columns, 'runden pro schicht', 'runden');
    return rows.map(r => ({
        material: (r[materialCol] ?? '').toString().trim(),
        beschreibung: (r[beschreibungCol] ?? '').toString().trim(),
        maschine: (r[maschineCol] ?? '').toString().trim(),
        kavitaet: parseInt(r[kavitaetCol]) || 0,
        rundenProSchicht: parseInt(r[rundenCol]) || 0,
    })).filter(a => a.material);
}

// Stückliste (SAP-BI-Export): mehrere Zeilen pro Artikel, das Material steht nur
// in der ersten Zeile jeder Gruppe, danach folgen die Komponenten-Zeilen.
function pickStücklisteSheet(workbook) {
    const names = workbook.SheetNames;
    let idx = names.findIndex(n => {
        const l = n.toLowerCase();
        return l.includes('stück') || l.includes('stueck');
    });
    if (idx === -1) {
        let best = 0, bestRows = -1;
        names.forEach((n, i) => {
            const ref = workbook.Sheets[n]['!ref'];
            const rows = ref ? XLSX.utils.decode_range(ref).e.r + 1 : 0;
            if (rows > bestRows) { bestRows = rows; best = i; }
        });
        idx = best;
    }
    return workbook.Sheets[names[idx]];
}

async function parseStueckliste(file) {
    const workbook = await readWorkbook(file);
    const sheet = pickStücklisteSheet(workbook);
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    const materialien = [];
    const byMaterial = new Map();
    let lastMaterial = null;
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i] || [];
        const [material, bezeichnung, , kompArtikel, kompBezeichnung, menge] = row;
        // Manche Exporte lassen Material nur in der ersten Komponentenzeile stehen
        // (danach leer), andere wiederholen es in jeder Zeile - beides abfangen.
        const materialStr = (material !== undefined && material !== null && material !== '')
            ? material.toString().trim() : null;
        if (materialStr) lastMaterial = materialStr;
        if (!lastMaterial) continue;

        // Ein Artikel kann in der Datei an mehreren, nicht direkt aufeinander-
        // folgenden Stellen auftauchen (z.B. Rohr und Feder in getrennten
        // Blöcken) - deshalb nach Materialnummer zusammenführen statt nur
        // aufeinanderfolgende Zeilen zu gruppieren, sonst gehen Komponenten
        // aus dem zweiten Block verloren.
        let current = byMaterial.get(lastMaterial);
        if (!current) {
            current = {
                material: lastMaterial,
                bezeichnung: (bezeichnung ?? '').toString().trim(),
                komponenten: [],
            };
            byMaterial.set(lastMaterial, current);
            materialien.push(current);
        } else if (!current.bezeichnung && bezeichnung) {
            current.bezeichnung = bezeichnung.toString().trim();
        }

        if (kompArtikel !== undefined && kompArtikel !== null && kompArtikel !== '') {
            current.komponenten.push({
                artikelnummer: kompArtikel.toString().trim(),
                bezeichnung: (kompBezeichnung ?? '').toString().trim(),
                menge: parseFloat(menge) || 0,
            });
        }
    }
    return materialien.filter(m => m.material);
}

document.getElementById('converterFile')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const rows = await parseExcel(file);
        const columns = Object.keys(rows[0] || {});
        const artikelCol = columns.find(c => c.toLowerCase().includes('artikel'));
        const auftragsCol = columns.find(c => c.toLowerCase().includes('auftrag'));
        const mengeCol = columns.find(c => c.toLowerCase().includes('menge'));
        const datumCol = columns.find(c => c.toLowerCase().includes('lieferdatum'));

        converterData = rows.map(r => ({
            artikelnummer: (r[artikelCol] || '').toString().replace('#', '').trim(),
            auftragsnummer: (r[auftragsCol] || '').toString().trim(),
            menge: parseMenge(r[mengeCol]),
            lieferdatum: r[datumCol] || '',
        })).filter(d => d.artikelnummer && d.menge > 0);

        const tbody = document.getElementById('converterTable');
        tbody.innerHTML = '';
        converterData.slice(0, 10).forEach(d => {
            tbody.innerHTML += `<tr><td>${d.artikelnummer}</td><td>${d.auftragsnummer}</td><td>${d.menge}</td><td>${d.lieferdatum}</td></tr>`;
        });

        document.getElementById('converterPreview').classList.remove('hidden');
    } catch (err) {
        alert('Fehler: ' + err.message);
    }
});

function exportConverterExcel() {
    const data = converterData.map(d => ({
        'Artikelnummer': d.artikelnummer,
        'Auftragsnummer': d.auftragsnummer,
        'Menge': d.menge,
        'Lieferdatum': d.lieferdatum,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Auftraege');
    XLSX.writeFile(wb, 'Auftragsplaner-Format.xlsx');
}

// Bestellungs-PDF (z.B. Freudenberg FST) einlesen und in die Auftragsplaner-
// Tabelle konvertieren. PDF.js liefert Textfragmente mit x/y-Position statt
// fertiger Zeilen - deshalb erst zu Zeilen gruppieren (übliche Technik: nach
// y-Koordinate sortieren, kleine Abweichungen als "gleiche Zeile" zählen).
function groupTextItemsIntoLines(items, yTolerance = 2) {
    const sortiert = [...items].sort((a, b) => {
        const dy = b.transform[5] - a.transform[5];
        if (Math.abs(dy) > yTolerance) return dy;
        return a.transform[4] - b.transform[4];
    });
    const zeilenItems = [];
    let aktuell = null;
    let aktuellY = null;
    sortiert.forEach(item => {
        if (aktuell === null || Math.abs(item.transform[5] - aktuellY) > yTolerance) {
            aktuell = [];
            aktuellY = item.transform[5];
            zeilenItems.push(aktuell);
        }
        aktuell.push(item);
    });
    return zeilenItems
        .map(its => its.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

async function extractPdfLines(file) {
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const alleZeilen = [];
    for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        alleZeilen.push(...groupTextItemsIntoLines(content.items));
    }
    return alleZeilen;
}

// Sucht ein Muster zeilenweise (nie über einen Zeilenumbruch hinweg) - sonst
// kann bei Spalten, die zufällig auf gleicher Höhe liegen und deshalb zu einer
// Zeile zusammengefasst wurden, ein Label mit dem Wert der falschen Nachbar-
// zeile "verschmelzen" (z.B. Label "Bestellnummer" ohne Wert in einer Zeile,
// Adresse + eigentliche Nummer in der nächsten).
function findInLines(zeilen, regex) {
    for (const zeile of zeilen) {
        const m = zeile.match(regex);
        if (m) return m;
    }
    return null;
}

// Jede Position beginnt mit einer Zeile "Pos-Nr. [Kennbuchstabe] Lieferdatum Menge ST"
// (z.B. "00010 T 25.10.2026 100 ST"). Bestellnummer/Belegdatum stehen einmal im
// Kopf der Bestellung, Auftragsnummer/Artikelnummer/Preis je Position im Text
// darunter, bis die nächste Position beginnt.
function parseBestellungsPdf(zeilen) {
    const bestellnummerMatch = findInLines(zeilen, /Bestellnummer\s+(\d[\w./-]*)/i);
    const bestellnummer = bestellnummerMatch ? bestellnummerMatch[1] : '';
    const belegdatumMatch = findInLines(zeilen, /Belegdatum\s+(\d{2}\.\d{2}\.\d{4})/i);
    const bestelldatum = belegdatumMatch ? belegdatumMatch[1] : '';

    const posZeilenRegex = /^\d{4,6}\s+[A-Za-z]?\s*(\d{2}\.\d{2}\.\d{4})\s+([\d.,]+)\s*ST/;
    const posIndizes = [];
    zeilen.forEach((zeile, i) => {
        if (posZeilenRegex.test(zeile)) posIndizes.push(i);
    });

    return posIndizes.map((startIdx, idx) => {
        const endIdx = idx + 1 < posIndizes.length ? posIndizes[idx + 1] : zeilen.length;
        const blockZeilen = zeilen.slice(startIdx, endIdx);

        const posMatch = zeilen[startIdx].match(posZeilenRegex);
        const auftragMatch = findInLines(blockZeilen, /Auftragsnummer:?\s*(\d+)/i);
        const artikelMatch = findInLines(blockZeilen, /#(\d+)/);
        const preisMatch = findInLines(blockZeilen, /Nettopreis\s+([\d.,]+)\s*EUR\s*\/\s*100\s*ST/i);

        return {
            artikelnummer: artikelMatch ? artikelMatch[1] : '',
            auftragsnummer: auftragMatch ? auftragMatch[1] : '',
            lieferdatum: posMatch ? posMatch[1] : '',
            menge: posMatch ? parseMenge(posMatch[2]) : 0,
            preis: preisMatch ? preisMatch[1] : '',
            bestellnummer,
            bestelldatum,
        };
    });
}

document.getElementById('converterPdfFile')?.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (files.length === 0) return;
    const note = document.getElementById('converterPdfNote');
    note.style.color = '#64748b';
    note.textContent = files.length === 1 ? 'Lese PDF...' : `Lese ${files.length} PDFs...`;

    converterPdfData = [];
    const fehlerhaft = [];
    for (const file of files) {
        try {
            const zeilen = await extractPdfLines(file);
            const rows = parseBestellungsPdf(zeilen);
            if (rows.length === 0) fehlerhaft.push(file.name);
            converterPdfData.push(...rows);
        } catch (err) {
            fehlerhaft.push(file.name);
        }
    }

    if (converterPdfData.length === 0) {
        note.style.color = '#b91c1c';
        note.textContent = 'Keine Positionen gefunden - das Format dieser PDF(s) weicht evtl. ab.';
        document.getElementById('converterPdfPreview').classList.add('hidden');
        return;
    }

    const tbody = document.getElementById('converterPdfTable');
    tbody.innerHTML = '';
    converterPdfData.forEach(d => {
        const tr = document.createElement('tr');
        [d.artikelnummer, d.auftragsnummer, d.lieferdatum, d.menge, d.preis, d.bestellnummer, d.bestelldatum].forEach(val => {
            const td = document.createElement('td');
            td.textContent = val;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    document.getElementById('converterPdfPreview').classList.remove('hidden');

    const anzahlDateien = files.length - fehlerhaft.length;
    let text = `✅ ${converterPdfData.length} Position${converterPdfData.length === 1 ? '' : 'en'} aus ${anzahlDateien} PDF${anzahlDateien === 1 ? '' : 's'} gefunden.`;
    if (fehlerhaft.length > 0) {
        text += ` ⚠️ Nicht erkannt: ${fehlerhaft.join(', ')}`;
    }
    note.style.color = fehlerhaft.length > 0 ? '#b45309' : '#15803d';
    note.textContent = text;
});

function exportConverterPdfExcel() {
    const data = converterPdfData.map(d => ({
        'Artikelnummer (#)': d.artikelnummer,
        'Auftragsnummer': d.auftragsnummer,
        'Lieferdatum': d.lieferdatum,
        'Menge': d.menge,
        'Preis (EUR /100 ST)': d.preis,
        'Bestellnummer': d.bestellnummer,
        'Bestelldatum': d.bestelldatum,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Bestellung');
    XLSX.writeFile(wb, 'Bestellung.xlsx');
}
document.getElementById('exportConverterPdfBtn')?.addEventListener('click', exportConverterPdfExcel);

document.getElementById('plannerOrders')?.addEventListener('change', async (e) => {
    const rows = await parseExcel(e.target.files[0]);
    planMachines(rows);
});

async function saveDatabase(type, file, statusEl) {
    if (!file) return;
    statusEl.textContent = 'Lade hoch...';
    try {
        const articles = await parseDatabaseFile(file, type);

        const res = await fetch(`${API_URL}/artikelstamm/upload/${type}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ articles }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        artikelstamm = data;
        renderDatabaseTable();
        statusEl.textContent = `✅ ${articles.length} Artikel gespeichert (${new Date(data.lastUpdated).toLocaleString('de-DE')})`;
    } catch (err) {
        statusEl.textContent = '❌ Fehler: ' + err.message;
    }
}

document.getElementById('dbElastomer')?.addEventListener('change', (e) => {
    saveDatabase('Elastomer', e.target.files[0], document.getElementById('elastomerStatus'));
});

document.getElementById('dbPtfe')?.addEventListener('change', (e) => {
    saveDatabase('PTFE', e.target.files[0], document.getElementById('ptfeStatus'));
});

document.getElementById('dbStueckliste')?.addEventListener('change', async (e) => {
    const statusEl = document.getElementById('stuecklisteStatus');
    const file = e.target.files[0];
    if (!file) return;
    statusEl.textContent = 'Lade hoch...';
    try {
        const materialien = await parseStueckliste(file);
        const res = await fetch(`${API_URL}/artikelstamm/upload/stueckliste`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ materialien }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        artikelstamm = data;
        renderDatabaseTable();
        statusEl.textContent = `✅ ${materialien.length} Artikel gespeichert (${new Date(data.lastUpdated).toLocaleString('de-DE')})`;
    } catch (err) {
        statusEl.textContent = '❌ Fehler: ' + err.message;
    }
});

async function loadArtikelstamm() {
    try {
        const res = await fetch(`${API_URL}/artikelstamm`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) return;
        artikelstamm = await res.json();

        const elastomerCount = artikelstamm.artikel.filter(a => a.dbType === 'Elastomer').length;
        const ptfeCount = artikelstamm.artikel.filter(a => a.dbType === 'PTFE').length;
        const komponentenCount = artikelstamm.artikel.filter(a => a.komponenten?.length > 0).length;
        const zeit = artikelstamm.lastUpdated ? new Date(artikelstamm.lastUpdated).toLocaleString('de-DE') : '';

        const elastomerStatusEl = document.getElementById('elastomerStatus');
        if (elastomerStatusEl && elastomerCount > 0) elastomerStatusEl.textContent = `✅ ${elastomerCount} Artikel gespeichert (${zeit})`;
        const ptfeStatusEl = document.getElementById('ptfeStatus');
        if (ptfeStatusEl && ptfeCount > 0) ptfeStatusEl.textContent = `✅ ${ptfeCount} Artikel gespeichert (${zeit})`;
        const stuecklisteStatusEl = document.getElementById('stuecklisteStatus');
        if (stuecklisteStatusEl && komponentenCount > 0) stuecklisteStatusEl.textContent = `✅ ${komponentenCount} Artikel gespeichert (${zeit})`;

        renderDatabaseTable();
    } catch (err) {
        // Artikelstamm konnte nicht geladen werden, Status bleibt leer
    }
}

// Einzelne Artikel direkt in der Weboberfläche pflegen, ohne jedes Mal die
// ganze Excel neu hochladen zu müssen. Prozessdaten (Typ/Maschine/Kavität/...)
// und Komponenten (Stückliste) sind jetzt EIN Artikelstamm statt getrennter
// Datenbank-/Stückliste-Sammlungen - eine Tabelle, ein Eintrag pro Artikel.
// Nur ein Artikel gleichzeitig editierbar. Komponenten-Textfeld: eine Zeile
// pro Komponente im Format "Artikelnummer | Bezeichnung | Menge".
let editingArticleMaterial = null;

function parseKomponentenText(text) {
    return (text || '')
        .split('\n')
        .map(zeile => zeile.trim())
        .filter(Boolean)
        .map(zeile => {
            const [artikelnummer, bezeichnung, menge] = zeile.split('|').map(t => (t ?? '').trim());
            return { artikelnummer: artikelnummer || '', bezeichnung: bezeichnung || '', menge: parseFloat(menge) || 0 };
        });
}

function formatKomponentenText(komponenten) {
    return (komponenten || []).map(k => `${k.artikelnummer} | ${k.bezeichnung} | ${k.menge}`).join('\n');
}

function renderDatabaseTable() {
    const tbody = document.getElementById('databaseArticleTable');
    if (!tbody) return;

    const filterVal = (document.getElementById('databaseFilter')?.value || '').toLowerCase().trim();
    const alle = artikelstamm.artikel || [];
    const filtered = filterVal
        ? alle.filter(a => (a.material || '').toLowerCase().includes(filterVal) || (a.bezeichnung || '').toLowerCase().includes(filterVal))
        : alle;

    tbody.innerHTML = '';
    filtered.forEach(article => {
        const isEditing = editingArticleMaterial === article.material;
        const tr = document.createElement('tr');
        const actionsTd = document.createElement('td');
        actionsTd.className = 'table-actions';

        if (!isEditing) {
            [article.dbType || '–', article.material, article.bezeichnung, article.maschine, article.kavitaet || '', article.rundenProSchicht || '', article.zeitProHundert || ''].forEach(val => {
                const td = document.createElement('td');
                td.textContent = val;
                tr.appendChild(td);
            });
            const kompTd = document.createElement('td');
            kompTd.style.whiteSpace = 'pre-line';
            kompTd.textContent = (article.komponenten || []).map(k => `${k.artikelnummer ? k.artikelnummer + ' - ' : ''}${k.bezeichnung}`).join('\n') || '–';
            tr.appendChild(kompTd);

            const shopfloorTd = document.createElement('td');
            const detailBtn = document.createElement('button');
            detailBtn.className = 'table-actions';
            detailBtn.style.cssText = 'font-size: 11px; padding: 5px 8px; border: 1px solid #e2e8f0; border-radius: 4px; background: #f8fafc; cursor: pointer; white-space: nowrap;';
            detailBtn.textContent = `📄 ${article.zeichnung ? '1' : '0'} · 🔧 ${article.einstelldatenblatt ? '1' : '0'} · 📋 ${(article.plp || []).length}`;
            detailBtn.title = 'Zeichnung & PLP';
            detailBtn.addEventListener('click', () => openArticleDetailModal(article.material));
            shopfloorTd.appendChild(detailBtn);
            tr.appendChild(shopfloorTd);

            const editBtn = document.createElement('button');
            editBtn.textContent = '✏️';
            editBtn.title = 'Bearbeiten';
            editBtn.addEventListener('click', () => {
                editingArticleMaterial = article.material;
                renderDatabaseTable();
            });

            const delBtn = document.createElement('button');
            delBtn.className = 'danger';
            delBtn.textContent = '🗑';
            delBtn.title = 'Löschen';
            let confirming = false;
            let resetTimer = null;
            delBtn.addEventListener('click', () => {
                if (!confirming) {
                    confirming = true;
                    delBtn.textContent = 'Sicher?';
                    resetTimer = setTimeout(() => {
                        confirming = false;
                        delBtn.textContent = '🗑';
                    }, 4000);
                    return;
                }
                clearTimeout(resetTimer);
                deleteDatabaseArticle(article.material);
            });

            actionsTd.appendChild(editBtn);
            actionsTd.appendChild(delBtn);
        } else {
            const typTd = document.createElement('td');
            const typSelect = document.createElement('select');
            typSelect.className = 'table-input';
            ['', 'Elastomer', 'PTFE'].forEach(opt => {
                const optionEl = document.createElement('option');
                optionEl.value = opt;
                optionEl.textContent = opt || '–';
                if ((article.dbType || '') === opt) optionEl.selected = true;
                typSelect.appendChild(optionEl);
            });
            typTd.appendChild(typSelect);
            tr.appendChild(typTd);

            const fields = [
                { key: 'material', value: article.material, inputType: 'text' },
                { key: 'bezeichnung', value: article.bezeichnung, inputType: 'text' },
                { key: 'maschine', value: article.maschine, inputType: 'text' },
                { key: 'kavitaet', value: article.kavitaet || '', inputType: 'number' },
                { key: 'rundenProSchicht', value: article.rundenProSchicht || '', inputType: 'number' },
                { key: 'zeitProHundert', value: article.zeitProHundert || '', inputType: 'number' },
            ];
            const inputs = {};
            fields.forEach(f => {
                const td = document.createElement('td');
                const input = document.createElement('input');
                input.className = 'table-input';
                input.type = f.inputType;
                input.value = f.value;
                td.appendChild(input);
                tr.appendChild(td);
                inputs[f.key] = input;
            });

            const kompTd = document.createElement('td');
            const kompTextarea = document.createElement('textarea');
            kompTextarea.className = 'table-input';
            kompTextarea.rows = Math.max(2, (article.komponenten || []).length);
            kompTextarea.value = formatKomponentenText(article.komponenten);
            kompTd.appendChild(kompTextarea);
            tr.appendChild(kompTd);

            const shopfloorEditTd = document.createElement('td');
            const detailEditBtn = document.createElement('button');
            detailEditBtn.style.cssText = 'font-size: 11px; padding: 5px 8px; border: 1px solid #e2e8f0; border-radius: 4px; background: #f8fafc; cursor: pointer; white-space: nowrap;';
            detailEditBtn.textContent = `📄 ${article.zeichnung ? '1' : '0'} · 🔧 ${article.einstelldatenblatt ? '1' : '0'} · 📋 ${(article.plp || []).length}`;
            detailEditBtn.title = 'Zeichnung & PLP';
            detailEditBtn.addEventListener('click', () => openArticleDetailModal(article.material));
            shopfloorEditTd.appendChild(detailEditBtn);
            tr.appendChild(shopfloorEditTd);

            const saveBtn = document.createElement('button');
            saveBtn.className = 'primary';
            saveBtn.textContent = '💾';
            saveBtn.title = 'Speichern';
            saveBtn.addEventListener('click', () => {
                saveEditArticle(article.material, {
                    material: inputs.material.value.trim(),
                    bezeichnung: inputs.bezeichnung.value.trim(),
                    dbType: typSelect.value || null,
                    maschine: inputs.maschine.value.trim(),
                    kavitaet: inputs.kavitaet.value ? Number(inputs.kavitaet.value) : 0,
                    rundenProSchicht: inputs.rundenProSchicht.value ? Number(inputs.rundenProSchicht.value) : 0,
                    zeitProHundert: inputs.zeitProHundert.value ? Number(inputs.zeitProHundert.value) : 0,
                    komponenten: parseKomponentenText(kompTextarea.value),
                });
            });

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = '✕';
            cancelBtn.title = 'Abbrechen';
            cancelBtn.addEventListener('click', () => {
                editingArticleMaterial = null;
                renderDatabaseTable();
            });

            actionsTd.appendChild(saveBtn);
            actionsTd.appendChild(cancelBtn);
        }

        tr.appendChild(actionsTd);
        tbody.appendChild(tr);
    });
}

async function addDatabaseArticle() {
    const note = document.getElementById('databaseArticleNote');
    const dbType = document.getElementById('databaseNewType').value || null;
    const material = document.getElementById('databaseNewMaterial').value.trim();
    const bezeichnung = document.getElementById('databaseNewBeschreibung').value.trim();
    const maschine = document.getElementById('databaseNewMaschine').value.trim();
    const kavitaetStr = document.getElementById('databaseNewKavitaet').value;
    const rundenStr = document.getElementById('databaseNewRunden').value;
    const zeitStr = document.getElementById('databaseNewZeit').value;
    const komponenten = parseKomponentenText(document.getElementById('databaseNewKomponenten').value);

    note.style.color = '#b91c1c';
    if (!material) {
        note.textContent = 'Bitte Artikelnummer angeben.';
        return;
    }

    try {
        const res = await fetch(`${API_URL}/artikelstamm/materialien`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
                material,
                bezeichnung,
                dbType,
                maschine,
                kavitaet: kavitaetStr ? Number(kavitaetStr) : 0,
                rundenProSchicht: rundenStr ? Number(rundenStr) : 0,
                zeitProHundert: zeitStr ? Number(zeitStr) : 0,
                komponenten,
            }),
        });
        const data = await res.json();
        if (!res.ok) {
            note.textContent = data.error || 'Anlegen fehlgeschlagen.';
            return;
        }
        const idx = artikelstamm.artikel.findIndex(a => a.material === material);
        if (idx !== -1) artikelstamm.artikel[idx] = data; else artikelstamm.artikel.push(data);
        renderDatabaseTable();
        note.style.color = '#15803d';
        note.textContent = `✅ Artikel ${material} gespeichert.`;
        ['NewMaterial', 'NewBeschreibung', 'NewMaschine', 'NewKavitaet', 'NewRunden', 'NewZeit', 'NewKomponenten'].forEach(id => {
            const el = document.getElementById(`database${id}`);
            if (el) el.value = '';
        });
    } catch (err) {
        note.textContent = 'Anlegen fehlgeschlagen. Bitte erneut versuchen.';
    }
}

async function saveEditArticle(material, updates) {
    const note = document.getElementById('databaseArticleNote');
    try {
        const res = await fetch(`${API_URL}/artikelstamm/materialien/${encodeURIComponent(material)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(updates),
        });
        const data = await res.json();
        if (!res.ok) {
            note.style.color = '#b91c1c';
            note.textContent = data.error || 'Speichern fehlgeschlagen.';
            return;
        }
        const idx = artikelstamm.artikel.findIndex(a => a.material === material);
        if (idx !== -1) artikelstamm.artikel[idx] = data;
        editingArticleMaterial = null;
        renderDatabaseTable();
        note.style.color = '#15803d';
        note.textContent = '✅ Artikel gespeichert.';
    } catch (err) {
        note.style.color = '#b91c1c';
        note.textContent = 'Speichern fehlgeschlagen. Bitte erneut versuchen.';
    }
}

async function deleteDatabaseArticle(material) {
    const note = document.getElementById('databaseArticleNote');
    try {
        const res = await fetch(`${API_URL}/artikelstamm/materialien/${encodeURIComponent(material)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) throw new Error();
        artikelstamm.artikel = artikelstamm.artikel.filter(a => a.material !== material);
        renderDatabaseTable();
        note.style.color = '#15803d';
        note.textContent = 'Artikel gelöscht.';
    } catch (err) {
        note.style.color = '#b91c1c';
        note.textContent = 'Löschen fehlgeschlagen. Bitte erneut versuchen.';
    }
}

document.getElementById('databaseAddArticleBtn')?.addEventListener('click', addDatabaseArticle);
document.getElementById('databaseFilter')?.addEventListener('input', renderDatabaseTable);

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

// --- Zeichnung + Produktionslenkungsplan je Artikel (für den Shopfloor) ---
let articleDetailMaterial = null;
let articleDetailPlpRows = [];

function openArticleDetailModal(material) {
    const article = artikelstamm.artikel.find(a => a.material === material);
    if (!article) return;
    articleDetailMaterial = material;
    articleDetailPlpRows = (article.plp || []).map(r => ({ ...r }));
    document.getElementById('articleDetailTitle').textContent = `${material} · ${article.bezeichnung || ''}`;
    document.getElementById('articleDetailNote').textContent = '';
    document.getElementById('articleDetailExportNote').textContent = '';
    renderArticleDetailDatei('zeichnung', article.zeichnung);
    // Einstelldatenblatt (Spritzguss-Einstellparameter) ergibt nur bei Formgebung Sinn.
    document.getElementById('articleDetailEinstelldatenblattSection').classList.toggle('hidden', article.dbType !== 'Elastomer');
    renderArticleDetailDatei('einstelldatenblatt', article.einstelldatenblatt);
    renderArticleDetailPlp();
    document.getElementById('articleDetailZeichnungFile').value = '';
    document.getElementById('articleDetailEinstelldatenblattFile').value = '';
    document.getElementById('articleDetailModal').classList.remove('hidden');
}

function closeArticleDetailModal() {
    document.getElementById('articleDetailModal').classList.add('hidden');
    articleDetailMaterial = null;
}

const ARTIKEL_DATEI_LABEL = { zeichnung: 'Zeichnung', einstelldatenblatt: 'Einstelldatenblatt' };

// Base64 -> Blob statt data:-URI: Safari bricht bei größeren Dateien (z.B.
// gescannte Zeichnungen als PDF) das Öffnen einer data:-URI in einem neuen Tab
// oft einfach ab, während Chrome damit keine Probleme hat. Object-URLs
// funktionieren unabhängig von der Dateigröße in jedem Browser zuverlässig.
function base64ToObjectUrl(base64, mimeType) {
    const byteChars = atob(base64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

// Eine Object-URL je Feld merken und vor dem nächsten Rendern freigeben.
const aktiveArtikelDateiUrls = {};

// Zeichnung und Einstelldatenblatt sind strukturell dieselbe Datei-Ablage -
// eine gemeinsame Anzeige-/Upload-/Löschlogik statt zweier fast identischer.
function renderArticleDetailDatei(feld, datei) {
    const box = document.getElementById(`articleDetail${feld[0].toUpperCase()}${feld.slice(1)}Current`);
    if (aktiveArtikelDateiUrls[feld]) {
        URL.revokeObjectURL(aktiveArtikelDateiUrls[feld]);
        delete aktiveArtikelDateiUrls[feld];
    }
    if (!datei) {
        box.innerHTML = `<div class="zeichnung-current">Kein${feld === 'zeichnung' ? 'e' : ''} ${ARTIKEL_DATEI_LABEL[feld]} hinterlegt.</div>`;
        return;
    }
    const url = base64ToObjectUrl(datei.data, datei.mimeType);
    aktiveArtikelDateiUrls[feld] = url;
    box.innerHTML = `
        <div class="zeichnung-current">
            <span>📄 ${escapeHtml(datei.filename)} (${new Date(datei.uploadedAt).toLocaleDateString('de-DE')})</span>
            <a href="${url}" target="_blank" rel="noopener">öffnen</a>
            <button data-datei-feld="${feld}" class="artikel-datei-remove-btn" style="font-size: 11px; padding: 4px 8px; border: 1px solid #fecaca; border-radius: 4px; background: #fef2f2; color: #b91c1c; cursor: pointer;">entfernen</button>
        </div>
    `;
    box.querySelector('.artikel-datei-remove-btn')?.addEventListener('click', () => removeArticleDetailDatei(feld));
}

async function removeArticleDetailDatei(feld) {
    if (!articleDetailMaterial) return;
    try {
        const res = await fetch(`${API_URL}/artikelstamm/materialien/${encodeURIComponent(articleDetailMaterial)}/${feld}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const idx = artikelstamm.artikel.findIndex(a => a.material === articleDetailMaterial);
        if (idx !== -1) artikelstamm.artikel[idx] = data;
        renderArticleDetailDatei(feld, null);
        renderDatabaseTable();
    } catch (err) {
        document.getElementById('articleDetailNote').textContent = 'Entfernen fehlgeschlagen.';
    }
}

// Maßprüfungs-Felder (Sollwert/Toleranz/Einheit) sind bei Prozessschritten
// ausgeblendet, statt leere Zellen anzuzeigen, die dort nichts bedeuten.
function renderArticleDetailPlp() {
    const tbody = document.getElementById('articleDetailPlpTable');
    tbody.innerHTML = '';
    articleDetailPlpRows.forEach((row, idx) => {
        const tr = document.createElement('tr');
        const istMass = row.typ === 'masspruefung';

        const typTd = document.createElement('td');
        const typSelect = document.createElement('select');
        typSelect.className = 'table-input';
        [['prozess', 'Prozessschritt'], ['masspruefung', 'Maßprüfung']].forEach(([val, label]) => {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = label;
            if (row.typ === val) opt.selected = true;
            typSelect.appendChild(opt);
        });
        typSelect.addEventListener('change', () => {
            articleDetailPlpRows[idx].typ = typSelect.value;
            renderArticleDetailPlp();
        });
        typTd.appendChild(typSelect);
        tr.appendChild(typTd);

        const bezTd = document.createElement('td');
        const bezInput = document.createElement('input');
        bezInput.className = 'table-input';
        bezInput.placeholder = istMass ? 'z.B. Außendurchmesser' : 'z.B. Entgraten';
        bezInput.value = row.bezeichnung || '';
        bezInput.addEventListener('input', () => { articleDetailPlpRows[idx].bezeichnung = bezInput.value; });
        bezTd.appendChild(bezInput);
        tr.appendChild(bezTd);

        ['sollwert', 'toleranzMin', 'toleranzMax'].forEach(key => {
            const td = document.createElement('td');
            if (istMass) {
                const input = document.createElement('input');
                input.className = 'table-input';
                input.type = 'number';
                input.step = 'any';
                input.value = row[key] ?? '';
                input.addEventListener('input', () => {
                    articleDetailPlpRows[idx][key] = input.value === '' ? undefined : Number(input.value);
                });
                td.appendChild(input);
            } else {
                td.textContent = '–';
                td.style.color = '#cbd5e1';
            }
            tr.appendChild(td);
        });

        const einheitTd = document.createElement('td');
        if (istMass) {
            const input = document.createElement('input');
            input.className = 'table-input';
            input.placeholder = 'mm';
            input.value = row.einheit || '';
            input.addEventListener('input', () => { articleDetailPlpRows[idx].einheit = input.value; });
            einheitTd.appendChild(input);
        } else {
            einheitTd.textContent = '–';
            einheitTd.style.color = '#cbd5e1';
        }
        tr.appendChild(einheitTd);

        ['pruefmittel', 'pruefhaeufigkeit'].forEach(key => {
            const td = document.createElement('td');
            if (istMass) {
                const input = document.createElement('input');
                input.className = 'table-input';
                input.value = row[key] || '';
                input.addEventListener('input', () => { articleDetailPlpRows[idx][key] = input.value; });
                td.appendChild(input);
            } else {
                td.textContent = '–';
                td.style.color = '#cbd5e1';
            }
            tr.appendChild(td);
        });

        const actionTd = document.createElement('td');
        actionTd.style.whiteSpace = 'nowrap';

        // Die Reihenfolge hier ist die Reihenfolge auf dem Prozessbegleitschein/
        // der Fehlersammelkarte - per ▲▼ statt Drag&Drop umsortierbar, da die
        // Tabelle ohnehin schon breit ist.
        const upBtn = document.createElement('button');
        upBtn.textContent = '▲';
        upBtn.title = 'Nach oben';
        upBtn.disabled = idx === 0;
        upBtn.style.cssText = 'font-size: 11px; padding: 5px 7px; border: 1px solid #e2e8f0; border-radius: 4px; background: #f8fafc; cursor: pointer; margin-right: 4px;';
        upBtn.addEventListener('click', () => {
            [articleDetailPlpRows[idx - 1], articleDetailPlpRows[idx]] = [articleDetailPlpRows[idx], articleDetailPlpRows[idx - 1]];
            renderArticleDetailPlp();
        });

        const downBtn = document.createElement('button');
        downBtn.textContent = '▼';
        downBtn.title = 'Nach unten';
        downBtn.disabled = idx === articleDetailPlpRows.length - 1;
        downBtn.style.cssText = 'font-size: 11px; padding: 5px 7px; border: 1px solid #e2e8f0; border-radius: 4px; background: #f8fafc; cursor: pointer; margin-right: 4px;';
        downBtn.addEventListener('click', () => {
            [articleDetailPlpRows[idx + 1], articleDetailPlpRows[idx]] = [articleDetailPlpRows[idx], articleDetailPlpRows[idx + 1]];
            renderArticleDetailPlp();
        });

        const delBtn = document.createElement('button');
        delBtn.textContent = '🗑';
        delBtn.style.cssText = 'font-size: 11px; padding: 5px 8px; border: 1px solid #fecaca; border-radius: 4px; background: #fef2f2; color: #b91c1c; cursor: pointer;';
        delBtn.addEventListener('click', () => {
            articleDetailPlpRows.splice(idx, 1);
            renderArticleDetailPlp();
        });
        actionTd.appendChild(upBtn);
        actionTd.appendChild(downBtn);
        actionTd.appendChild(delBtn);
        tr.appendChild(actionTd);
        tbody.appendChild(tr);
    });
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

document.getElementById('articleDetailAddProzessBtn')?.addEventListener('click', () => {
    articleDetailPlpRows.push({ typ: 'prozess', bezeichnung: '' });
    renderArticleDetailPlp();
});

document.getElementById('articleDetailAddMassBtn')?.addEventListener('click', () => {
    articleDetailPlpRows.push({ typ: 'masspruefung', bezeichnung: '', sollwert: undefined, toleranzMin: undefined, toleranzMax: undefined, einheit: '', pruefmittel: '', pruefhaeufigkeit: '' });
    renderArticleDetailPlp();
});

document.getElementById('articleDetailCloseBtn')?.addEventListener('click', closeArticleDetailModal);

async function uploadArticleDetailDatei(feld, file) {
    if (!file || !articleDetailMaterial) return;
    const note = document.getElementById('articleDetailNote');
    try {
        const base64 = await fileToBase64(file);
        const res = await fetch(`${API_URL}/artikelstamm/materialien/${encodeURIComponent(articleDetailMaterial)}/${feld}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/octet-stream', data: base64 }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const idx = artikelstamm.artikel.findIndex(a => a.material === articleDetailMaterial);
        if (idx !== -1) artikelstamm.artikel[idx] = data;
        renderArticleDetailDatei(feld, data[feld]);
        renderDatabaseTable();
        note.style.color = '#15803d';
        note.textContent = `✅ ${ARTIKEL_DATEI_LABEL[feld]} hochgeladen.`;
    } catch (err) {
        note.style.color = '#b91c1c';
        note.textContent = 'Upload fehlgeschlagen.';
    }
}

document.getElementById('articleDetailZeichnungFile')?.addEventListener('change', (e) => uploadArticleDetailDatei('zeichnung', e.target.files[0]));
document.getElementById('articleDetailEinstelldatenblattFile')?.addEventListener('change', (e) => uploadArticleDetailDatei('einstelldatenblatt', e.target.files[0]));

document.getElementById('articleDetailSaveBtn')?.addEventListener('click', async () => {
    if (!articleDetailMaterial) return;
    const note = document.getElementById('articleDetailNote');
    try {
        const res = await fetch(`${API_URL}/artikelstamm/materialien/${encodeURIComponent(articleDetailMaterial)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ plp: articleDetailPlpRows.filter(r => (r.bezeichnung || '').trim()) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const idx = artikelstamm.artikel.findIndex(a => a.material === articleDetailMaterial);
        if (idx !== -1) artikelstamm.artikel[idx] = data;
        renderDatabaseTable();
        note.style.color = '#15803d';
        note.textContent = '✅ Gespeichert.';
    } catch (err) {
        note.style.color = '#b91c1c';
        note.textContent = 'Speichern fehlgeschlagen.';
    }
});

document.getElementById('articleDetailArtikelmappeBtn')?.addEventListener('click', async () => {
    if (!articleDetailMaterial) return;
    const note = document.getElementById('articleDetailExportNote');
    const article = artikelstamm.artikel.find(a => a.material === articleDetailMaterial);
    if (!article) return;
    note.style.color = '#64748b';
    note.textContent = 'Erzeuge PDF...';
    try {
        await exportArtikelmappe(article);
        note.style.color = '#15803d';
        note.textContent = '✅ Artikelmappe heruntergeladen.';
    } catch (err) {
        note.style.color = '#b91c1c';
        note.textContent = 'Export fehlgeschlagen.';
    }
});

document.getElementById('articleDetailFskHistorieBtn')?.addEventListener('click', async () => {
    if (!articleDetailMaterial) return;
    const note = document.getElementById('articleDetailExportNote');
    const article = artikelstamm.artikel.find(a => a.material === articleDetailMaterial);
    note.style.color = '#64748b';
    note.textContent = 'Lade Auftragshistorie...';
    try {
        const res = await fetch(`${API_URL}/orders?artikelnummer=${encodeURIComponent(articleDetailMaterial)}`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        const auftraege = await res.json();
        if (!res.ok) throw new Error(auftraege.error);
        exportFskHistorie(articleDetailMaterial, article?.bezeichnung || '', auftraege);
        note.style.color = '#15803d';
        note.textContent = `✅ Excel heruntergeladen (${auftraege.length} Auftrag${auftraege.length === 1 ? '' : 'e'}).`;
    } catch (err) {
        note.style.color = '#b91c1c';
        note.textContent = 'Export fehlgeschlagen.';
    }
});

// --- Werker-Konten (eigener Login für /shopfloor, getrennt von den Büro-Konten) ---

async function fetchWerker() {
    if (currentUser?.role !== 'admin') return;
    try {
        const res = await fetch(`${API_URL}/shopfloor/users`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) return;
        renderWerkerTable(await res.json());
    } catch (err) { /* Werkerliste konnte nicht geladen werden */ }
}

function renderWerkerTable(werker) {
    const tbody = document.getElementById('werkerTable');
    if (!tbody) return;
    tbody.innerHTML = '';
    werker.forEach(w => {
        const tr = document.createElement('tr');
        [w.kuerzel, w.name, '••••'].forEach(val => {
            const td = document.createElement('td');
            td.textContent = val;
            tr.appendChild(td);
        });
        const actionsTd = document.createElement('td');
        actionsTd.className = 'table-actions';
        const delBtn = document.createElement('button');
        delBtn.className = 'danger';
        delBtn.textContent = '🗑';
        delBtn.title = 'Löschen';
        delBtn.addEventListener('click', () => deleteWerker(w._id));
        actionsTd.appendChild(delBtn);
        tr.appendChild(actionsTd);
        tbody.appendChild(tr);
    });
}

async function addWerker() {
    const note = document.getElementById('werkerNote');
    const kuerzel = document.getElementById('werkerNewKuerzel').value.trim();
    const name = document.getElementById('werkerNewName').value.trim();
    const pin = document.getElementById('werkerNewPin').value.trim();
    note.style.color = '#b91c1c';
    if (!kuerzel || !name || !pin) {
        note.textContent = 'Kürzel, Name und PIN sind erforderlich.';
        return;
    }
    try {
        const res = await fetch(`${API_URL}/shopfloor/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ kuerzel, name, pin }),
        });
        const data = await res.json();
        if (!res.ok) { note.textContent = data.error || 'Anlegen fehlgeschlagen.'; return; }
        note.style.color = '#15803d';
        note.textContent = `✅ ${data.kuerzel} angelegt.`;
        ['werkerNewKuerzel', 'werkerNewName', 'werkerNewPin'].forEach(id => { document.getElementById(id).value = ''; });
        fetchWerker();
    } catch (err) {
        note.textContent = 'Anlegen fehlgeschlagen.';
    }
}

async function deleteWerker(id) {
    try {
        await fetch(`${API_URL}/shopfloor/users/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        fetchWerker();
    } catch (err) { /* ignore */ }
}

document.getElementById('werkerAddBtn')?.addEventListener('click', addWerker);
document.getElementById('openShopfloorBtn')?.addEventListener('click', () => window.open('/shopfloor', '_blank'));

const MASCHINEN = [
    { id: 'MG1', name: 'Maplan Gummi 1', kapMin: 480, type: 'Elastomer', subtyp: 'Gummi' },
    { id: 'MG2', name: 'Maplan Gummi 2', kapMin: 480, type: 'Elastomer', subtyp: 'Gummi' },
    { id: 'MS1', name: 'Maplan Silikon 1', kapMin: 480, type: 'Elastomer', subtyp: 'Silikon' },
    { id: 'MS2', name: 'Maplan Silikon 2', kapMin: 480, type: 'Elastomer', subtyp: 'Silikon' },
    { id: 'DoLa', name: 'DoLa', kapMin: 480, type: 'PTFE', subtyp: 'DoLa' },
    { id: 'DoRev', name: 'DoRev', kapMin: 480, type: 'PTFE', subtyp: 'DoRev' },
    { id: 'DoRevLa', name: 'DoRevLa', kapMin: 480, type: 'PTFE', subtyp: 'DoRevLa' },
    { id: 'Portalfraese', name: 'Portalfräse', kapMin: 480, type: 'PTFE', subtyp: 'Portalfräse' },
    { id: 'SpinnerAlterLader', name: 'Spinner alter Lader', kapMin: 480, type: 'PTFE', subtyp: 'Spinner alter Lader' },
    { id: 'SpinnerFST', name: 'Spinner FST', kapMin: 480, type: 'PTFE', subtyp: 'Spinner FST' },
    { id: 'SpinnerNeuerLader', name: 'Spinner neuer Lader', kapMin: 480, type: 'PTFE', subtyp: 'Spinner neuer Lader' },
    { id: 'SpinnerRev', name: 'Spinner Rev', kapMin: 480, type: 'PTFE', subtyp: 'Spinner Rev' },
    { id: 'Laser', name: 'Laser', kapMin: 480, type: 'PTFE', subtyp: 'Laser' },
    { id: 'Manuell', name: 'Manuell', kapMin: 480, type: 'PTFE', subtyp: 'manuell' },
];

// Bei PTFE muss der Artikel exakt der/den in der Datenbank hinterlegten Maschine(n)
// zugeordnet werden. Manche Artikel brauchen selten zwei Maschinen gleichzeitig,
// z.B. "DoLa + DoRev" (auch "/" oder "&" als Trennzeichen). Alles, was nicht eindeutig
// einer oder zwei der Maschinen entspricht, bleibt zur manuellen Prüfung unzugewiesen.
// Die Zuordnung ist nur eine Empfehlung - manuelles Verschieben ist immer möglich.
function classifyPtfeMaschinen(maschine) {
    const teile = (maschine || '').split(/[+&/]/).map(s => s.trim()).filter(Boolean);
    if (teile.length === 0 || teile.length > 2) return [];
    const aufgeloest = teile.map(t => {
        const treffer = MASCHINEN.find(x => x.type === 'PTFE' && x.subtyp.toLowerCase() === t.toLowerCase());
        return treffer ? treffer.subtyp : null;
    });
    if (aufgeloest.some(x => x === null)) return [];
    return [...new Set(aufgeloest)];
}

// Nur eindeutig als Gummi/Silikon markierte Artikel werden automatisch verplant,
// unklare (leer oder nur "Maplan" ohne Zusatz) bleiben unzugewiesen zur manuellen Prüfung.
// Die Zuordnung ist nur eine Empfehlung - manuelles Verschieben ist immer möglich.
function classifyElastomerSubtyp(maschine) {
    const m = (maschine || '').toLowerCase();
    if (m.includes('silikon')) return 'Silikon';
    if (m.includes('gummi')) return 'Gummi';
    return null;
}

// Wir planen nur Mo-Fr, 1 Schicht pro Tag.
function isWeekday(date) {
    const day = date.getDay();
    return day !== 0 && day !== 6;
}

function nextWeekday(date) {
    const d = new Date(date);
    while (!isWeekday(d)) d.setDate(d.getDate() + 1);
    return d;
}

function addWorkdays(date, days) {
    const d = new Date(date);
    let added = 0;
    while (added < days) {
        d.setDate(d.getDate() + 1);
        if (isWeekday(d)) added++;
    }
    return d;
}

function formatDateShort(date) {
    if (!date) return '';
    const d = new Date(date);
    const tage = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${tage[d.getDay()]} ${dd}.${mm}.`;
}

function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfWeek(date) {
    const d = new Date(date);
    const day = d.getDay();
    d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
    d.setHours(0, 0, 0, 0);
    return d;
}

function endOfWeek(date) {
    const d = startOfWeek(date);
    d.setDate(d.getDate() + 4);
    return d;
}

function getISOWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function formatLieferwoche(lieferdatum) {
    if (!lieferdatum) return null;
    return `KW ${getISOWeek(new Date(lieferdatum))}`;
}

function parseExcelDatum(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'number') {
        return new Date(Math.round((value - 25569) * 86400 * 1000));
    }
    const str = value.toString().trim();
    const m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
    if (m) {
        const [, d, mo, y] = m;
        const year = y.length === 2 ? '20' + y : y;
        return new Date(`${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`);
    }
    const parsed = new Date(str);
    return isNaN(parsed) ? null : parsed;
}

let boardOrders = [];
let draggedOrderId = null;
let draggedOrderFeld = null;
let isDragging = false;
let boardPollTimer = null;

function planMachines(orders) {
    // Bestehende, bereits eingeplante Aufträge bleiben erhalten (siehe
    // saveOrdersToBackend) - die neue Charge wird deshalb hinter deren
    // tatsächlichem Ende eingereiht, statt jede Maschine ab "heute" neu zu
    // verplanen (das würde bestehende Belegungen überbuchen/überschreiben).
    const naechsterFreierTag = {};
    MASCHINEN.forEach(m => naechsterFreierTag[m.id] = getMachineNextFree(m.id));

    const columns = Object.keys(orders[0] || {});
    const artikelCol = findColumn(columns, 'artikel');
    const auftragsCol = findColumn(columns, 'auftrag');
    const mengeCol = findColumn(columns, 'menge');
    const bestellCol = findColumn(columns, 'bestellnummer');
    const lieferdatumCol = findColumn(columns, 'lieferdatum');

    const parsed = orders.map(o => {
        const artikelNr = (o[artikelCol] || '').toString().replace('#', '').trim();
        const artikel = findArtikel(artikelNr);
        const dbType = artikel?.dbType || 'Elastomer';

        const komponenten = (artikel?.komponenten || []).map(k => ({
            artikelnummer: k.artikelnummer,
            bezeichnung: k.bezeichnung,
            wareneingang: null,
        }));
        // Alle Maplan-Maschinen (Gummi/Silikon) brauchen zusätzlich das Werkzeug -
        // das steht nicht in der Stückliste, gilt aber für jeden Formgebungs-Artikel.
        if (dbType === 'Elastomer') {
            komponenten.push({ artikelnummer: '', bezeichnung: 'Werkzeug', wareneingang: null });
        }

        return {
            auftragsnummer: (o[auftragsCol] || '').toString().trim(),
            bestellnummer: (o[bestellCol] || '').toString().trim(),
            lieferdatum: parseExcelDatum(o[lieferdatumCol]),
            artikelnummer: artikelNr,
            beschreibung: artikel?.bezeichnung || '',
            komponenten,
            menge: parseMenge(o[mengeCol]),
            dbType,
            maschinenNamen: dbType === 'Elastomer'
                ? (classifyElastomerSubtyp(artikel?.maschine) ? [classifyElastomerSubtyp(artikel?.maschine)] : [])
                : classifyPtfeMaschinen(artikel?.maschine),
            kavitaet: artikel?.kavitaet || 1,
            rundenProSchicht: artikel?.rundenProSchicht || 1,
            zeitProHundert: artikel?.zeitProHundert || 0,
        };
    });

    // Aufträge mit früherem Liefertermin zuerst einplanen (dringendere zuerst) -
    // wer keinen Liefertermin hat, kommt ans Ende.
    parsed.sort((a, b) => {
        if (!a.lieferdatum && !b.lieferdatum) return 0;
        if (!a.lieferdatum) return 1;
        if (!b.lieferdatum) return -1;
        return new Date(a.lieferdatum) - new Date(b.lieferdatum);
    });

    const computed = parsed.map(o => {
        // PTFE-Artikel werden über eine feste Zeit pro 100 Stück kalkuliert,
        // Elastomer-Artikel über Kavitätenzahl und Runden pro Schicht.
        const bearbeitungsMin = o.dbType === 'PTFE'
            ? (o.menge / 100) * o.zeitProHundert
            : Math.ceil(o.menge / o.kavitaet) * (480 / o.rundenProSchicht);
        const schichten = Math.ceil(bearbeitungsMin / 480);
        // Wir planen nur 1 Schicht/Tag - auch ein Auftrag unter 1 Schicht belegt einen ganzen Tag.
        const tage = Math.max(1, schichten);

        let zugewiesen = null;
        let zugewiesen2 = null;
        let startDatum = null;
        let endDatum = null;

        // Ohne eindeutig erkannte Maschine(n) (Gummi/Silikon bei Elastomer, exakte
        // CNC-Maschine(n) bei PTFE) nicht automatisch verplanen, sondern zur manuellen
        // Prüfung liegen lassen. Die Zuordnung ist ohnehin nur eine Empfehlung.
        const braucht_manuelle_pruefung = o.maschinenNamen.length === 0;

        if (!braucht_manuelle_pruefung && o.maschinenNamen.length === 1) {
            // Lastverteilung: von den passenden Maschinen die nehmen, die am frühesten frei ist.
            const kandidaten = MASCHINEN.filter(m => m.type === o.dbType && m.subtyp === o.maschinenNamen[0]);
            const ziel = kandidaten.reduce((best, m) =>
                !best || naechsterFreierTag[m.id] < naechsterFreierTag[best.id] ? m : best, null);

            if (ziel) {
                zugewiesen = ziel.id;
                startDatum = new Date(naechsterFreierTag[ziel.id]);
                endDatum = addWorkdays(startDatum, tage - 1);
                naechsterFreierTag[ziel.id] = addWorkdays(endDatum, 1);
            }
        } else if (!braucht_manuelle_pruefung && o.maschinenNamen.length === 2) {
            // Selten: Artikel muss zwei bestimmte Maschinen gleichzeitig belegen.
            const m1 = MASCHINEN.find(m => m.type === o.dbType && m.subtyp === o.maschinenNamen[0]);
            const m2 = MASCHINEN.find(m => m.type === o.dbType && m.subtyp === o.maschinenNamen[1]);
            if (m1 && m2) {
                const fruehester = naechsterFreierTag[m1.id] > naechsterFreierTag[m2.id]
                    ? naechsterFreierTag[m1.id] : naechsterFreierTag[m2.id];
                startDatum = new Date(fruehester);
                endDatum = addWorkdays(startDatum, tage - 1);
                const frei = addWorkdays(endDatum, 1);
                naechsterFreierTag[m1.id] = frei;
                naechsterFreierTag[m2.id] = frei;
                zugewiesen = m1.id;
                zugewiesen2 = m2.id;
            }
        }

        return {
            ...o,
            maschineId: zugewiesen,
            maschineId2: zugewiesen2,
            startDatum,
            endDatum,
            bearbeitungsMin,
            schichten,
            status: zugewiesen ? 'geplant' : braucht_manuelle_pruefung ? 'ausstehend' : 'ueberlastet',
        };
    });

    saveOrdersToBackend(computed);
}

async function saveOrdersToBackend(orders) {
    // Fügt die neu hochgeladenen Aufträge zur bestehenden Planung hinzu, statt sie zu
    // ersetzen - bereits vorhandene Aufträge (jede Phase) bleiben unangetastet. Danach
    // den kompletten (geteilten) Bestand neu laden, nicht nur die Antwort, sonst würden
    // diese Aufträge lokal aus boardOrders verschwinden.
    const res = await fetch(`${API_URL}/orders`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ orders }),
    });
    const data = await res.json();
    await fetchBoard();
    startBoardPolling();

    document.getElementById('plannerDoneNote').classList.remove('hidden');
    const hint = document.getElementById('plannerDoneHint');
    if (hint) {
        hint.textContent = data.uebersprungen > 0
            ? `ℹ️ ${data.uebersprungen} Auftrag${data.uebersprungen === 1 ? '' : 'e'} übersprungen - bereits vorhanden.`
            : '';
    }
}

// Während ein Datums- oder Chargen-Feld (Wareneingang/Warenausgang/Charge)
// fokussiert ist, nicht neu rendern - das würde den Input ersetzen und dabei
// einen offenen Kalender-Picker vorzeitig schließen bzw. unfertige Eingaben
// in der Chargennummer verwerfen.
function isEditingDateInput() {
    const el = document.activeElement;
    if (!el) return false;
    if (el.tagName === 'INPUT') return el.type === 'date' || el.classList.contains('komp-charge');
    return el.tagName === 'TEXTAREA' && el.classList.contains('kanban-card-kommentar');
}

async function fetchBoard() {
    try {
        const res = await fetch(`${API_URL}/orders`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) return;
        boardOrders = await res.json();
        if (!isDragging && !isEditingDateInput()) renderAll();
    } catch (err) {
        // Poll-Fehler ignorieren, nächster Versuch folgt
    }
}

function startBoardPolling() {
    if (boardPollTimer) return;
    boardPollTimer = setInterval(fetchBoard, 6000);
}

// Baut den Kern einer Auftragskarte (Titel, Beschreibung, Bestellung, Zeitraum,
// Komponenten-Checkliste, Meta) - wird auf allen drei Seiten wiederverwendet.
function buildCardElement(order, { spalte = null } = {}) {
    const card = document.createElement('div');
    card.className = `kanban-card card-${order.status}`;
    card.dataset.orderId = order._id;

    const badge = order.status === 'geplant' ? '✅' : order.status === 'ueberlastet' ? '⚠️' : '⏳';
    const desc = order.beschreibung ? `<div class="kanban-card-desc">${escapeHtml(order.beschreibung)}</div>` : '';

    const bestellTeile = [];
    if (order.bestellnummer) bestellTeile.push(`Bestellung ${escapeHtml(order.bestellnummer)}`);
    if (order.lieferdatum) bestellTeile.push(`Liefertermin ${formatDateShort(order.lieferdatum)}`);
    const bestellung = bestellTeile.length ? `<div class="kanban-card-bestellung">🧾 ${bestellTeile.join(' · ')}</div>` : '';

    let parallel = '';
    if (spalte && order.maschineId2) {
        const parallelId = spalte.id === order.maschineId ? order.maschineId2 : order.maschineId;
        if (parallelId) {
            parallel = `<div class="kanban-card-parallel">🔗 gleichzeitig mit ${escapeHtml(MASCHINEN.find(m => m.id === parallelId)?.name || parallelId)}</div>`;
        }
    }

    let komponentenHtml = '';
    if (order.komponenten && order.komponenten.length > 0) {
        const komplett = order.komponenten.every(k => k.wareneingang);
        const zeilen = order.komponenten.map((k, idx) => {
            const icon = k.wareneingang ? '✅' : '⭕';
            const label = k.artikelnummer ? `${k.artikelnummer} - ${k.bezeichnung}` : k.bezeichnung;
            // Safari zeigt bei <input type="date"> anders als Chrome kein natives
            // "x" zum Löschen an - deshalb einen eigenen Löschen-Button, der in
            // jedem Browser gleich funktioniert.
            const clearBtn = k.wareneingang ? `<button type="button" class="komp-date-clear" data-komp-index="${idx}" title="Wareneingang löschen">✕</button>` : '';
            // Das Werkzeug ist keine Rohmaterial-Komponente eines Lieferanten -
            // dafür gibt es keine Charge.
            const chargeInput = k.bezeichnung === 'Werkzeug' ? '' : `<input type="text" class="komp-charge" data-komp-index="${idx}" placeholder="Charge (Rückverfolgbarkeit)" value="${escapeHtml(k.charge || '')}">`;
            return `<div class="komponente-zeile-gruppe">
                <div class="komponente-zeile"><span>${icon} ${escapeHtml(label)}</span><input type="date" class="komp-date" data-komp-index="${idx}" value="${toDateInputValue(k.wareneingang)}">${clearBtn}</div>
                ${chargeInput}
            </div>`;
        }).join('');
        // Automatischer Hinweis, welche Komponenten fehlen - auf einen Blick statt
        // jede Zeile einzeln nach dem ⭕-Symbol absuchen zu müssen.
        const fehltHinweis = komplett ? '' : `<div class="kanban-card-fehlt">⚠ Fehlt: ${escapeHtml(fehlendeKomponentenText(order))}</div>`;
        komponentenHtml = `<div class="kanban-card-komponenten ${komplett ? 'komplett' : ''}">${fehltHinweis}${zeilen}</div>`;
    }

    const kommentarHtml = `<textarea class="kanban-card-kommentar" placeholder="Kommentar...">${escapeHtml(order.kommentar || '')}</textarea>`;

    card.innerHTML = `<div class="kanban-card-title">${badge} ${escapeHtml(order.artikelnummer)}</div>${desc}${bestellung}${parallel}${komponentenHtml}<div class="kanban-card-meta">Auftrag ${escapeHtml(order.auftragsnummer)} · ${order.menge} Stk · ${(order.bearbeitungsMin / 60).toFixed(1)}h · ${order.schichten} Sch.</div>${kommentarHtml}`;

    card.querySelectorAll('.komp-date').forEach(input => {
        input.draggable = false;
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('change', (e) => {
            e.stopPropagation();
            setKomponenteDatum(order._id, parseInt(input.dataset.kompIndex), input.value);
        });
    });

    card.querySelectorAll('.komp-date-clear').forEach(btn => {
        btn.draggable = false;
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            setKomponenteDatum(order._id, parseInt(btn.dataset.kompIndex), '');
        });
    });

    card.querySelectorAll('.komp-charge').forEach(input => {
        input.draggable = false;
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('change', (e) => {
            e.stopPropagation();
            setKomponenteCharge(order._id, parseInt(input.dataset.kompIndex), input.value);
        });
    });

    const kommentarInput = card.querySelector('.kanban-card-kommentar');
    if (kommentarInput) {
        kommentarInput.draggable = false;
        kommentarInput.addEventListener('mousedown', (e) => e.stopPropagation());
        kommentarInput.addEventListener('click', (e) => e.stopPropagation());
        kommentarInput.addEventListener('change', (e) => {
            e.stopPropagation();
            setKommentar(order._id, kommentarInput.value);
        });
    }

    return card;
}

function addCardAction(card, label, onClick, variant = '') {
    const actions = document.createElement('div');
    actions.className = 'kanban-card-actions';
    const btn = document.createElement('button');
    if (variant) btn.className = variant;
    btn.textContent = label;
    btn.draggable = false;
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
    });
    actions.appendChild(btn);
    card.appendChild(actions);
}

// Native confirm()-Dialoge werden in manchen Browsern/Kontexten stillschweigend
// unterdrückt (der Klick scheint dann wirkungslos). Deshalb Bestätigung direkt im
// Button: erster Klick fragt nach, zweiter Klick innerhalb von 4s löscht wirklich.
function addDeleteAction(card, orderId) {
    const actions = document.createElement('div');
    actions.className = 'kanban-card-actions';
    const btn = document.createElement('button');
    btn.className = 'danger';
    btn.textContent = '🗑 Löschen';
    btn.draggable = false;
    btn.addEventListener('mousedown', (e) => e.stopPropagation());

    let confirming = false;
    let resetTimer = null;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirming) {
            confirming = true;
            btn.textContent = 'Sicher? Nochmal klicken';
            resetTimer = setTimeout(() => {
                confirming = false;
                btn.textContent = '🗑 Löschen';
            }, 4000);
        } else {
            clearTimeout(resetTimer);
            deleteOrder(orderId);
        }
    });

    actions.appendChild(btn);
    card.appendChild(actions);
}

function renderAll() {
    renderBoard('Elastomer');
    renderBoard('PTFE');
    renderEndbearbeitung('Elastomer');
    renderEndbearbeitung('PTFE');
    renderAusgeliefert('Elastomer');
    renderAusgeliefert('PTFE');
}

// Kommagetrennte Liste der noch fehlenden Komponenten eines Auftrags - sowohl
// für die Tabelle "Fehlende Komponenten" als auch für den automatischen
// Hinweis direkt auf der Kanban-Karte.
function fehlendeKomponentenText(order) {
    return (order.komponenten || [])
        .filter(k => !k.wareneingang)
        .map(k => k.artikelnummer ? `${k.artikelnummer} - ${k.bezeichnung}` : k.bezeichnung)
        .join(', ');
}

// Auswertung, bei welchen Aufträgen in Produktion noch Komponenten fehlen -
// genau die, die deshalb (noch) nicht im Zeitplan auftauchen (siehe
// istKomponentenBereit-Filter dort).
function renderFehlendeKomponenten(produktionOrders, suffix) {
    const tbody = document.getElementById('fehlendeKomponenten' + suffix);
    if (!tbody) return;

    const offene = produktionOrders
        .filter(o => !istKomponentenBereit(o))
        .sort((a, b) => {
            if (!a.lieferdatum && !b.lieferdatum) return 0;
            if (!a.lieferdatum) return 1;
            if (!b.lieferdatum) return -1;
            return new Date(a.lieferdatum) - new Date(b.lieferdatum);
        });

    tbody.innerHTML = '';
    if (offene.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="color: #64748b;">Alle Aufträge in Produktion sind produzierbar.</td></tr>';
        return;
    }

    offene.forEach(order => {
        const tr = document.createElement('tr');
        [order.artikelnummer, order.auftragsnummer, order.beschreibung, fehlendeKomponentenText(order), order.lieferdatum ? formatDateShort(order.lieferdatum) : ''].forEach(val => {
            const td = document.createElement('td');
            td.textContent = val;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
}

// Ein-/Ausklappen der "Fehlende Komponenten"-Karte, Zustand bleibt über
// localStorage auch nach einem Neuladen erhalten.
function initFehlendeKomponentenToggle() {
    document.querySelectorAll('.fehlende-komponenten-toggle').forEach(btn => {
        const suffix = btn.dataset.suffix;
        const box = document.getElementById('fehlendeKomponentenBox' + suffix);
        if (!box) return;
        const key = `fehlendeKomponentenEingeklappt${suffix}`;
        if (localStorage.getItem(key) === '1') box.classList.add('hidden');
        btn.addEventListener('click', () => {
            const eingeklappt = box.classList.toggle('hidden');
            localStorage.setItem(key, eingeklappt ? '1' : '0');
        });
    });
}

function renderBoard(dbType) {
    const suffix = DBTYPE_SUFFIX[dbType];
    const maschinenListe = MASCHINEN.filter(m => m.type === dbType);
    const produktionOrders = boardOrders.filter(o => (!o.phase || o.phase === 'produktion') && o.dbType === dbType);

    renderFehlendeKomponenten(produktionOrders, suffix);

    if (produktionOrders.length === 0) {
        document.getElementById('machineGrid' + suffix).innerHTML = '';
        document.getElementById('kanbanBoard' + suffix).innerHTML = '<p style="color: #64748b;">Noch keine Aufträge geplant. Lade im Auftragsimport eine Aufträge-Excel hoch.</p>';
        updateKanbanScrollbarWidth(suffix);
        renderGantt([], dbType);
        return;
    }

    renderGantt(produktionOrders, dbType);

    const machineGrid = document.getElementById('machineGrid' + suffix);
    machineGrid.innerHTML = '';
    maschinenListe.forEach(m => {
        const cards = produktionOrders.filter(o => o.maschineId === m.id || o.maschineId2 === m.id);
        let freiAb = nextWeekday(new Date());
        cards.forEach(o => {
            if (!o.endDatum) return;
            const nachDiesemAuftrag = addWorkdays(new Date(o.endDatum), 1);
            if (nachDiesemAuftrag > freiAb) freiAb = nachDiesemAuftrag;
        });
        machineGrid.innerHTML += `<div class="machine-card"><div class="machine-name">${m.name}</div><div class="machine-percent" style="font-size: 20px;">${cards.length}</div><div style="font-size: 11px; color: #64748b;">Auftr${cards.length === 1 ? 'ag' : 'äge'} · frei ab ${formatDateShort(freiAb)}</div></div>`;
    });

    const board = document.getElementById('kanbanBoard' + suffix);
    board.innerHTML = '';
    const spalten = [...maschinenListe, { id: null, name: 'Nicht zugewiesen' }];

    spalten.forEach(spalte => {
        const col = document.createElement('div');
        col.className = 'kanban-column';
        col.dataset.maschineId = spalte.id ?? '';

        // Aufträge, bei denen alle Komponenten da sind, stehen oben in der Spalte -
        // innerhalb der beiden Gruppen entscheidet die Reihenfolge (position). Die
        // Liefertermin-Priorisierung passiert schon bei der Einplanung (position wird
        // dort nach Liefertermin vergeben) - hier NICHT zusätzlich nach lieferdatum
        // sortieren, sonst überschreibt das jedes manuelle Verschieben per Drag & Drop.
        const cards = produktionOrders
            .filter(o => spalte.id === null ? !o.maschineId : (o.maschineId === spalte.id || o.maschineId2 === spalte.id))
            .sort((a, b) => {
                const bereitA = istKomponentenBereit(a) ? 0 : 1;
                const bereitB = istKomponentenBereit(b) ? 0 : 1;
                if (bereitA !== bereitB) return bereitA - bereitB;
                return a.position - b.position;
            });

        col.innerHTML = `<div class="kanban-column-header">${spalte.name}</div><div class="kanban-column-sub">${cards.length} Auftrag${cards.length === 1 ? '' : 'e'}</div>`;

        cards.forEach(order => {
            const card = buildCardElement(order, { spalte });

            // Nur der kleine Griff ist draggable, nicht die ganze Karte - so bleibt
            // der Kartentext normal markier- und kopierbar.
            const handle = document.createElement('div');
            handle.className = 'drag-handle';
            handle.textContent = '⠿';
            handle.draggable = true;
            handle.title = 'Ziehen zum Verschieben';
            card.appendChild(handle);

            if (order.status === 'geplant') {
                addCardAction(card, '🔧 Endbearbeitung', () => movePhase(order._id, 'endbearbeitung'));
                addCardAction(card, '📦 Ausgeliefert', () => movePhase(order._id, 'ausgeliefert'), 'primary');
            }
            // Trotz fehlender Komponenten schon in den Zeitplan aufnehmen (z.B. wenn
            // sicher ist, dass sie rechtzeitig eintreffen) - erscheint dort gelb.
            if (!istKomponentenBereit(order) && order.maschineId) {
                if (order.manuellEingeplant) {
                    addCardAction(card, '↩ Aus Zeitplan nehmen', () => setManuellEingeplant(order._id, false));
                } else {
                    addCardAction(card, '📅 Trotzdem einplanen', () => setManuellEingeplant(order._id, true));
                }
            }
            const zielDbType = order.dbType === 'Elastomer' ? 'PTFE' : 'Elastomer';
            const zielLabel = zielDbType === 'PTFE' ? 'CNC' : 'Formgebung';
            addCardAction(card, `↔ Zu ${zielLabel} verschieben`, () => moveToOtherDepartment(order._id, zielDbType));
            addDeleteAction(card, order._id);

            handle.addEventListener('dragstart', (e) => {
                e.stopPropagation();
                // Manche Browser (v.a. Firefox) starten einen Drag nur, wenn
                // dataTransfer tatsächlich befüllt wird - sonst passiert visuell nichts.
                e.dataTransfer.setData('text/plain', order._id);
                e.dataTransfer.effectAllowed = 'move';
                draggedOrderId = order._id;
                // Auch für den Zeitplan gesetzt, damit sich Karten (auch "Nicht
                // zugewiesene") direkt auf eine Zeitplan-Zelle ziehen lassen -
                // das legt dann Maschine + Start-/Enddatum auf einen Schlag fest.
                draggedOrderFeld = 'maschineId';
                isDragging = true;
                card.classList.add('dragging');
            });
            handle.addEventListener('dragend', () => {
                isDragging = false;
                draggedOrderFeld = null;
                card.classList.remove('dragging');
            });
            card.addEventListener('dragover', (e) => e.preventDefault());
            card.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (draggedOrderId && draggedOrderId !== order._id) {
                    moveOrder(draggedOrderId, spalte.id, order.position - 0.5);
                }
            });

            col.appendChild(card);
        });

        col.addEventListener('dragover', (e) => {
            e.preventDefault();
            col.classList.add('drag-over');
        });
        col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
        col.addEventListener('drop', (e) => {
            e.preventDefault();
            col.classList.remove('drag-over');
            if (draggedOrderId) {
                const maxPos = cards.length ? Math.max(...cards.map(c => c.position)) : 0;
                moveOrder(draggedOrderId, spalte.id, maxPos + 1);
            }
        });

        board.appendChild(col);
    });

    const statusEl = document.getElementById('boardSyncStatus' + suffix);
    if (statusEl) statusEl.textContent = `Zuletzt aktualisiert: ${new Date().toLocaleTimeString('de-DE')}`;
    updateKanbanScrollbarWidth(suffix);
}

// Der native horizontale Scrollbalken sitzt am unteren Rand des Boards - bei
// vielen Karten liegt der weit unterhalb des sichtbaren Bereichs. Stattdessen
// oben eine schmale, künstliche Scrollleiste anzeigen, deren Breite auf die
// tatsächliche Board-Breite gesetzt und deren Scrollposition mit dem Board
// synchron gehalten wird (in beide Richtungen).
function updateKanbanScrollbarWidth(suffix) {
    const board = document.getElementById('kanbanBoard' + suffix);
    const scrollTop = document.getElementById('kanbanScrollTop' + suffix);
    if (!board || !scrollTop) return;
    scrollTop.firstElementChild.style.width = `${board.scrollWidth}px`;
}

function initKanbanScrollbarSync(suffix) {
    const board = document.getElementById('kanbanBoard' + suffix);
    const scrollTop = document.getElementById('kanbanScrollTop' + suffix);
    if (!board || !scrollTop) return;
    let syncing = false;
    scrollTop.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        board.scrollLeft = scrollTop.scrollLeft;
        syncing = false;
    });
    board.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        scrollTop.scrollLeft = board.scrollLeft;
        syncing = false;
    });
}

// Zeitplan: KW + Mo-Fr fixiert links (sticky), Maschinen als Spalten, Aufträge als
// Balken, die genau so viele Tageszeilen belegen, wie ihre Produktion dauert.
function computeTimelineTage(orders) {
    let minDate = startOfWeek(nextWeekday(new Date()));
    let maxDate = endOfWeek(addWorkdays(minDate, 9));

    orders.forEach(o => {
        if (!o.startDatum || !o.endDatum) return;
        const s = startOfWeek(new Date(o.startDatum));
        const e = endOfWeek(new Date(o.endDatum));
        if (s < minDate) minDate = s;
        if (e > maxDate) maxDate = e;
    });

    const tage = [];
    const cur = new Date(minDate);
    while (cur <= maxDate) {
        if (isWeekday(cur)) tage.push(new Date(cur));
        cur.setDate(cur.getDate() + 1);
    }
    return tage;
}

function groupByWeek(tage) {
    const gruppen = [];
    let aktuell = null;
    tage.forEach(t => {
        const key = `${t.getFullYear()}-${getISOWeek(t)}`;
        if (!aktuell || aktuell.key !== key) {
            aktuell = { key, woche: getISOWeek(t), tage: [] };
            gruppen.push(aktuell);
        }
        aktuell.tage.push(t);
    });
    return gruppen;
}

function renderGantt(orders, dbType) {
    const suffix = DBTYPE_SUFFIX[dbType];
    const maschinenListe = MASCHINEN.filter(m => m.type === dbType);
    const grid = document.getElementById('ganttGrid' + suffix);
    if (!grid) return;

    // Nur produzierbare Aufträge (alle Komponenten da) im Zeitplan zeigen - oder
    // manuell trotz fehlender Komponenten eingeplante (siehe manuellEingeplant-Button
    // auf der Kanban-Karte).
    const mitTerminen = orders.filter(o => o.startDatum && o.endDatum && (istKomponentenBereit(o) || o.manuellEingeplant));
    const tage = computeTimelineTage(mitTerminen);
    const wochen = groupByWeek(tage);

    grid.innerHTML = '';
    // Formgebung hat nur 4 Maschinen (statt 10 bei CNC) - dafür ist mehr Platz,
    // sodass die Balkeninhalte (Artikel/Auftrag/Bezeichnung/Lieferwoche) nicht
    // gequetscht wirken.
    const spaltenBreite = dbType === 'Elastomer' ? 220 : 150;
    grid.style.gridTemplateColumns = `40px 46px repeat(${maschinenListe.length}, ${spaltenBreite}px)`;
    // 100px pro Tag, damit auch ein 1-Tages-Balken mit allen vier Zeilen
    // (Artikel, Auftrag, Bezeichnung über 2 Zeilen, Lieferwoche) Platz hat.
    grid.style.gridTemplateRows = `32px repeat(${tage.length}, 100px)`;

    const ecke = document.createElement('div');
    ecke.className = 'gantt-corner';
    ecke.style.gridColumn = '1 / span 2';
    ecke.style.gridRow = '1 / span 1';
    grid.appendChild(ecke);

    maschinenListe.forEach((m, mi) => {
        const header = document.createElement('div');
        header.className = 'gantt-machine-header';
        header.textContent = m.name;
        header.style.gridColumn = `${mi + 3} / span 1`;
        header.style.gridRow = '1 / span 1';
        grid.appendChild(header);
    });

    let zeile = 2;
    wochen.forEach(w => {
        const kwLabel = document.createElement('div');
        kwLabel.className = 'gantt-week-label';
        kwLabel.textContent = `KW ${w.woche}`;
        kwLabel.style.gridColumn = '1 / span 1';
        kwLabel.style.gridRow = `${zeile} / span ${w.tage.length}`;
        grid.appendChild(kwLabel);
        zeile += w.tage.length;
    });

    const wochentage = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    tage.forEach((t, i) => {
        const dayLabel = document.createElement('div');
        dayLabel.className = 'gantt-day-label';
        dayLabel.textContent = `${wochentage[t.getDay()]} ${String(t.getDate()).padStart(2, '0')}.${String(t.getMonth() + 1).padStart(2, '0')}.`;
        dayLabel.style.gridColumn = '2 / span 1';
        dayLabel.style.gridRow = `${i + 2} / span 1`;
        grid.appendChild(dayLabel);

        maschinenListe.forEach((m, mi) => {
            const cell = document.createElement('div');
            cell.className = 'gantt-cell';
            cell.style.gridColumn = `${mi + 3} / span 1`;
            cell.style.gridRow = `${i + 2} / span 1`;
            cell.dataset.maschineId = m.id;
            cell.dataset.tag = t.toISOString();

            // Wie beim Kanban-Board ist die Maschinen-/Terminzuordnung nur eine
            // Empfehlung - per Drag & Drop im Zeitplan lässt sich jeder Auftrag frei
            // auf eine andere Maschine oder einen anderen Tag verschieben.
            cell.addEventListener('dragover', (e) => {
                e.preventDefault();
                cell.classList.add('drag-over');
            });
            cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
            cell.addEventListener('drop', (e) => {
                e.preventDefault();
                cell.classList.remove('drag-over');
                if (draggedOrderId && draggedOrderFeld) {
                    moveGanttOrder(draggedOrderId, draggedOrderFeld, m.id, t);
                }
            });

            grid.appendChild(cell);
        });
    });

    mitTerminen.forEach(o => {
        [o.maschineId, o.maschineId2].filter(Boolean).forEach(maschineId => {
            const feld = maschineId === o.maschineId ? 'maschineId' : 'maschineId2';
            const mi = maschinenListe.findIndex(m => m.id === maschineId);
            if (mi === -1) return;
            const start = new Date(o.startDatum);
            const ende = new Date(o.endDatum);
            const startIdx = tage.findIndex(t => isSameDay(t, start));
            const endIdx = tage.findIndex(t => isSameDay(t, ende));
            if (startIdx === -1 || endIdx === -1) return;

            const fehlendeKomponenten = o.manuellEingeplant && !istKomponentenBereit(o);
            const bar = document.createElement('div');
            bar.className = `gantt-bar card-${o.status}${fehlendeKomponenten ? ' card-manuell' : ''}`;
            const lieferwoche = formatLieferwoche(o.lieferdatum);
            // Produktion endet nach dem Liefertermin - im Zeitplan als Warnung markieren.
            const zuSpaet = o.lieferdatum && ende > new Date(o.lieferdatum);
            // Artikelnummer, Auftragsnummer, Bezeichnung und Lieferwoche als eigene
            // Zeilen/Zellen - die Tageszeile (siehe GANTT_TAG_HOEHE) ist bewusst hoch
            // genug bemessen, damit auch bei 1-Tages-Balken alle vier Zeilen Platz
            // haben und nicht durch overflow:hidden abgeschnitten werden.
            bar.innerHTML = `
                <div class="gantt-bar-zelle gantt-bar-artikel">${escapeHtml(o.artikelnummer)}</div>
                <div class="gantt-bar-zelle gantt-bar-auftrag">Auftrag ${escapeHtml(o.auftragsnummer)}</div>
                ${o.beschreibung ? `<div class="gantt-bar-zelle gantt-bar-desc">${escapeHtml(o.beschreibung)}</div>` : ''}
                ${lieferwoche ? `<div class="gantt-bar-zelle gantt-bar-lieferwoche${zuSpaet ? ' spaet' : ''}">${zuSpaet ? '⚠ ' : ''}Liefertermin ${lieferwoche}</div>` : ''}
                ${fehlendeKomponenten ? `<div class="gantt-bar-zelle gantt-bar-manuell">⚠ Komponenten fehlen noch</div>` : ''}
            `;
            bar.title = `${o.artikelnummer}${o.beschreibung ? ' - ' + o.beschreibung : ''}\nAuftrag ${o.auftragsnummer}\n${formatDateShort(o.startDatum)} – ${formatDateShort(o.endDatum)}${lieferwoche ? `\nLiefertermin ${formatDateShort(o.lieferdatum)} (${lieferwoche})` : ''}${fehlendeKomponenten ? '\n⚠ Manuell eingeplant - Komponenten fehlen noch' : ''}\nZiehen zum Verschieben`;
            bar.style.gridColumn = `${mi + 3} / span 1`;
            bar.style.gridRow = `${startIdx + 2} / span ${endIdx - startIdx + 1}`;
            bar.draggable = true;
            bar.addEventListener('dragstart', (e) => {
                e.stopPropagation();
                // Manche Browser (v.a. Firefox) starten einen Drag nur, wenn
                // dataTransfer tatsächlich befüllt wird - sonst passiert visuell nichts.
                e.dataTransfer.setData('text/plain', o._id);
                e.dataTransfer.effectAllowed = 'move';
                draggedOrderId = o._id;
                draggedOrderFeld = feld;
                isDragging = true;
                bar.classList.add('dragging');
            });
            bar.addEventListener('dragend', () => {
                isDragging = false;
                draggedOrderFeld = null;
                bar.classList.remove('dragging');
            });
            grid.appendChild(bar);
        });
    });
}

// Auftrag im Zeitplan per Drag & Drop auf eine andere Maschine/einen anderen Tag
// verschieben - die Dauer bleibt gleich, nur Start (und damit Ende) verschiebt sich.
async function moveGanttOrder(orderId, feld, maschineId, neuerStartTag) {
    const order = boardOrders.find(o => o._id === orderId);
    if (!order) return;

    const tage = Math.max(1, order.schichten || 1);
    const startDatum = nextWeekday(new Date(neuerStartTag));
    const endDatum = addWorkdays(startDatum, tage - 1);

    order[feld] = maschineId;
    order.startDatum = startDatum;
    order.endDatum = endDatum;
    order.status = 'geplant';
    renderAll();

    try {
        await fetch(`${API_URL}/orders/${orderId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ [feld]: maschineId, startDatum, endDatum, status: 'geplant' }),
        });
    } catch (err) {
        // Bei Fehler synct der nächste Poll den echten Stand
    }
}

function renderEndbearbeitung(dbType) {
    const liste = document.getElementById('endbearbeitungListe' + DBTYPE_SUFFIX[dbType]);
    if (!liste) return;
    const cards = boardOrders.filter(o => o.phase === 'endbearbeitung' && o.dbType === dbType);
    liste.innerHTML = '';
    if (cards.length === 0) {
        liste.innerHTML = '<p style="color: #64748b;">Keine Aufträge in der Endbearbeitung.</p>';
        return;
    }
    cards.forEach(order => {
        const card = buildCardElement(order);
        addCardAction(card, '📦 Ausgeliefert', () => movePhase(order._id, 'ausgeliefert'), 'primary');
        addCardAction(card, '↩ Zurück zur Produktion', () => movePhase(order._id, 'produktion'));
        addDeleteAction(card, order._id);
        liste.appendChild(card);
    });
}

function renderAusgeliefert(dbType) {
    const liste = document.getElementById('ausgeliefertListe' + DBTYPE_SUFFIX[dbType]);
    if (!liste) return;
    const cards = boardOrders
        .filter(o => o.phase === 'ausgeliefert' && o.dbType === dbType)
        .sort((a, b) => new Date(b.warenausgang || 0) - new Date(a.warenausgang || 0));
    liste.innerHTML = '';
    if (cards.length === 0) {
        liste.innerHTML = '<p style="color: #64748b;">Noch keine ausgelieferten Aufträge.</p>';
        return;
    }
    cards.forEach(order => {
        const card = buildCardElement(order);

        const wa = document.createElement('div');
        wa.className = 'warenausgang-zeile';
        wa.innerHTML = `<span>📤 Warenausgang</span><input type="date" class="komp-date" value="${toDateInputValue(order.warenausgang)}">`;
        const waInput = wa.querySelector('input');
        waInput.draggable = false;
        waInput.addEventListener('change', (e) => setWarenausgang(order._id, e.target.value));
        card.appendChild(wa);

        addCardAction(card, '↩ Zurück zur Endbearbeitung', () => movePhase(order._id, 'endbearbeitung'));
        addDeleteAction(card, order._id);
        liste.appendChild(card);
    });
}

async function movePhase(orderId, phase) {
    const order = boardOrders.find(o => o._id === orderId);
    if (!order) return;
    order.phase = phase;
    const patchBody = { phase };
    if (phase === 'ausgeliefert' && !order.warenausgang) {
        order.warenausgang = new Date().toISOString();
        patchBody.warenausgang = order.warenausgang;
    }
    renderAll();

    try {
        await fetch(`${API_URL}/orders/${orderId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(patchBody),
        });
    } catch (err) {
        // Bei Fehler synct der nächste Poll den echten Stand
    }
}

// Auftrag zwischen Formgebung und CNC umhängen - beide Bereiche haben komplett
// unterschiedliche Maschinen, deshalb Maschine/Termine zurücksetzen und im
// Zielbereich unter "Nicht zugewiesen" landen lassen, statt eine falsche
// Zuordnung zu übernehmen.
async function moveToOtherDepartment(orderId, zielDbType) {
    const order = boardOrders.find(o => o._id === orderId);
    if (!order) return;

    order.dbType = zielDbType;
    order.maschineId = null;
    order.maschineId2 = null;
    order.startDatum = null;
    order.endDatum = null;
    order.status = 'ausstehend';
    renderAll();

    try {
        await fetch(`${API_URL}/orders/${orderId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
                dbType: zielDbType,
                maschineId: null,
                maschineId2: null,
                startDatum: null,
                endDatum: null,
                status: 'ausstehend',
            }),
        });
    } catch (err) {
        // Bei Fehler synct der nächste Poll den echten Stand
    }
}

async function setWarenausgang(orderId, dateStr) {
    const order = boardOrders.find(o => o._id === orderId);
    if (!order) return;
    order.warenausgang = dateStr ? new Date(dateStr).toISOString() : null;
    renderAusgeliefert(order.dbType);

    try {
        await fetch(`${API_URL}/orders/${orderId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ warenausgang: order.warenausgang }),
        });
    } catch (err) {
        // Bei Fehler synct der nächste Poll den echten Stand
    }
}

async function deleteOrder(orderId) {
    const order = boardOrders.find(o => o._id === orderId);
    if (!order) return;

    boardOrders = boardOrders.filter(o => o._id !== orderId);
    renderAll();

    try {
        await fetch(`${API_URL}/orders/${orderId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
        });
    } catch (err) {
        // Bei Fehler synct der nächste Poll den echten Stand
    }
}

// Wie addDeleteAction: keine native confirm()-Box (wird in manchen Kontexten
// stillschweigend unterdrückt), sondern zweiter Klick innerhalb von 5s bestätigt.
// Formgebung und CNC sind komplett getrennte Bereiche - "Alle löschen" betrifft
// deshalb nur die Aufträge des jeweiligen Bereichs (alle Phasen).
const deleteAllState = {};
async function handleDeleteAllOrders(dbType) {
    const suffix = DBTYPE_SUFFIX[dbType];
    const label = suffix === 'Formgebung' ? 'Formgebung' : 'CNC';
    const btn = document.getElementById('deleteAllOrdersBtn' + suffix);
    const note = document.getElementById('deleteAllOrdersNote' + suffix);
    const state = deleteAllState[dbType] || (deleteAllState[dbType] = { confirming: false, timer: null });

    if (!state.confirming) {
        state.confirming = true;
        btn.textContent = `Wirklich ALLE ${label}-Aufträge löschen? Nochmal klicken`;
        state.timer = setTimeout(() => {
            state.confirming = false;
            btn.textContent = `🗑 Alle ${label}-Aufträge löschen`;
        }, 5000);
        return;
    }
    clearTimeout(state.timer);
    state.confirming = false;
    btn.textContent = `🗑 Alle ${label}-Aufträge löschen`;

    try {
        const res = await fetch(`${API_URL}/orders?dbType=${dbType}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) throw new Error();
        boardOrders = boardOrders.filter(o => o.dbType !== dbType);
        renderAll();
        note.style.color = '#15803d';
        note.textContent = `Alle ${label}-Aufträge gelöscht.`;
    } catch (err) {
        note.style.color = '#b91c1c';
        note.textContent = 'Löschen fehlgeschlagen. Bitte erneut versuchen.';
    }
}
document.getElementById('deleteAllOrdersBtnFormgebung')?.addEventListener('click', () => handleDeleteAllOrders('Elastomer'));
document.getElementById('deleteAllOrdersBtnCnc')?.addEventListener('click', () => handleDeleteAllOrders('PTFE'));

// Nächster freier Werktag für eine Maschine basierend auf dem tatsächlich
// aktuell geplanten Bestand (nicht nur "heute"), damit ein manuell hinzugefügter
// Auftrag hinter den bestehenden Aufträgen auf dieser Maschine eingereiht wird.
function getMachineNextFree(maschineId, excludeOrderId = null) {
    const relevant = boardOrders.filter(o =>
        o.phase === 'produktion' && o.endDatum && o._id !== excludeOrderId
        && (o.maschineId === maschineId || o.maschineId2 === maschineId));
    if (relevant.length === 0) return nextWeekday(new Date());
    const maxEnd = relevant.reduce((max, o) => {
        const d = new Date(o.endDatum);
        return d > max ? d : max;
    }, new Date(0));
    return addWorkdays(maxEnd, 1);
}

// Für den Vergleich von Lieferterminen: kein Termin gilt als "später als alles",
// analog zur Sortierung in planMachines.
function liefertermSchluessel(datum) {
    return datum ? new Date(datum).getTime() : Infinity;
}

// Nächster freier Platz für einen Auftrag, der GERADE produzierbar wird - anders
// als getMachineNextFree() reiht das nicht hinter ALLE Aufträge der Maschine ein
// (auch nicht hinter noch gar nicht produzierbare mit längst überholtem
// Platzhalter-Termin), sondern nur hinter die bereits produzierbaren Aufträge
// mit gleichem oder früherem Liefertermin. So landet der Auftrag an der zu
// seinem Liefertermin passenden Stelle, ohne dass andere Aufträge (auch
// manuell verschobene) angetastet werden.
function getInsertionSlot(order, maschineId) {
    const vorgaenger = boardOrders.filter(o =>
        o.phase === 'produktion' && o._id !== order._id && o.endDatum && istKomponentenBereit(o)
        && (o.maschineId === maschineId || o.maschineId2 === maschineId)
        && liefertermSchluessel(o.lieferdatum) <= liefertermSchluessel(order.lieferdatum));
    let frei = nextWeekday(new Date());
    vorgaenger.forEach(o => {
        const ende = addWorkdays(new Date(o.endDatum), 1);
        if (ende > frei) frei = ende;
    });
    return frei;
}

async function handleManualAddOrder() {
    const note = document.getElementById('manualAddNote');
    const auftragsnummer = document.getElementById('manualAuftragsnummer').value.trim();
    const artikelnummer = document.getElementById('manualArtikelnummer').value.trim();
    const menge = parseMenge(document.getElementById('manualMenge').value);
    const bestellnummer = document.getElementById('manualBestellnummer').value.trim();
    const lieferdatumStr = document.getElementById('manualLieferdatum').value;

    note.style.color = '#b91c1c';
    if (!auftragsnummer || !artikelnummer || !menge) {
        note.textContent = 'Bitte Auftragsnummer, Artikelnummer und Menge angeben.';
        return;
    }

    const artikel = findArtikel(artikelnummer);
    const dbType = artikel?.dbType || 'Elastomer';

    const komponenten = (artikel?.komponenten || []).map(k => ({
        artikelnummer: k.artikelnummer,
        bezeichnung: k.bezeichnung,
        wareneingang: null,
    }));
    if (dbType === 'Elastomer') {
        komponenten.push({ artikelnummer: '', bezeichnung: 'Werkzeug', wareneingang: null });
    }

    const maschinenNamen = dbType === 'Elastomer'
        ? (classifyElastomerSubtyp(artikel?.maschine) ? [classifyElastomerSubtyp(artikel?.maschine)] : [])
        : classifyPtfeMaschinen(artikel?.maschine);

    const kavitaet = artikel?.kavitaet || 1;
    const rundenProSchicht = artikel?.rundenProSchicht || 1;
    const zeitProHundert = artikel?.zeitProHundert || 0;

    const bearbeitungsMin = dbType === 'PTFE'
        ? (menge / 100) * zeitProHundert
        : Math.ceil(menge / kavitaet) * (480 / rundenProSchicht);
    const schichten = Math.ceil(bearbeitungsMin / 480);
    const tage = Math.max(1, schichten);

    let maschineId = null;
    let maschineId2 = null;
    let startDatum = null;
    let endDatum = null;
    const braucht_manuelle_pruefung = maschinenNamen.length === 0;

    if (!braucht_manuelle_pruefung && maschinenNamen.length === 1) {
        const kandidaten = MASCHINEN.filter(m => m.type === dbType && m.subtyp === maschinenNamen[0]);
        let ziel = null;
        let zielFrei = null;
        kandidaten.forEach(m => {
            const frei = getMachineNextFree(m.id);
            if (!ziel || frei < zielFrei) {
                ziel = m;
                zielFrei = frei;
            }
        });
        if (ziel) {
            startDatum = new Date(zielFrei);
            endDatum = addWorkdays(startDatum, tage - 1);
            maschineId = ziel.id;
        }
    } else if (!braucht_manuelle_pruefung && maschinenNamen.length === 2) {
        const m1 = MASCHINEN.find(m => m.type === dbType && m.subtyp === maschinenNamen[0]);
        const m2 = MASCHINEN.find(m => m.type === dbType && m.subtyp === maschinenNamen[1]);
        if (m1 && m2) {
            const frei1 = getMachineNextFree(m1.id);
            const frei2 = getMachineNextFree(m2.id);
            const fruehester = frei1 > frei2 ? frei1 : frei2;
            startDatum = new Date(fruehester);
            endDatum = addWorkdays(startDatum, tage - 1);
            maschineId = m1.id;
            maschineId2 = m2.id;
        }
    }

    const order = {
        auftragsnummer,
        bestellnummer,
        lieferdatum: lieferdatumStr ? new Date(lieferdatumStr).toISOString() : null,
        artikelnummer,
        beschreibung: artikel?.bezeichnung || '',
        komponenten,
        menge,
        dbType,
        kavitaet,
        rundenProSchicht,
        zeitProHundert,
        maschineId,
        maschineId2,
        startDatum,
        endDatum,
        bearbeitungsMin,
        schichten,
        status: maschineId ? 'geplant' : braucht_manuelle_pruefung ? 'ausstehend' : 'ueberlastet',
        phase: 'produktion',
    };

    try {
        const res = await fetch(`${API_URL}/orders/manual`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ order }),
        });
        const data = await res.json();
        if (!res.ok) {
            note.textContent = data.error || 'Anlegen fehlgeschlagen.';
            return;
        }
        note.style.color = '#15803d';
        note.textContent = braucht_manuelle_pruefung
            ? `✅ Auftrag ${auftragsnummer} angelegt - keine Maschine erkannt, bitte manuell einordnen.`
            : `✅ Auftrag ${auftragsnummer} angelegt und eingeplant.`;
        document.getElementById('manualAuftragsnummer').value = '';
        document.getElementById('manualArtikelnummer').value = '';
        document.getElementById('manualMenge').value = '';
        document.getElementById('manualBestellnummer').value = '';
        document.getElementById('manualLieferdatum').value = '';
        await fetchBoard();
    } catch (err) {
        note.textContent = 'Anlegen fehlgeschlagen. Bitte erneut versuchen.';
    }
}
document.getElementById('manualAddBtn')?.addEventListener('click', handleManualAddOrder);

async function moveOrder(orderId, maschineId, position) {
    // Die Maschinenzuordnung aus der Datenbank ist nur eine Empfehlung für die
    // Auto-Planung - manuelles Verschieben auf jede Maschine ist immer erlaubt.
    const order = boardOrders.find(o => o._id === orderId);
    if (!order) return;

    order.maschineId = maschineId;
    order.position = position;
    order.status = maschineId ? 'geplant' : 'ausstehend';
    renderBoard(order.dbType);

    try {
        await fetch(`${API_URL}/orders/${orderId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ maschineId, position, status: order.status }),
        });
    } catch (err) {
        // Bei Fehler synct der nächste Poll den echten Stand
    }
}

function istKomponentenBereit(order) {
    return !order.komponenten || order.komponenten.length === 0 || order.komponenten.every(k => k.wareneingang);
}

function toDateInputValue(d) {
    if (!d) return '';
    return new Date(d).toISOString().slice(0, 10);
}

async function setKomponenteDatum(orderId, idx, dateStr) {
    const order = boardOrders.find(o => o._id === orderId);
    if (!order || !order.komponenten?.[idx]) return;

    const warBereitVorher = istKomponentenBereit(order);
    order.komponenten[idx].wareneingang = dateStr ? new Date(dateStr).toISOString() : null;
    const istBereitJetzt = istKomponentenBereit(order);

    const patchBody = { komponenten: order.komponenten };

    // Wird ein Auftrag durch dieses Update produzierbar (alle Komponenten da),
    // an der zu seinem Liefertermin passenden Stelle auf seiner Maschine
    // einsortieren - der bisherige Termin wurde oft schon lange vorher vergeben,
    // ohne Rücksicht darauf, wann die Komponenten wirklich verfügbar sind.
    if (!warBereitVorher && istBereitJetzt && order.maschineId) {
        const tage = Math.max(1, order.schichten || 1);
        const frei1 = getInsertionSlot(order, order.maschineId);
        const frei = order.maschineId2
            ? (() => {
                const frei2 = getInsertionSlot(order, order.maschineId2);
                return frei1 > frei2 ? frei1 : frei2;
            })()
            : frei1;
        order.startDatum = new Date(frei);
        order.endDatum = addWorkdays(order.startDatum, tage - 1);
        order.status = 'geplant';
        patchBody.startDatum = order.startDatum;
        patchBody.endDatum = order.endDatum;
        patchBody.status = order.status;
    }

    renderAll();

    try {
        await fetch(`${API_URL}/orders/${orderId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(patchBody),
        });
    } catch (err) {
        // Bei Fehler synct der nächste Poll den echten Stand
    }
}

// Auftrag trotz fehlender Komponenten in den Zeitplan aufnehmen (oder wieder
// entfernen) - der Auftrag hat bereits einen Termin (aus der Einplanung), nur
// die Anzeige im Zeitplan war bisher an istKomponentenBereit() gekoppelt.
async function setManuellEingeplant(orderId, wert) {
    const order = boardOrders.find(o => o._id === orderId);
    if (!order) return;
    order.manuellEingeplant = wert;
    renderAll();

    try {
        await fetch(`${API_URL}/orders/${orderId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ manuellEingeplant: wert }),
        });
    } catch (err) {
        // Bei Fehler synct der nächste Poll den echten Stand
    }
}

// Freier Kommentar je Auftrag - bewusst kein renderAll() nach dem Setzen (anders
// als bei setManuellEingeplant), damit der Textbereich beim Tippen nicht neu
// aufgebaut wird und den Fokus/die Cursor-Position verliert.
async function setKommentar(orderId, kommentar) {
    const order = boardOrders.find(o => o._id === orderId);
    if (!order) return;
    order.kommentar = kommentar;

    try {
        await fetch(`${API_URL}/orders/${orderId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ kommentar }),
        });
    } catch (err) {
        // Bei Fehler synct der nächste Poll den echten Stand
    }
}

// Chargennummer des Lieferanten je Komponente - für ISO-9001-Rückverfolgbarkeit,
// löst anders als das Wareneingangsdatum keine Zeitplan-Neuberechnung aus.
async function setKomponenteCharge(orderId, idx, charge) {
    const order = boardOrders.find(o => o._id === orderId);
    if (!order || !order.komponenten?.[idx]) return;

    order.komponenten[idx].charge = charge;

    try {
        await fetch(`${API_URL}/orders/${orderId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ komponenten: order.komponenten }),
        });
    } catch (err) {
        // Bei Fehler synct der nächste Poll den echten Stand
    }
}

function exportPlannerExcel(dbType) {
    const data = boardOrders
        .filter(r => (!r.phase || r.phase === 'produktion') && r.dbType === dbType)
        .map(r => ({
            'Auftrag': r.auftragsnummer,
            'Bestellung': r.bestellnummer || '',
            'Artikel': r.artikelnummer,
            'Menge': r.menge,
            'Maschine': MASCHINEN.find(m => m.id === r.maschineId)?.name || 'Nicht zugewiesen',
            'Maschine 2': MASCHINEN.find(m => m.id === r.maschineId2)?.name || '',
            'Start': r.startDatum ? new Date(r.startDatum).toLocaleDateString('de-DE') : '',
            'Ende': r.endDatum ? new Date(r.endDatum).toLocaleDateString('de-DE') : '',
            'Zeit (h)': (r.bearbeitungsMin / 60).toFixed(1),
            'Schichten': r.schichten,
            'Status': r.status,
        }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Planung');
    XLSX.writeFile(wb, dbType === 'Elastomer' ? 'Auftragsplanung-Formgebung.xlsx' : 'Auftragsplanung-CNC.xlsx');
}

document.getElementById('loginBtn')?.addEventListener('click', handleLogin);
document.getElementById('registerBtn')?.addEventListener('click', handleRegister);
document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);
document.getElementById('exportBtnFormgebung')?.addEventListener('click', () => exportPlannerExcel('Elastomer'));
document.getElementById('exportBtnCnc')?.addEventListener('click', () => exportPlannerExcel('PTFE'));
document.getElementById('goToBoardFormgebungBtn')?.addEventListener('click', () => showPage('boardFormgebung'));
document.getElementById('goToBoardCncBtn')?.addEventListener('click', () => showPage('boardCnc'));
document.getElementById('exportConverterBtn')?.addEventListener('click', exportConverterExcel);
document.querySelectorAll('.toggle-register-link').forEach(el => el.addEventListener('click', toggleRegister));
document.querySelectorAll('.sidebar-item[data-page]').forEach(el => el.addEventListener('click', switchPage));

async function loadInviteInfo() {
    if (currentUser?.role !== 'admin') return;
    try {
        const res = await fetch(`${API_URL}/auth/invite`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        const link = `${window.location.origin}/?invite=${data.inviteCode}`;
        document.getElementById('inviteLinkInput').value = link;
        document.getElementById('inviteCard').classList.remove('hidden');
    } catch (err) {
        // Einladungslink konnte nicht geladen werden
    }
}

document.getElementById('copyInviteBtn')?.addEventListener('click', async () => {
    const input = document.getElementById('inviteLinkInput');
    input.select();
    try {
        await navigator.clipboard.writeText(input.value);
        const btn = document.getElementById('copyInviteBtn');
        const original = btn.textContent;
        btn.textContent = '✅ Kopiert';
        setTimeout(() => btn.textContent = original, 2000);
    } catch (err) {
        // Clipboard-API evtl. nicht verfügbar, Nutzer kann manuell kopieren
    }
});

function prefillInviteCode() {
    const params = new URLSearchParams(window.location.search);
    const invite = params.get('invite');
    if (!invite) return;
    document.getElementById('registerInviteCode').value = invite;
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('registerForm').classList.remove('hidden');
}

async function initSession() {
    prefillInviteCode();
    if (!token) return;
    try {
        const res = await fetch(`${API_URL}/auth/me`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('Sitzung abgelaufen');
        currentUser = await res.json();
        showApp();
        loadArtikelstamm();
        loadInviteInfo();
    } catch (err) {
        localStorage.removeItem('token');
        token = null;
    }
}

// Bei gehaltener Shift-Taste (übliche Konvention für Mausrad -> seitwärts) auf
// horizontales Scrollen umleiten. Ohne Shift eine rein vertikale Geste (z.B.
// Trackpad runterscrollen) NIE dem Browser-Standardverhalten überlassen - manche
// Browser/Trackpad-Treiber wandeln das über einem nur horizontal scrollbaren
// Element sonst eigenmächtig in seitliches Scrollen um. Stattdessen übernehmen
// wir das vertikale Scrollen hier selbst: im Element, solange darin noch Platz
// ist, sonst auf der Seite - damit garantiert nichts seitwärts rutscht.
function enableHorizontalWheelScroll(el) {
    if (!el) return;
    el.addEventListener('wheel', (e) => {
        if (e.shiftKey) {
            if (el.scrollWidth <= el.clientWidth) return;
            el.scrollLeft += e.deltaY;
            e.preventDefault();
            return;
        }
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // echte seitliche Geste durchlassen

        const canScrollY = el.scrollHeight > el.clientHeight;
        if (canScrollY) {
            const maxScrollTop = el.scrollHeight - el.clientHeight;
            const naechster = Math.min(Math.max(el.scrollTop + e.deltaY, 0), maxScrollTop);
            if (naechster !== el.scrollTop) {
                el.scrollTop = naechster;
                e.preventDefault();
                return;
            }
        }
        e.preventDefault();
        window.scrollBy(0, e.deltaY);
    }, { passive: false });
}
enableHorizontalWheelScroll(document.getElementById('kanbanBoardFormgebung'));
enableHorizontalWheelScroll(document.getElementById('kanbanBoardCnc'));
initKanbanScrollbarSync('Formgebung');
initKanbanScrollbarSync('Cnc');
document.querySelectorAll('.gantt-wrapper').forEach(enableHorizontalWheelScroll);

// --- Sidebar-Suche: Auftrag/Artikel finden und zur Auftragskartei springen ---

const PHASE_PAGE_PREFIX = { produktion: 'board', endbearbeitung: 'endbearbeitung', ausgeliefert: 'ausgeliefert' };

function sidebarSearchErgebnisse(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return boardOrders
        .filter(o => (o.auftragsnummer || '').toLowerCase().includes(q)
            || (o.artikelnummer || '').toLowerCase().includes(q)
            || (o.beschreibung || '').toLowerCase().includes(q))
        .slice(0, 8);
}

function renderSidebarSearchResults(ergebnisse) {
    const box = document.getElementById('sidebarSearchResults');
    if (ergebnisse.length === 0) {
        box.innerHTML = '<div class="sidebar-search-empty">Keine Treffer.</div>';
        box.classList.remove('hidden');
        return;
    }
    box.innerHTML = '';
    ergebnisse.forEach(order => {
        const bereich = DBTYPE_SUFFIX[order.dbType] === 'Cnc' ? 'CNC' : 'Formgebung';
        const phaseLabel = order.phase === 'endbearbeitung' ? 'Endbearbeitung' : order.phase === 'ausgeliefert' ? 'Ausgeliefert' : 'Planungsboard';
        const el = document.createElement('div');
        el.className = 'sidebar-search-result';
        el.innerHTML = `
            <div class="ssr-titel">${escapeHtml(order.artikelnummer || '–')} · ${escapeHtml(order.auftragsnummer || '')}</div>
            <div class="ssr-meta">${bereich} · ${phaseLabel}${order.beschreibung ? ' · ' + escapeHtml(order.beschreibung) : ''}</div>
        `;
        el.addEventListener('click', () => springZuAuftrag(order));
        box.appendChild(el);
    });
    box.classList.remove('hidden');
}

// Springt zur Auftragskartei (Kanban-Karte) - wechselt zuerst auf die richtige
// Board-Seite (Formgebung/CNC × Planungsboard/Endbearbeitung/Ausgeliefert),
// scrollt die Karte dann in den sichtbaren Bereich und hebt sie kurz hervor.
function springZuAuftrag(order) {
    const prefix = PHASE_PAGE_PREFIX[order.phase] || 'board';
    const page = prefix + DBTYPE_SUFFIX[order.dbType];
    showPage(page);
    document.getElementById('sidebarSearchInput').value = '';
    document.getElementById('sidebarSearchResults').classList.add('hidden');

    // Die Karte steht durch renderAll() i.d.R. schon im DOM (auch auf gerade
    // verdeckten Seiten vorgerendert) - kurz nachschauen, falls showPage()
    // parallel gerade erst neu lädt.
    let versuche = 0;
    const suchen = () => {
        const karte = document.querySelector(`[data-order-id="${order._id}"]`);
        if (karte) {
            karte.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
            karte.classList.add('karte-hervorgehoben');
            setTimeout(() => karte.classList.remove('karte-hervorgehoben'), 1800);
        } else if (versuche < 10) {
            versuche++;
            setTimeout(suchen, 200);
        }
    };
    suchen();
}

document.getElementById('sidebarSearchInput')?.addEventListener('input', (e) => {
    renderSidebarSearchResults(sidebarSearchErgebnisse(e.target.value));
});
document.getElementById('sidebarSearchInput')?.addEventListener('focus', (e) => {
    if (e.target.value.trim()) renderSidebarSearchResults(sidebarSearchErgebnisse(e.target.value));
});
document.getElementById('sidebarSearchInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        e.target.value = '';
        document.getElementById('sidebarSearchResults').classList.add('hidden');
    } else if (e.key === 'Enter') {
        const erster = sidebarSearchErgebnisse(e.target.value)[0];
        if (erster) springZuAuftrag(erster);
    }
});
document.addEventListener('click', (e) => {
    if (!e.target.closest('.sidebar-search')) document.getElementById('sidebarSearchResults')?.classList.add('hidden');
});

initSession();
