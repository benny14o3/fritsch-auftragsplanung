const API_URL = '/api/shopfloor';
let token = localStorage.getItem('shopfloorToken');
let currentUser = JSON.parse(localStorage.getItem('shopfloorUser') || 'null');

const FEHLERARTEN = ['Lunker', 'Grat', 'Verschmutzung', 'Maßabweichung', 'Oberflächenfehler', 'Einfallstelle', 'Bruch/Riss', 'Verfärbung', 'Sonstiges'];

let boardOrders = [];
let activeTab = 'Elastomer';
let activeOrderId = null;
let boardPollTimer = null;
let detailPollTimer = null;

function authHeaders() {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

function showScreen(loggedIn) {
    document.getElementById('loginScreen').classList.toggle('hidden', loggedIn);
    document.getElementById('appScreen').classList.toggle('hidden', !loggedIn);
}

// --- Login ---

document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('loginPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
    const kuerzel = document.getElementById('loginKuerzel').value.trim();
    const pin = document.getElementById('loginPin').value.trim();
    const errEl = document.getElementById('loginError');
    errEl.classList.add('hidden');
    if (!kuerzel || !pin) return;
    try {
        const res = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kuerzel, pin }),
        });
        const data = await res.json();
        if (!res.ok) { errEl.textContent = data.error || 'Anmeldung fehlgeschlagen'; errEl.classList.remove('hidden'); return; }
        token = data.token;
        currentUser = data.user;
        localStorage.setItem('shopfloorToken', token);
        localStorage.setItem('shopfloorUser', JSON.stringify(currentUser));
        document.getElementById('loginPin').value = '';
        init();
    } catch (err) {
        errEl.textContent = 'Verbindung fehlgeschlagen';
        errEl.classList.remove('hidden');
    }
}

document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('shopfloorToken');
    localStorage.removeItem('shopfloorUser');
    token = null;
    stopPolling();
    showScreen(false);
});

// --- Board ---

document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeTab = tab.dataset.type;
        renderBoard();
    });
});

document.getElementById('refreshBtn').addEventListener('click', () => {
    if (activeOrderId) fetchDetail(activeOrderId); else fetchBoard();
});

document.getElementById('backBtn').addEventListener('click', () => {
    activeOrderId = null;
    document.getElementById('detailView').classList.add('hidden');
    document.getElementById('boardView').classList.remove('hidden');
    document.getElementById('topbarTitle').textContent = 'Shopfloor';
    stopDetailPolling();
    fetchBoard();
});

async function fetchBoard() {
    try {
        const res = await fetch(`${API_URL}/orders`, { headers: authHeaders() });
        if (res.status === 401) return handleAuthExpired();
        boardOrders = await res.json();
        renderBoard();
    } catch (err) { /* stiller Retry beim nächsten Poll */ }
}

function fortschritt(order) {
    const stationen = order.laufzettel || [];
    const done = stationen.filter(s => s.erledigt).length;
    return { done, total: stationen.length };
}

function renderBoard() {
    const list = document.getElementById('orderList');
    const gefiltert = boardOrders.filter(o => o.dbType === activeTab);
    if (gefiltert.length === 0) {
        list.innerHTML = '<div class="empty-note">Keine laufenden Aufträge in diesem Bereich.</div>';
        return;
    }
    list.innerHTML = '';
    gefiltert.forEach(order => {
        const { done, total } = fortschritt(order);
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const card = document.createElement('div');
        card.className = `order-card status-${order.phase}`;
        card.innerHTML = `
            <div class="row1">
                <span class="artikel">${order.artikelnummer || '–'}</span>
                <span class="auftrag">${order.auftragsnummer || ''}</span>
            </div>
            <div class="desc">${order.beschreibung || ''}</div>
            <div class="progress-row">
                <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
                <div class="progress-label">${done}/${total} Stationen</div>
            </div>
        `;
        card.addEventListener('click', () => openDetail(order._id));
        list.appendChild(card);
    });
}

