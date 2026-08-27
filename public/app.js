const API_URL = '/api';
let token = localStorage.getItem('token');
let currentUser = null;
let converterData = [];
let plannerDBs = { Elastomer: null, PTFE: null };
let stueckliste = { materialien: [] };

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

function showPage(page) {
    if (ADMIN_ONLY_PAGES.includes(page) && currentUser?.role !== 'admin') {
        page = 'board';
    }
    document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
    document.getElementById(page + 'Page').classList.remove('hidden');
    document.querySelectorAll('.sidebar-item[data-page]').forEach(el => {
        el.classList.toggle('active', el.getAttribute('data-page') === page);
    });

    if (page === 'board' || page === 'endbearbeitung' || page === 'ausgeliefert') loadExistingBoard();
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
    let current = null;
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i] || [];
        const [material, bezeichnung, , kompArtikel, kompBezeichnung, menge] = row;
        // Manche Exporte lassen Material nur in der ersten Komponentenzeile stehen
        // (danach leer), andere wiederholen es in jeder Zeile - beides abfangen.
        const materialStr = (material !== undefined && material !== null && material !== '')
            ? material.toString().trim() : null;
        if (materialStr && (!current || current.material !== materialStr)) {
            current = {
                material: materialStr,
                bezeichnung: (bezeichnung ?? '').toString().trim(),
                komponenten: [],
            };
            materialien.push(current);
        }
        if (current && kompArtikel !== undefined && kompArtikel !== null && kompArtikel !== '') {
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

        plannerDBs[type] = articles;
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
        });
    } catch (err) {
        // Datenbanken konnten nicht geladen werden, Status bleibt leer
    }
}

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

