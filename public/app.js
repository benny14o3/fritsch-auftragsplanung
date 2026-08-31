const API_URL = '/api';
let token = localStorage.getItem('token');
let currentUser = null;
let converterData = [];
let converterPdfData = [];
let plannerDBs = { Elastomer: null, PTFE: null };
let stueckliste = { materialien: [] };

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
        loadDatabaseStatus();
        loadStueckliste();
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
        loadDatabaseStatus();
        loadStueckliste();
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
            menge: parseInt(r[mengeCol]) || 0,
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
            menge: posMatch ? posMatch[2] : '',
            preis: preisMatch ? preisMatch[1] : '',
            bestellnummer,
            bestelldatum,
        };
    });
}

document.getElementById('converterPdfFile')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const note = document.getElementById('converterPdfNote');
    note.style.color = '#64748b';
    note.textContent = 'Lese PDF...';
    try {
        const zeilen = await extractPdfLines(file);
        converterPdfData = parseBestellungsPdf(zeilen);

        if (converterPdfData.length === 0) {
            note.style.color = '#b91c1c';
            note.textContent = 'Keine Positionen gefunden - das Format dieser PDF weicht evtl. ab.';
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
        note.style.color = '#15803d';
        note.textContent = `✅ ${converterPdfData.length} Position${converterPdfData.length === 1 ? '' : 'en'} gefunden.`;
    } catch (err) {
        note.style.color = '#b91c1c';
        note.textContent = 'Fehler beim Lesen der PDF: ' + err.message;
    }
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

        const res = await fetch(`${API_URL}/databases/${type}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ articles }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        // data.articles (nicht das lokal geparste articles) hat die von Mongo
        // vergebenen _id's - die brauchen die Bearbeiten/Löschen-Aktionen in der Tabelle.
        plannerDBs[type] = data.articles;
        renderDatabaseTable(type);
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
        const res = await fetch(`${API_URL}/stueckliste`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ materialien }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        stueckliste = data;
        renderStuecklisteTable();
        statusEl.textContent = `✅ ${materialien.length} Artikel gespeichert (${new Date(data.lastUpdated).toLocaleString('de-DE')})`;
    } catch (err) {
        statusEl.textContent = '❌ Fehler: ' + err.message;
    }
});

async function loadStueckliste() {
    try {
        const res = await fetch(`${API_URL}/stueckliste`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        stueckliste = data;
        const statusEl = document.getElementById('stuecklisteStatus');
        if (statusEl && data.materialien?.length) {
            statusEl.textContent = `✅ ${data.materialien.length} Artikel gespeichert (${new Date(data.lastUpdated).toLocaleString('de-DE')})`;
        }
        renderStuecklisteTable();
    } catch (err) {
        // Stückliste konnte nicht geladen werden, Status bleibt leer
    }
}

async function loadDatabaseStatus() {
    try {
        const res = await fetch(`${API_URL}/databases`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) return;
        const databases = await res.json();
        databases.forEach(db => {
            plannerDBs[db.type] = db.articles;
            const statusEl = document.getElementById(db.type === 'Elastomer' ? 'elastomerStatus' : 'ptfeStatus');
            const text = `✅ ${db.articles.length} Artikel gespeichert (${new Date(db.lastUpdated).toLocaleString('de-DE')})`;
            if (statusEl) statusEl.textContent = text;
            renderDatabaseTable(db.type);
        });
    } catch (err) {
        // Datenbanken konnten nicht geladen werden, Status bleibt leer
    }
}

// Einzelne Artikel direkt in der Weboberfläche pflegen, ohne jedes Mal die
// ganze Excel neu hochladen zu müssen. Nur ein Artikel gleichzeitig editierbar.
let editingArticle = { type: null, id: null };

function renderDatabaseTable(type) {
    const suffix = type === 'Elastomer' ? 'elastomer' : 'ptfe';
    const tbody = document.getElementById(`${suffix}ArticleTable`);
    if (!tbody) return;

    const filterEl = document.getElementById(`${suffix}Filter`);
    const filterVal = (filterEl?.value || '').toLowerCase().trim();
    const articles = plannerDBs[type] || [];
    const filtered = filterVal
        ? articles.filter(a => (a.material || '').toLowerCase().includes(filterVal) || (a.beschreibung || '').toLowerCase().includes(filterVal))
        : articles;

    tbody.innerHTML = '';
    filtered.forEach(article => {
        const isEditing = editingArticle.type === type && editingArticle.id === article._id;
        const tr = document.createElement('tr');
        const actionsTd = document.createElement('td');
        actionsTd.className = 'table-actions';

        if (!isEditing) {
            [article.material, article.beschreibung, article.maschine, article.kavitaet ?? '', article.rundenProSchicht ?? '', article.zeitProHundert ?? ''].forEach(val => {
                const td = document.createElement('td');
                td.textContent = val;
                tr.appendChild(td);
            });

            const editBtn = document.createElement('button');
            editBtn.textContent = '✏️';
            editBtn.title = 'Bearbeiten';
            editBtn.addEventListener('click', () => {
                editingArticle = { type, id: article._id };
                renderDatabaseTable(type);
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
                deleteDatabaseArticle(type, article._id);
            });

            actionsTd.appendChild(editBtn);
            actionsTd.appendChild(delBtn);
        } else {
            const fields = [
                { key: 'material', value: article.material, inputType: 'text' },
                { key: 'beschreibung', value: article.beschreibung, inputType: 'text' },
                { key: 'maschine', value: article.maschine, inputType: 'text' },
                { key: 'kavitaet', value: article.kavitaet ?? '', inputType: 'number' },
                { key: 'rundenProSchicht', value: article.rundenProSchicht ?? '', inputType: 'number' },
                { key: 'zeitProHundert', value: article.zeitProHundert ?? '', inputType: 'number' },
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

            const saveBtn = document.createElement('button');
            saveBtn.className = 'primary';
            saveBtn.textContent = '💾';
            saveBtn.title = 'Speichern';
            saveBtn.addEventListener('click', () => {
                saveEditArticle(type, article._id, {
                    material: inputs.material.value.trim(),
                    beschreibung: inputs.beschreibung.value.trim(),
                    maschine: inputs.maschine.value.trim(),
                    kavitaet: inputs.kavitaet.value ? Number(inputs.kavitaet.value) : undefined,
                    rundenProSchicht: inputs.rundenProSchicht.value ? Number(inputs.rundenProSchicht.value) : undefined,
                    zeitProHundert: inputs.zeitProHundert.value ? Number(inputs.zeitProHundert.value) : undefined,
                });
            });

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = '✕';
            cancelBtn.title = 'Abbrechen';
            cancelBtn.addEventListener('click', () => {
                editingArticle = { type: null, id: null };
                renderDatabaseTable(type);
            });

            actionsTd.appendChild(saveBtn);
            actionsTd.appendChild(cancelBtn);
        }

        tr.appendChild(actionsTd);
        tbody.appendChild(tr);
    });
}

async function addDatabaseArticle(type) {
    const suffix = type === 'Elastomer' ? 'elastomer' : 'ptfe';
    const note = document.getElementById(`${suffix}ArticleNote`);
    const material = document.getElementById(`${suffix}NewMaterial`).value.trim();
    const beschreibung = document.getElementById(`${suffix}NewBeschreibung`).value.trim();
    const maschine = document.getElementById(`${suffix}NewMaschine`).value.trim();
    const kavitaetStr = document.getElementById(`${suffix}NewKavitaet`).value;
    const rundenStr = document.getElementById(`${suffix}NewRunden`).value;
    const zeitStr = document.getElementById(`${suffix}NewZeit`).value;

    note.style.color = '#b91c1c';
    if (!material) {
        note.textContent = 'Bitte Artikelnummer angeben.';
        return;
    }

    try {
        const res = await fetch(`${API_URL}/databases/${type}/articles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
                material,
                beschreibung,
                maschine,
                kavitaet: kavitaetStr ? Number(kavitaetStr) : undefined,
                rundenProSchicht: rundenStr ? Number(rundenStr) : undefined,
                zeitProHundert: zeitStr ? Number(zeitStr) : undefined,
            }),
        });
        const data = await res.json();
        if (!res.ok) {
            note.textContent = data.error || 'Anlegen fehlgeschlagen.';
            return;
        }
        plannerDBs[type] = [...(plannerDBs[type] || []), data];
        renderDatabaseTable(type);
        note.style.color = '#15803d';
        note.textContent = `✅ Artikel ${material} hinzugefügt.`;
        ['NewMaterial', 'NewBeschreibung', 'NewMaschine', 'NewKavitaet', 'NewRunden', 'NewZeit'].forEach(id => {
            const el = document.getElementById(`${suffix}${id}`);
            if (el) el.value = '';
        });
    } catch (err) {
        note.textContent = 'Anlegen fehlgeschlagen. Bitte erneut versuchen.';
    }
}