function stopPolling() {
    clearInterval(boardPollTimer);
    stopDetailPolling();
}

function stopDetailPolling() {
    clearInterval(detailPollTimer);
    detailPollTimer = null;
}

// --- Detail ---

async function openDetail(orderId) {
    activeOrderId = orderId;
    document.getElementById('boardView').classList.add('hidden');
    document.getElementById('detailView').classList.remove('hidden');
    document.getElementById('topbarTitle').textContent = 'Auftragsdetail';
    await fetchDetail(orderId);
    clearInterval(detailPollTimer);
    detailPollTimer = setInterval(() => fetchDetail(orderId), 8000);
}

let currentDetail = null;

async function fetchDetail(orderId) {
    try {
        const res = await fetch(`${API_URL}/orders/${orderId}`, { headers: authHeaders() });
        if (res.status === 401) return handleAuthExpired();
        if (!res.ok) return;
        currentDetail = await res.json();
        renderDetail();
    } catch (err) { /* stiller Retry beim nächsten Poll */ }
}

function renderDetail() {
    const { order, zeichnung, plp, erstfreigabeErforderlich, erstfreigabeOffen } = currentDetail;
    document.getElementById('detailTitle').textContent = `${order.artikelnummer || '–'} · ${order.auftragsnummer || ''}`;
    document.getElementById('detailSub').textContent = `${order.beschreibung || ''} · Menge ${order.menge || '–'}`;

    renderZeichnung(zeichnung);
    renderKomponenten(order);
    renderPlp(plp);
    renderErstfreigabe(order, plp, erstfreigabeErforderlich, erstfreigabeOffen);

    if (erstfreigabeOffen) {
        document.getElementById('laufzettelBox').innerHTML = '<div class="locked-note">🔒 Erstfreigabe steht noch aus - Prozessbegleitschein erst danach nutzbar.</div>';
        document.getElementById('massungenBox').innerHTML = '';
        document.getElementById('fehlerSummary').innerHTML = '';
        document.getElementById('fehlerGrid').innerHTML = '';
        document.getElementById('fehlerLog').innerHTML = '<div class="locked-note">🔒 Erstfreigabe steht noch aus - Fehlersammelkarte erst danach nutzbar.</div>';
    } else {
        renderLaufzettel(order);
        renderMassungen(order, plp);
        renderFehler(order);
    }
}

function renderKomponenten(order) {
    const box = document.getElementById('komponentenBox');
    const komponenten = order.komponenten || [];
    if (komponenten.length === 0) {
        box.innerHTML = '<div class="no-doc">Keine Komponenten hinterlegt.</div>';
        return;
    }
    box.innerHTML = komponenten.map(k => `
        <div class="komponente-info-row">
            <span class="komponente-info-name">${k.artikelnummer ? `${k.artikelnummer} - ` : ''}${k.bezeichnung || ''}</span>
            <span class="komponente-info-charge">Charge: <b>${k.charge || '–'}</b></span>
        </div>
    `).join('');
}

function renderZeichnung(zeichnung) {
    const box = document.getElementById('zeichnungBox');
    if (!zeichnung || !zeichnung.data) {
        box.innerHTML = '<div class="no-doc">Keine Zeichnung hinterlegt.</div>';
        return;
    }
    const dataUrl = `data:${zeichnung.mimeType};base64,${zeichnung.data}`;
    const isImage = zeichnung.mimeType.startsWith('image/');
    box.innerHTML = `
        <div class="zeichnung-preview">
            ${isImage ? `<img src="${dataUrl}" alt="Zeichnung">` : ''}
            <div><a href="${dataUrl}" target="_blank" rel="noopener">${zeichnung.filename} öffnen ↗</a></div>
        </div>
    `;
}

function formatToleranz(p) {
    if (p.toleranzMin == null && p.toleranzMax == null) return '–';
    return `${p.toleranzMin ?? '–'} … ${p.toleranzMax ?? '–'}${p.einheit ? ' ' + p.einheit : ''}`;
}