async function fetchBoard() {
    try {
        const res = await fetch(`${API_URL}/orders`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) return;
        boardOrders = await res.json();
        if (!isDragging) renderAll();
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
    renderBoard();
    renderEndbearbeitung();
    renderAusgeliefert();
}

function renderBoard() {
    const produktionOrders = boardOrders.filter(o => !o.phase || o.phase === 'produktion');

    if (produktionOrders.length === 0) {
        document.getElementById('machineGrid').innerHTML = '';
        document.getElementById('kanbanBoard').innerHTML = '<p style="color: #64748b;">Noch keine Aufträge geplant. Lade im Auftragsimport eine Aufträge-Excel hoch.</p>';
        renderGantt([]);
        return;
    }

    renderGantt(produktionOrders);

    const machineGrid = document.getElementById('machineGrid');
    machineGrid.innerHTML = '';
    MASCHINEN.forEach(m => {
        const cards = produktionOrders.filter(o => o.maschineId === m.id || o.maschineId2 === m.id);
        let freiAb = nextWeekday(new Date());
        cards.forEach(o => {
            if (!o.endDatum) return;
            const nachDiesemAuftrag = addWorkdays(new Date(o.endDatum), 1);
            if (nachDiesemAuftrag > freiAb) freiAb = nachDiesemAuftrag;
        });
        machineGrid.innerHTML += `<div class="machine-card"><div class="machine-name">${m.name}</div><div class="machine-percent" style="font-size: 20px;">${cards.length}</div><div style="font-size: 11px; color: #64748b;">Auftr${cards.length === 1 ? 'ag' : 'äge'} · frei ab ${formatDateShort(freiAb)}</div></div>`;
    });

    const board = document.getElementById('kanbanBoard');
    board.innerHTML = '';
    const spalten = [...MASCHINEN, { id: null, name: 'Nicht zugewiesen' }];

    spalten.forEach(spalte => {
        const col = document.createElement('div');
        col.className = 'kanban-column';
        col.dataset.maschineId = spalte.id ?? '';

        // Aufträge, bei denen alle Komponenten da sind, stehen oben in der Spalte -
        // innerhalb der beiden Gruppen bleibt die manuelle Reihenfolge (position) erhalten.
        const cards = produktionOrders
            .filter(o => spalte.id === null ? !o.maschineId : (o.maschineId === spalte.id || o.maschineId2 === spalte.id))
            .sort((a, b) => {
                const bereitA = istKomponentenBereit(a) ? 0 : 1;
                const bereitB = istKomponentenBereit(b) ? 0 : 1;
                if (bereitA !== bereitB) return bereitA - bereitB;
                if (a.lieferdatum && b.lieferdatum) {
                    const diff = new Date(a.lieferdatum) - new Date(b.lieferdatum);
                    if (diff !== 0) return diff;
                } else if (a.lieferdatum || b.lieferdatum) {
                    return a.lieferdatum ? -1 : 1;
                }
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
                draggedOrderId = order._id;
                isDragging = true;
                card.classList.add('dragging');
            });
            handle.addEventListener('dragend', () => {
                isDragging = false;
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

    const statusEl = document.getElementById('boardSyncStatus');
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

function renderGantt(orders) {
    const grid = document.getElementById('ganttGrid');
    if (!grid) return;

    // Nur produzierbare Aufträge (alle Komponenten da) im Zeitplan zeigen.
    const mitTerminen = orders.filter(o => o.startDatum && o.endDatum && istKomponentenBereit(o));
    const tage = computeTimelineTage(mitTerminen);
    const wochen = groupByWeek(tage);

    grid.innerHTML = '';
    grid.style.gridTemplateColumns = `40px 46px repeat(${MASCHINEN.length}, 92px)`;
    grid.style.gridTemplateRows = `32px repeat(${tage.length}, 30px)`;

    const ecke = document.createElement('div');
    ecke.className = 'gantt-corner';
    ecke.style.gridColumn = '1 / span 2';
    ecke.style.gridRow = '1 / span 1';
    grid.appendChild(ecke);

    MASCHINEN.forEach((m, mi) => {
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

        MASCHINEN.forEach((m, mi) => {
            const cell = document.createElement('div');
            cell.className = 'gantt-cell';
            cell.style.gridColumn = `${mi + 3} / span 1`;
            cell.style.gridRow = `${i + 2} / span 1`;
            grid.appendChild(cell);
        });
    });

    mitTerminen.forEach(o => {
        [o.maschineId, o.maschineId2].filter(Boolean).forEach(maschineId => {
            const mi = MASCHINEN.findIndex(m => m.id === maschineId);
            if (mi === -1) return;
            const start = new Date(o.startDatum);
            const ende = new Date(o.endDatum);
            const startIdx = tage.findIndex(t => isSameDay(t, start));
            const endIdx = tage.findIndex(t => isSameDay(t, ende));
            if (startIdx === -1 || endIdx === -1) return;

            const bar = document.createElement('div');
            bar.className = `gantt-bar card-${o.status}`;
            bar.textContent = `${o.artikelnummer} · ${o.auftragsnummer}`;
            bar.title = `${o.artikelnummer}${o.beschreibung ? ' - ' + o.beschreibung : ''}\nAuftrag ${o.auftragsnummer}\n${formatDateShort(o.startDatum)} – ${formatDateShort(o.endDatum)}`;
            bar.style.gridColumn = `${mi + 3} / span 1`;
            bar.style.gridRow = `${startIdx + 2} / span ${endIdx - startIdx + 1}`;
            grid.appendChild(bar);
        });
    });
}

function renderEndbearbeitung() {
    const liste = document.getElementById('endbearbeitungListe');
    if (!liste) return;
    const cards = boardOrders.filter(o => o.phase === 'endbearbeitung');
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

function renderAusgeliefert() {
    const liste = document.getElementById('ausgeliefertListe');
    if (!liste) return;
    const cards = boardOrders
        .filter(o => o.phase === 'ausgeliefert')
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
    renderAusgeliefert();

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

async function moveOrder(orderId, maschineId, position) {
    // Die Maschinenzuordnung aus der Datenbank ist nur eine Empfehlung für die
    // Auto-Planung - manuelles Verschieben auf jede Maschine ist immer erlaubt.
    const order = boardOrders.find(o => o._id === orderId);
    if (!order) return;

    order.maschineId = maschineId;
    order.position = position;
    order.status = maschineId ? 'geplant' : 'ausstehend';
    renderBoard();

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

function exportPlannerExcel() {
    const data = boardOrders.filter(r => !r.phase || r.phase === 'produktion').map(r => ({
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
    XLSX.writeFile(wb, 'Auftragsplanung.xlsx');
}

document.getElementById('loginBtn')?.addEventListener('click', handleLogin);
document.getElementById('registerBtn')?.addEventListener('click', handleRegister);
document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);
document.getElementById('exportBtn')?.addEventListener('click', exportPlannerExcel);
document.getElementById('goToBoardBtn')?.addEventListener('click', () => showPage('board'));
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

initSession();