async function saveEditArticle(type, articleId, updates) {
    const suffix = type === 'Elastomer' ? 'elastomer' : 'ptfe';
    const note = document.getElementById(`${suffix}ArticleNote`);
    try {
        const res = await fetch(`${API_URL}/databases/${type}/articles/${articleId}`, {
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
        const list = plannerDBs[type] || [];
        const idx = list.findIndex(a => a._id === articleId);
        if (idx !== -1) list[idx] = data;
        editingArticle = { type: null, id: null };
        renderDatabaseTable(type);
        note.style.color = '#15803d';
        note.textContent = '✅ Artikel gespeichert.';
    } catch (err) {
        note.style.color = '#b91c1c';
        note.textContent = 'Speichern fehlgeschlagen. Bitte erneut versuchen.';
    }
}

async function deleteDatabaseArticle(type, articleId) {
    const suffix = type === 'Elastomer' ? 'elastomer' : 'ptfe';
    const note = document.getElementById(`${suffix}ArticleNote`);
    try {
        const res = await fetch(`${API_URL}/databases/${type}/articles/${articleId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) throw new Error();
        plannerDBs[type] = (plannerDBs[type] || []).filter(a => a._id !== articleId);
        renderDatabaseTable(type);
        note.style.color = '#15803d';
        note.textContent = 'Artikel gelöscht.';
    } catch (err) {
        note.style.color = '#b91c1c';
        note.textContent = 'Löschen fehlgeschlagen. Bitte erneut versuchen.';
    }
}

document.getElementById('elastomerAddArticleBtn')?.addEventListener('click', () => addDatabaseArticle('Elastomer'));
document.getElementById('ptfeAddArticleBtn')?.addEventListener('click', () => addDatabaseArticle('PTFE'));
document.getElementById('elastomerFilter')?.addEventListener('input', () => renderDatabaseTable('Elastomer'));
document.getElementById('ptfeFilter')?.addEventListener('input', () => renderDatabaseTable('PTFE'));

// Stückliste (BOM) direkt in der Weboberfläche pflegen - jede Zeile im
// Komponenten-Textfeld ist "Artikelnummer | Bezeichnung | Menge".
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

let editingMaterial = null;

function renderStuecklisteTable() {
    const tbody = document.getElementById('stuecklisteArticleTable');
    if (!tbody) return;

    const filterEl = document.getElementById('stuecklisteFilter');
    const filterVal = (filterEl?.value || '').toLowerCase().trim();
    const materialien = stueckliste.materialien || [];
    const filtered = filterVal
        ? materialien.filter(m => (m.material || '').toLowerCase().includes(filterVal) || (m.bezeichnung || '').toLowerCase().includes(filterVal))
        : materialien;

    tbody.innerHTML = '';
    filtered.forEach(m => {
        const isEditing = editingMaterial === m.material;
        const tr = document.createElement('tr');
        const actionsTd = document.createElement('td');
        actionsTd.className = 'table-actions';

        if (!isEditing) {
            const materialTd = document.createElement('td');
            materialTd.textContent = m.material;
            const bezTd = document.createElement('td');
            bezTd.textContent = m.bezeichnung;
            const kompTd = document.createElement('td');
            kompTd.style.whiteSpace = 'pre-line';
            kompTd.textContent = (m.komponenten || []).map(k => `${k.artikelnummer ? k.artikelnummer + ' - ' : ''}${k.bezeichnung}`).join('\n') || '–';
            tr.appendChild(materialTd);
            tr.appendChild(bezTd);
            tr.appendChild(kompTd);

            const editBtn = document.createElement('button');
            editBtn.textContent = '✏️';
            editBtn.title = 'Bearbeiten';
            editBtn.addEventListener('click', () => {
                editingMaterial = m.material;
                renderStuecklisteTable();
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
                deleteStücklisteMaterial(m.material);
            });

            actionsTd.appendChild(editBtn);
            actionsTd.appendChild(delBtn);
        } else {
            const materialTd = document.createElement('td');
            const materialInput = document.createElement('input');
            materialInput.className = 'table-input';
            materialInput.type = 'text';
            materialInput.value = m.material;
            materialTd.appendChild(materialInput);

            const bezTd = document.createElement('td');
            const bezInput = document.createElement('input');
            bezInput.className = 'table-input';
            bezInput.type = 'text';
            bezInput.value = m.bezeichnung;
            bezTd.appendChild(bezInput);

            const kompTd = document.createElement('td');
            const kompTextarea = document.createElement('textarea');
            kompTextarea.className = 'table-input';
            kompTextarea.rows = Math.max(2, (m.komponenten || []).length);
            kompTextarea.value = formatKomponentenText(m.komponenten);
            kompTd.appendChild(kompTextarea);

            tr.appendChild(materialTd);
            tr.appendChild(bezTd);
            tr.appendChild(kompTd);

            const saveBtn = document.createElement('button');
            saveBtn.className = 'primary';
            saveBtn.textContent = '💾';
            saveBtn.title = 'Speichern';
            saveBtn.addEventListener('click', () => {
                saveEditMaterial(m.material, {
                    material: materialInput.value.trim(),
                    bezeichnung: bezInput.value.trim(),
                    komponenten: parseKomponentenText(kompTextarea.value),
                });
            });

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = '✕';
            cancelBtn.title = 'Abbrechen';
            cancelBtn.addEventListener('click', () => {
                editingMaterial = null;
                renderStuecklisteTable();
            });

            actionsTd.appendChild(saveBtn);
            actionsTd.appendChild(cancelBtn);
        }

        tr.appendChild(actionsTd);
        tbody.appendChild(tr);
    });
}

async function addStücklisteMaterial() {
    const note = document.getElementById('stuecklisteArticleNote');
    const material = document.getElementById('stuecklisteNewMaterial').value.trim();
    const bezeichnung = document.getElementById('stuecklisteNewBezeichnung').value.trim();
    const komponenten = parseKomponentenText(document.getElementById('stuecklisteNewKomponenten').value);

    note.style.color = '#b91c1c';
    if (!material) {
        note.textContent = 'Bitte Artikelnummer angeben.';
        return;
    }

    try {
        const res = await fetch(`${API_URL}/stueckliste/materialien`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ material, bezeichnung, komponenten }),
        });
        const data = await res.json();
        if (!res.ok) {
            note.textContent = data.error || 'Anlegen fehlgeschlagen.';
            return;
        }
        stueckliste.materialien = [...(stueckliste.materialien || []), data];
        renderStuecklisteTable();
        note.style.color = '#15803d';
        note.textContent = `✅ Artikel ${material} hinzugefügt.`;
        document.getElementById('stuecklisteNewMaterial').value = '';
        document.getElementById('stuecklisteNewBezeichnung').value = '';
        document.getElementById('stuecklisteNewKomponenten').value = '';
    } catch (err) {
        note.textContent = 'Anlegen fehlgeschlagen. Bitte erneut versuchen.';
    }
}

async function saveEditMaterial(material, updates) {
    const note = document.getElementById('stuecklisteArticleNote');
    try {
        const res = await fetch(`${API_URL}/stueckliste/materialien/${encodeURIComponent(material)}`, {
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
        const idx = (stueckliste.materialien || []).findIndex(m => m.material === material);
        if (idx !== -1) stueckliste.materialien[idx] = data;
        editingMaterial = null;
        renderStuecklisteTable();
        note.style.color = '#15803d';
        note.textContent = '✅ Artikel gespeichert.';
    } catch (err) {
        note.style.color = '#b91c1c';
        note.textContent = 'Speichern fehlgeschlagen. Bitte erneut versuchen.';
    }
}

async function deleteStücklisteMaterial(material) {
    const note = document.getElementById('stuecklisteArticleNote');
    try {
        const res = await fetch(`${API_URL}/stueckliste/materialien/${encodeURIComponent(material)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) throw new Error();
        stueckliste.materialien = (stueckliste.materialien || []).filter(m => m.material !== material);
        renderStuecklisteTable();
        note.style.color = '#15803d';
        note.textContent = 'Artikel gelöscht.';
    } catch (err) {
        note.style.color = '#b91c1c';
        note.textContent = 'Löschen fehlgeschlagen. Bitte erneut versuchen.';
    }
}

document.getElementById('stuecklisteAddBtn')?.addEventListener('click', addStücklisteMaterial);
document.getElementById('stuecklisteFilter')?.addEventListener('input', renderStuecklisteTable);

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

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
    const naechsterFreierTag = {};
    MASCHINEN.forEach(m => naechsterFreierTag[m.id] = nextWeekday(new Date()));

    const columns = Object.keys(orders[0] || {});
    const artikelCol = findColumn(columns, 'artikel');
    const auftragsCol = findColumn(columns, 'auftrag');
    const mengeCol = findColumn(columns, 'menge');
    const bestellCol = findColumn(columns, 'bestellnummer');
    const lieferdatumCol = findColumn(columns, 'lieferdatum');

    const parsed = orders.map(o => {
        const artikelNr = (o[artikelCol] || '').toString().replace('#', '').trim();
        let match = plannerDBs.Elastomer?.find(a => a.material === artikelNr);
        let dbType = 'Elastomer';

        if (!match) {
            const ptfeMatch = plannerDBs.PTFE?.find(a => a.material === artikelNr);
            if (ptfeMatch) {
                match = ptfeMatch;
                dbType = 'PTFE';
            }
        }

        // Stückliste (SAP-BI) liefert die verbindliche Bezeichnung und die
        // Komponenten, die für diesen Artikel produziert werden müssen.
        const bomMatch = stueckliste.materialien.find(m => m.material === artikelNr);
        const komponenten = (bomMatch?.komponenten || []).map(k => ({
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
            beschreibung: bomMatch?.bezeichnung || match?.beschreibung || '',
            komponenten,
            menge: parseInt(o[mengeCol]) || 0,
            dbType,
            maschinenNamen: dbType === 'Elastomer'
                ? (classifyElastomerSubtyp(match?.maschine) ? [classifyElastomerSubtyp(match?.maschine)] : [])
                : classifyPtfeMaschinen(match?.maschine),
            kavitaet: match?.kavitaet || 1,
            rundenProSchicht: match?.rundenProSchicht || 1,
            zeitProHundert: match?.zeitProHundert || 0,
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
    // Ersetzt nur die Produktionsplanung - Aufträge in Endbearbeitung/Ausgeliefert bleiben
    // erhalten. Danach den kompletten (geteilten) Bestand neu laden, nicht nur die Antwort,
    // sonst würden diese Aufträge lokal aus boardOrders verschwinden.
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
            ? `ℹ️ ${data.uebersprungen} Auftrag${data.uebersprungen === 1 ? '' : 'e'} übersprungen - bereits in Endbearbeitung oder ausgeliefert.`
            : '';
    }
}

// Während ein Datums-Feld (Wareneingang/Warenausgang) fokussiert ist, nicht neu
// rendern - das würde den Input samt offenem Kalender-Picker ersetzen und ihn
// vorzeitig schließen, noch bevor man ein Datum auswählen konnte.
function isEditingDateInput() {
    const el = document.activeElement;
    return !!el && el.tagName === 'INPUT' && el.type === 'date';
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
            return `<div class="komponente-zeile"><span>${icon} ${escapeHtml(label)}</span><input type="date" class="komp-date" data-komp-index="${idx}" value="${toDateInputValue(k.wareneingang)}"></div>`;
        }).join('');
        komponentenHtml = `<div class="kanban-card-komponenten ${komplett ? 'komplett' : ''}">${zeilen}</div>`;
    }

    card.innerHTML = `<div class="kanban-card-title">${badge} ${escapeHtml(order.artikelnummer)}</div>${desc}${bestellung}${parallel}${komponentenHtml}<div class="kanban-card-meta">Auftrag ${escapeHtml(order.auftragsnummer)} · ${order.menge} Stk · ${(order.bearbeitungsMin / 60).toFixed(1)}h · ${order.schichten} Sch.</div>`;

    card.querySelectorAll('.komp-date').forEach(input => {
        input.draggable = false;
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('change', (e) => {
            e.stopPropagation();
            setKomponenteDatum(order._id, parseInt(input.dataset.kompIndex), input.value);
        });
    });

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

function renderBoard(dbType) {
    const suffix = DBTYPE_SUFFIX[dbType];
    const maschinenListe = MASCHINEN.filter(m => m.type === dbType);
    const produktionOrders = boardOrders.filter(o => (!o.phase || o.phase === 'produktion') && o.dbType === dbType);

    if (produktionOrders.length === 0) {
        document.getElementById('machineGrid' + suffix).innerHTML = '';
        document.getElementById('kanbanBoard' + suffix).innerHTML = '<p style="color: #64748b;">Noch keine Aufträge geplant. Lade im Auftragsimport eine Aufträge-Excel hoch.</p>';
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

    // Nur produzierbare Aufträge (alle Komponenten da) im Zeitplan zeigen.
    const mitTerminen = orders.filter(o => o.startDatum && o.endDatum && istKomponentenBereit(o));
    const tage = computeTimelineTage(mitTerminen);
    const wochen = groupByWeek(tage);

    grid.innerHTML = '';
    grid.style.gridTemplateColumns = `40px 46px repeat(${maschinenListe.length}, 150px)`;
    grid.style.gridTemplateRows = `32px repeat(${tage.length}, 78px)`;

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

            const bar = document.createElement('div');
            bar.className = `gantt-bar card-${o.status}`;
            // Artikelnummer, Auftragsnummer und Bezeichnung als eigene Zeilen/Zellen -
            // nicht mehr zusammengedrängt, damit die Bezeichnung lesbar bleibt.
            bar.innerHTML = `
                <div class="gantt-bar-zelle gantt-bar-artikel">${escapeHtml(o.artikelnummer)}</div>
                <div class="gantt-bar-zelle gantt-bar-auftrag">Auftrag ${escapeHtml(o.auftragsnummer)}</div>
                ${o.beschreibung ? `<div class="gantt-bar-zelle gantt-bar-desc">${escapeHtml(o.beschreibung)}</div>` : ''}
            `;
            bar.title = `${o.artikelnummer}${o.beschreibung ? ' - ' + o.beschreibung : ''}\nAuftrag ${o.auftragsnummer}\n${formatDateShort(o.startDatum)} – ${formatDateShort(o.endDatum)}\nZiehen zum Verschieben`;
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
function getMachineNextFree(maschineId) {
    const relevant = boardOrders.filter(o =>
        o.phase === 'produktion' && o.endDatum && (o.maschineId === maschineId || o.maschineId2 === maschineId));
    if (relevant.length === 0) return nextWeekday(new Date());
    const maxEnd = relevant.reduce((max, o) => {
        const d = new Date(o.endDatum);
        return d > max ? d : max;
    }, new Date(0));
    return addWorkdays(maxEnd, 1);
}

async function handleManualAddOrder() {
    const note = document.getElementById('manualAddNote');
    const auftragsnummer = document.getElementById('manualAuftragsnummer').value.trim();
    const artikelnummer = document.getElementById('manualArtikelnummer').value.trim();
    const menge = parseInt(document.getElementById('manualMenge').value) || 0;
    const bestellnummer = document.getElementById('manualBestellnummer').value.trim();
    const lieferdatumStr = document.getElementById('manualLieferdatum').value;

    note.style.color = '#b91c1c';
    if (!auftragsnummer || !artikelnummer || !menge) {
        note.textContent = 'Bitte Auftragsnummer, Artikelnummer und Menge angeben.';
        return;
    }

    let match = plannerDBs.Elastomer?.find(a => a.material === artikelnummer);
    let dbType = 'Elastomer';
    if (!match) {
        const ptfeMatch = plannerDBs.PTFE?.find(a => a.material === artikelnummer);
        if (ptfeMatch) {
            match = ptfeMatch;
            dbType = 'PTFE';
        }
    }

    const bomMatch = stueckliste.materialien.find(m => m.material === artikelnummer);
    const komponenten = (bomMatch?.komponenten || []).map(k => ({
        artikelnummer: k.artikelnummer,
        bezeichnung: k.bezeichnung,
        wareneingang: null,
    }));
    if (dbType === 'Elastomer') {
        komponenten.push({ artikelnummer: '', bezeichnung: 'Werkzeug', wareneingang: null });
    }

    const maschinenNamen = dbType === 'Elastomer'
        ? (classifyElastomerSubtyp(match?.maschine) ? [classifyElastomerSubtyp(match?.maschine)] : [])
        : classifyPtfeMaschinen(match?.maschine);

    const kavitaet = match?.kavitaet || 1;
    const rundenProSchicht = match?.rundenProSchicht || 1;
    const zeitProHundert = match?.zeitProHundert || 0;

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
        beschreibung: bomMatch?.bezeichnung || match?.beschreibung || '',
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
    order.komponenten[idx].wareneingang = dateStr ? new Date(dateStr).toISOString() : null;
    renderAll();

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
        loadDatabaseStatus();
        loadStueckliste();
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
document.querySelectorAll('.gantt-wrapper').forEach(enableHorizontalWheelScroll);

initSession();