function renderPlp(plp) {
    const box = document.getElementById('plpBox');
    if (!plp || plp.length === 0) {
        box.innerHTML = '<div class="no-doc">Kein Produktionslenkungsplan hinterlegt.</div>';
        return;
    }
    box.innerHTML = `
        <div style="overflow-x:auto;">
        <table class="plp-table">
            <thead><tr><th>Typ</th><th>Bezeichnung</th><th>Sollwert</th><th>Toleranz</th><th>Prüfmittel</th><th>Häufigkeit</th></tr></thead>
            <tbody>
                ${plp.map(r => `<tr>
                    <td>${r.typ === 'masspruefung' ? 'Maßprüfung' : 'Prozess'}</td>
                    <td>${r.bezeichnung || ''}</td>
                    <td>${r.typ === 'masspruefung' ? (r.sollwert ?? '–') + (r.einheit ? ' ' + r.einheit : '') : '–'}</td>
                    <td>${r.typ === 'masspruefung' ? formatToleranz(r) : '–'}</td>
                    <td>${r.pruefmittel || '–'}</td>
                    <td>${r.pruefhaeufigkeit || '–'}</td>
                </tr>`).join('')}
            </tbody>
        </table>
        </div>
    `;
}

function renderLaufzettel(order) {
    const box = document.getElementById('laufzettelBox');
    const punkte = order.laufzettel || [];
    if (punkte.length === 0) {
        box.innerHTML = '<div class="no-doc">Keine Prozessschritte hinterlegt.</div>';
        return;
    }
    box.innerHTML = '';
    punkte.forEach(s => {
        const row = document.createElement('div');
        row.className = 'station-row';
        row.innerHTML = `
            <div>
                <div class="station-name">${s.bezeichnung}</div>
                <div class="station-meta">${s.erledigt ? `${s.kuerzel} · ${new Date(s.zeitpunkt).toLocaleString('de-DE')}` : 'offen'}</div>
            </div>
            <button class="station-toggle ${s.erledigt ? 'done' : ''}">${s.erledigt ? '✓' : ''}</button>
        `;
        row.querySelector('button').addEventListener('click', () => toggleStation(s.pruefpunktId, !s.erledigt));
        box.appendChild(row);
    });
}

async function toggleStation(pruefpunktId, erledigt) {
    try {
        await fetch(`${API_URL}/orders/${activeOrderId}/laufzettel/${pruefpunktId}`, {
            method: 'PATCH',
            headers: authHeaders(),
            body: JSON.stringify({ erledigt }),
        });
        fetchDetail(activeOrderId);
    } catch (err) { /* ignore */ }
}

// --- Erstfreigabe (Erstmusterprüfung) ---

function berechneIoNioClient(istwert, toleranzMin, toleranzMax) {
    const hatMin = toleranzMin !== undefined && toleranzMin !== null;
    const hatMax = toleranzMax !== undefined && toleranzMax !== null;
    if (hatMin && istwert < toleranzMin) return 'n.i.O.';
    if (hatMax && istwert > toleranzMax) return 'n.i.O.';
    return 'i.O.';
}

function renderErstfreigabe(order, plp, erforderlich, offen) {
    const card = document.getElementById('erstfreigabeCard');
    const box = document.getElementById('erstfreigabeBox');
    if (!erforderlich) {
        card.classList.add('hidden');
        return;
    }
    card.classList.remove('hidden');

    if (!offen) {
        const ef = order.erstfreigabe;
        box.innerHTML = `<div class="erstfreigabe-banner">✅ Erstfreigabe erteilt am ${new Date(ef.zeitpunkt).toLocaleString('de-DE')} von ${ef.kuerzel}</div>`;
        return;
    }

    const massPunkte = plp.filter(p => p.typ === 'masspruefung');
    box.innerHTML = `
        <div class="locked-note" style="margin-bottom: 14px;">🔒 Vor Serienproduktion müssen alle Maßprüfungen i.O. sein und die Erstfreigabe erteilt werden.</div>
        ${massPunkte.map(p => `
            <div class="pruefpunkt-row">
                <div class="pruefpunkt-head">
                    <span class="pruefpunkt-name">${p.bezeichnung}</span>
                    <span class="pruefpunkt-soll">Soll ${p.sollwert ?? '–'}${p.einheit ? ' ' + p.einheit : ''} (${formatToleranz(p)})</span>
                </div>
                <div class="pruefpunkt-eingabe">
                    <input type="number" step="any" inputmode="decimal" data-pruefpunkt-id="${p._id}" placeholder="Istwert">
                    <span class="io-badge" data-badge-id="${p._id}"></span>
                </div>
            </div>
        `).join('')}
        <button class="btn btn-primary erstfreigabe-submit" id="erstfreigabeSubmitBtn" ${massPunkte.length === 0 ? '' : 'disabled'}>Erstfreigabe erteilen</button>
    `;

    const inputs = box.querySelectorAll('input[data-pruefpunkt-id]');
    const submitBtn = document.getElementById('erstfreigabeSubmitBtn');

    function pruefeVollstaendig() {
        if (massPunkte.length === 0) { submitBtn.disabled = false; return; }
        let alleIo = true;
        inputs.forEach(input => {
            const p = massPunkte.find(mp => String(mp._id) === input.dataset.pruefpunktId);
            const badge = box.querySelector(`[data-badge-id="${p._id}"]`);
            if (input.value === '') { badge.textContent = ''; badge.className = 'io-badge'; alleIo = false; return; }
            const ioNio = berechneIoNioClient(Number(input.value), p.toleranzMin, p.toleranzMax);
            badge.textContent = ioNio;
            badge.className = `io-badge ${ioNio === 'i.O.' ? 'ok' : 'nok'}`;
            if (ioNio === 'n.i.O.') alleIo = false;
        });
        submitBtn.disabled = !alleIo;
    }
    inputs.forEach(input => input.addEventListener('input', pruefeVollstaendig));
    pruefeVollstaendig();

    submitBtn.addEventListener('click', async () => {
        const messungen = massPunkte.map(p => ({
            pruefpunktId: p._id,
            istwert: Number(box.querySelector(`input[data-pruefpunkt-id="${p._id}"]`).value),
        }));
        submitBtn.disabled = true;
        try {
            const res = await fetch(`${API_URL}/orders/${activeOrderId}/erstfreigabe`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({ messungen }),
            });
            const data = await res.json();
            if (!res.ok) { alert(data.error || 'Erstfreigabe fehlgeschlagen'); submitBtn.disabled = false; return; }
            fetchDetail(activeOrderId);
        } catch (err) {
            submitBtn.disabled = false;
        }
    });
}

// --- Maßprüfungen auf der Fehlersammelkarte ---

function renderMassungen(order, plp) {
    const box = document.getElementById('massungenBox');
    const massPunkte = (plp || []).filter(p => p.typ === 'masspruefung');
    if (massPunkte.length === 0) { box.innerHTML = ''; return; }

    const massungen = order.massungen || [];
    box.innerHTML = `<h4 style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; color: #64748b; margin-bottom: 10px;">Maßprüfungen</h4>` + massPunkte.map(p => {
        const log = massungen.filter(m => String(m.pruefpunktId) === String(p._id)).slice().reverse();
        return `
            <div class="pruefpunkt-row">
                <div class="pruefpunkt-head">
                    <span class="pruefpunkt-name">${p.bezeichnung}</span>
                    <span class="pruefpunkt-soll">Soll ${p.sollwert ?? '–'}${p.einheit ? ' ' + p.einheit : ''} (${formatToleranz(p)})</span>
                </div>
                <div class="pruefpunkt-eingabe">
                    <input type="number" step="any" inputmode="decimal" data-massung-pruefpunkt="${p._id}" placeholder="Istwert">
                    <button data-massung-add="${p._id}">Erfassen</button>
                </div>
                <div class="massung-log">
                    ${log.map(m => `
                        <div class="massung-log-row">
                            <span>${m.istwert}${m.einheit ? ' ' + m.einheit : ''} <span class="io-badge ${m.ioNio === 'i.O.' ? 'ok' : 'nok'}">${m.ioNio}</span> · ${m.kuerzel} · ${new Date(m.zeitpunkt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
                            <button data-massung-del="${m._id}">✕</button>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }).join('');

    box.querySelectorAll('[data-massung-add]').forEach(btn => {
        btn.addEventListener('click', () => {
            const pruefpunktId = btn.dataset.massungAdd;
            const input = box.querySelector(`input[data-massung-pruefpunkt="${pruefpunktId}"]`);
            if (input.value === '') return;
            addMassung(pruefpunktId, Number(input.value));
        });
    });
    box.querySelectorAll('[data-massung-del]').forEach(btn => {
        btn.addEventListener('click', () => removeMassung(btn.dataset.massungDel));
    });
}

async function addMassung(pruefpunktId, istwert) {
    try {
        await fetch(`${API_URL}/orders/${activeOrderId}/massung`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ pruefpunktId, istwert }),
        });
        fetchDetail(activeOrderId);
    } catch (err) { /* ignore */ }
}

async function removeMassung(entryId) {
    try {
        await fetch(`${API_URL}/orders/${activeOrderId}/massung/${entryId}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        fetchDetail(activeOrderId);
    } catch (err) { /* ignore */ }
}

function renderFehler(order) {
    const entries = order.fehlersammelkarte || [];

    const summaryBox = document.getElementById('fehlerSummary');
    const counts = {};
    entries.forEach(e => { counts[e.fehlerart] = (counts[e.fehlerart] || 0) + 1; });
    summaryBox.innerHTML = Object.keys(counts).length === 0
        ? ''
        : Object.entries(counts).map(([art, n]) => `<span>${art}: ${n}</span>`).join('');

    const grid = document.getElementById('fehlerGrid');
    grid.innerHTML = '';
    FEHLERARTEN.forEach(art => {
        const btn = document.createElement('button');
        btn.className = 'fehler-btn';
        btn.textContent = art;
        btn.addEventListener('click', () => addFehler(art));
        grid.appendChild(btn);
    });

    const log = document.getElementById('fehlerLog');
    log.innerHTML = entries.slice().reverse().map(e => `
        <div class="fehler-log-row">
            <span>${e.fehlerart} · ${e.kuerzel} · ${new Date(e.zeitpunkt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
            <button data-id="${e._id}">✕</button>
        </div>
    `).join('');
    log.querySelectorAll('button[data-id]').forEach(btn => {
        btn.addEventListener('click', () => removeFehler(btn.dataset.id));
    });
}

async function addFehler(fehlerart) {
    try {
        await fetch(`${API_URL}/orders/${activeOrderId}/fehler`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ fehlerart }),
        });
        fetchDetail(activeOrderId);
    } catch (err) { /* ignore */ }
}

async function removeFehler(entryId) {
    try {
        await fetch(`${API_URL}/orders/${activeOrderId}/fehler/${entryId}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        fetchDetail(activeOrderId);
    } catch (err) { /* ignore */ }
}

function handleAuthExpired() {
    localStorage.removeItem('shopfloorToken');
    localStorage.removeItem('shopfloorUser');
    token = null;
    stopPolling();
    showScreen(false);
}

// --- Init ---

function init() {
    if (!token) { showScreen(false); return; }
    showScreen(true);
    document.getElementById('userGreeting').textContent = currentUser ? `${currentUser.name} (${currentUser.kuerzel})` : '';
    fetchBoard();
    clearInterval(boardPollTimer);
    boardPollTimer = setInterval(() => { if (!activeOrderId) fetchBoard(); }, 8000);
}

init();
