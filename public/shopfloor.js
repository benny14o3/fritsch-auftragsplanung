const API_URL = '/api/shopfloor';
let token = localStorage.getItem('shopfloorToken');
let currentUser = JSON.parse(localStorage.getItem('shopfloorUser') || 'null');

// Fester Fehlerarten-Katalog von der physischen Fehlersammelkarte (FSK) -
// zusammengeführt aus den beiden Kartenvarianten "FSK allgemein Vorderseite"
// und "FSK Prozeß-Status" (die Vorderseite hat statt "Zusatzteil/Feder" zwei
// artikelspezifische Zeilen wie Werkzeugtemperatur/Maßüberprüfung, die schon
// über die Prüfpunkte/Massungen je Artikel abgedeckt sind, siehe renderMassungen).
const FEHLERARTEN = ['Luft-, Fließfehler', 'Wkzg.-Verschmutzung', 'Blasen', 'Material fehlt', 'Zusatzteil/Feder', 'Dichtkantenfehler', 'Stechfehler', 'Doppelschnitt', 'Fremdkörper/Stippen', 'Werkzeugfehler', 'Abfall', 'Platzer', 'Blech n.i.O.', 'Rohling', 'Sonstige'];

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
    if (activeOrderId) fetchDetail(activeOrderId);
    else if (!document.getElementById('maschinenView').classList.contains('hidden')) openMaschinenModus();
    else if (!document.getElementById('produktionView').classList.contains('hidden')) fetchProduktion();
    else fetchBoard();
});

document.getElementById('backBtn').addEventListener('click', () => {
    activeOrderId = null;
    document.getElementById('detailView').classList.add('hidden');
    stopDetailPolling();
    if (detailHerkunft === 'produktion') { openProduktion(); return; }
    if (detailHerkunft === 'maschine') { openMaschinenModus(); return; }
    document.getElementById('boardView').classList.remove('hidden');
    document.getElementById('topbarTitle').textContent = 'Shopfloor';
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
    clearInterval(maschinenPollTimer);
    maschinenPollTimer = null;
    stopDetailPolling();
    stopProduktionPolling();
}

// --- Aktuelle Produktion (nur Formgebung) ---
// Werker wählen den laufenden Auftrag, tragen gefahrene Runden ein - die
// Stückzahl wird serverseitig aus Runden x Kavität berechnet, nicht hier.

let produktionOrders = [];
let produktionPollTimer = null;
let produktionExpandedId = null;

function stopProduktionPolling() {
    clearInterval(produktionPollTimer);
    produktionPollTimer = null;
}

document.getElementById('produktionBtn').addEventListener('click', openProduktion);
document.getElementById('produktionBackBtn').addEventListener('click', closeProduktion);

async function openProduktion() {
    activeOrderId = null;
    stopDetailPolling();
    clearInterval(maschinenPollTimer);
    maschinenPollTimer = null;
    document.getElementById('maschinenView').classList.add('hidden');
    document.getElementById('boardView').classList.add('hidden');
    document.getElementById('detailView').classList.add('hidden');
    document.getElementById('produktionView').classList.remove('hidden');
    document.getElementById('topbarTitle').textContent = 'Produktion';
    produktionExpandedId = null;
    await fetchProduktion();
    clearInterval(produktionPollTimer);
    produktionPollTimer = setInterval(fetchProduktion, 8000);
}

function closeProduktion() {
    stopProduktionPolling();
    document.getElementById('produktionView').classList.add('hidden');
    document.getElementById('boardView').classList.remove('hidden');
    document.getElementById('topbarTitle').textContent = 'Shopfloor';
}

// Während ein Runden-Feld fokussiert ist, nicht neu rendern - sonst würde der
// 8-Sekunden-Poll die gerade eingetippte, noch nicht abgeschickte Eingabe
// löschen (gleicher Bug wie schon bei den Istwert-Feldern behoben).
function istRundenEingabeAktiv() {
    return document.activeElement?.classList.contains('runden-input');
}

async function fetchProduktion() {
    try {
        const res = await fetch(`${API_URL}/orders/aktuell`, { headers: authHeaders() });
        if (res.status === 401) return handleAuthExpired();
        if (!res.ok) return;
        produktionOrders = await res.json();
        if (!istRundenEingabeAktiv()) renderProduktion();
    } catch (err) { /* stiller Retry beim nächsten Poll */ }
}

function renderProduktion() {
    const list = document.getElementById('produktionList');
    if (produktionOrders.length === 0) {
        list.innerHTML = '<div class="empty-note">Aktuell läuft kein Formgebung-Auftrag.</div>';
        return;
    }
    list.innerHTML = '';
    produktionOrders.forEach(order => {
        const stueckzahlBisher = (order.produktion || []).reduce((sum, p) => sum + p.stueckzahl, 0);
        // Fällige Prüfungen laut Prüfintervall - vom Server gerechnet.
        const faellige = (order.pruefungen || []).filter(p => p.status === 'faellig');
        const soll = order.gesamtmenge ?? order.menge ?? 0;
        const pct = soll > 0 ? Math.min(100, Math.round((stueckzahlBisher / soll) * 100)) : 0;
        const expanded = produktionExpandedId === order._id;

        // Läuft länger als geplant? Der Auftrag bleibt sichtbar (erst die
        // Endbearbeitung beendet ihn), wird aber markiert.
        let ueberzogen = false;
        if (order.endDatum) {
            const planEnde = new Date(order.endDatum);
            planEnde.setHours(23, 59, 59, 999);
            ueberzogen = planEnde < new Date();
        }

        // Nur bei "Trotzdem einplanen" kann ein Auftrag mit offenem
        // Wareneingang hier stehen (siehe GET /orders/aktuell) - dann sichtbar machen.
        const fehlend = (order.komponenten || []).filter(k => !k.wareneingang).map(k => k.artikelnummer || k.bezeichnung);
        const komponentenFehlen = fehlend.length ? fehlend.join(', ') : '';

        const card = document.createElement('div');
        card.className = 'order-card produktion-card';
        card.innerHTML = `
            <div class="row1">
                <span class="artikel">${order.artikelnummer || '–'}</span>
                <span class="auftrag">${order.auftragsnummer || ''}</span>
            </div>
            <div class="desc">${order.beschreibung || ''}</div>
            ${ueberzogen ? `<div class="desc" style="color:#b91c1c;font-weight:600;">⚠ Geplantes Ende ${new Date(order.endDatum).toLocaleDateString('de-DE')} überschritten</div>` : ''}
            ${komponentenFehlen ? `<div class="desc" style="color:#a16207;font-weight:600;">⚠ Komponenten fehlen noch (trotzdem eingeplant): ${komponentenFehlen}</div>` : ''}
            ${order.erstfreigabeOffen ? `<div class="pruef-erinnerung">🔒 Erstfreigabe steht noch aus</div>` : ''}
            ${faellige.length ? `<div class="pruef-erinnerung">🔔 ${faellige.length === 1 ? 'Eine Prüfung ist fällig' : `${faellige.length} Prüfungen sind fällig`}: ${faellige.map(p => p.bezeichnung).join(', ')}<button type="button" class="pruef-jetzt-btn" data-pruef-order="${order._id}">Jetzt prüfen</button></div>` : ''}
            <div class="progress-row">
                <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
                <div class="progress-label">${stueckzahlBisher} / ${soll} Stk</div>
            </div>
        `;
        card.addEventListener('click', () => {
            produktionExpandedId = expanded ? null : order._id;
            renderProduktion();
        });
        card.querySelectorAll('[data-pruef-order]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // sonst würde sich nur die Runden-Eingabe auf-/zuklappen
                openDetail(btn.dataset.pruefOrder, 'produktion');
            });
        });

        if (expanded) {
            const log = (order.produktion || []).slice().reverse();
            const box = document.createElement('div');
            box.className = 'runden-eingabe';
            box.innerHTML = `
                <div class="pruefpunkt-eingabe">
                    <input type="number" step="1" min="1" inputmode="numeric" class="runden-input" placeholder="Gefahrene Runden">
                    <button type="button" class="runden-submit">Erfassen</button>
                </div>
                <div class="runden-hinweis">Kavität ${order.kavitaet || '–'} · Stückzahl wird automatisch berechnet</div>
                <div class="massung-log" style="margin-top:8px;">
                    ${log.map(p => `
                        <div class="massung-log-row">
                            <span>${p.runden} Runden = ${p.stueckzahl} Stk · ${p.kuerzel} · ${new Date(p.zeitpunkt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
                            <button type="button" class="runden-remove" data-entry-id="${p._id}">✕</button>
                        </div>
                    `).join('')}
                </div>
            `;
            box.addEventListener('click', (e) => e.stopPropagation());

            const input = box.querySelector('.runden-input');
            box.querySelector('.runden-submit').addEventListener('click', () => {
                const runden = Number(input.value);
                if (!runden || runden <= 0) return;
                meldeRunden(order._id, runden);
            });
            box.querySelectorAll('.runden-remove').forEach(btn => {
                btn.addEventListener('click', () => entferneRundenMeldung(order._id, btn.dataset.entryId));
            });

            card.appendChild(box);
        }

        list.appendChild(card);
    });
}

async function meldeRunden(orderId, runden) {
    try {
        const res = await fetch(`${API_URL}/orders/${orderId}/produktion`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ runden }),
        });
        if (!res.ok) return;
        await fetchProduktion();
    } catch (err) { /* ignore */ }
}

async function entferneRundenMeldung(orderId, entryId) {
    try {
        await fetch(`${API_URL}/orders/${orderId}/produktion/${entryId}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        await fetchProduktion();
    } catch (err) { /* ignore */ }
}

function stopDetailPolling() {
    clearInterval(detailPollTimer);
    detailPollTimer = null;
}

// --- Maschinen-Modus ---
// Das Tablet an der Maschine zeigt ohne Suchen den Auftrag, der dort gerade
// läuft, die fälligen Prüfungen und die Runden-Eingabe. Die gewählte Maschine
// bleibt auf dem Gerät gespeichert, damit der Bildschirm nach einem Neustart
// wieder dort landet.

let maschinenListe = [];
let maschinenPollTimer = null;

function gewaehlteMaschine() {
    return localStorage.getItem('shopfloorMaschine') || null;
}

function maschinenName(id) {
    return maschinenListe.find(m => m.id === id)?.name || id;
}

document.getElementById('maschineBtn').addEventListener('click', openMaschinenModus);
document.getElementById('maschinenBackBtn').addEventListener('click', closeMaschinenModus);
document.getElementById('maschineWechselnBtn').addEventListener('click', () => {
    localStorage.removeItem('shopfloorMaschine');
    renderMaschinenModus();
});

async function openMaschinenModus() {
    activeOrderId = null;
    stopDetailPolling();
    stopProduktionPolling();
    document.getElementById('boardView').classList.add('hidden');
    document.getElementById('detailView').classList.add('hidden');
    document.getElementById('produktionView').classList.add('hidden');
    document.getElementById('maschinenView').classList.remove('hidden');
    document.getElementById('topbarTitle').textContent = 'Maschine';

    if (maschinenListe.length === 0) {
        try {
            const res = await fetch(`${API_URL}/maschinen`, { headers: authHeaders() });
            if (res.status === 401) return handleAuthExpired();
            if (res.ok) maschinenListe = await res.json();
        } catch (err) { /* ohne Liste bleibt nur die Auswahl leer */ }
    }
    await fetchProduktion();
    renderMaschinenModus();
    clearInterval(maschinenPollTimer);
    maschinenPollTimer = setInterval(async () => {
        if (istRundenEingabeAktiv()) return;
        await fetchProduktion();
        renderMaschinenModus();
    }, 8000);
}

function closeMaschinenModus() {
    clearInterval(maschinenPollTimer);
    maschinenPollTimer = null;
    document.getElementById('maschinenView').classList.add('hidden');
    document.getElementById('boardView').classList.remove('hidden');
    document.getElementById('topbarTitle').textContent = 'Shopfloor';
    fetchBoard();
}

function renderMaschinenModus() {
    const maschine = gewaehlteMaschine();
    const titel = document.getElementById('maschinenTitel');
    const sub = document.getElementById('maschinenSub');
    const inhalt = document.getElementById('maschinenInhalt');
    document.getElementById('maschineWechselnBtn').classList.toggle('hidden', !maschine);

    if (!maschine) {
        titel.textContent = 'Maschine wählen';
        sub.textContent = 'Die Auswahl bleibt auf diesem Gerät gespeichert.';
        inhalt.innerHTML = `<div class="maschinen-auswahl">${maschinenListe.map(m => `
            <button type="button" class="maschinen-kachel" data-maschine="${m.id}">
                <span class="maschinen-kachel-id">${m.id}</span>
                <span class="maschinen-kachel-name">${m.name}</span>
            </button>`).join('')}</div>`;
        inhalt.querySelectorAll('[data-maschine]').forEach(btn => {
            btn.addEventListener('click', () => {
                localStorage.setItem('shopfloorMaschine', btn.dataset.maschine);
                renderMaschinenModus();
            });
        });
        return;
    }

    titel.textContent = maschinenName(maschine);
    sub.textContent = `Maschine ${maschine} · aktueller Auftrag`;

    // Zweitmaschine mitzählen: manche Aufträge laufen auf zwei Maschinen.
    const orders = produktionOrders.filter(o => o.maschineId === maschine || o.maschineId2 === maschine);
    if (orders.length === 0) {
        inhalt.innerHTML = `<div class="empty-note">Auf ${maschinenName(maschine)} läuft gerade kein Auftrag.<br><span style="font-size:12px;">Sobald ein Auftrag begonnen hat, erscheint er hier automatisch.</span></div>`;
        return;
    }

    inhalt.innerHTML = orders.map(order => {
        const gemeldet = (order.produktion || []).reduce((sum, p) => sum + p.stueckzahl, 0);
        const soll = order.gesamtmenge ?? order.menge ?? 0;
        const pct = soll > 0 ? Math.min(100, Math.round((gemeldet / soll) * 100)) : 0;
        const faellige = (order.pruefungen || []).filter(p => p.status === 'faellig');
        return `
        <div class="card maschinen-karte">
            <div class="maschinen-artikel">${order.artikelnummer || '–'}</div>
            <div class="maschinen-beschreibung">${order.beschreibung || ''}</div>
            <div class="maschinen-auftrag">Auftrag ${order.auftragsnummer || '–'} · Kavität ${order.kavitaet || '–'}</div>
            ${order.erstfreigabeOffen ? `<div class="pruef-erinnerung">🔒 Erstfreigabe steht noch aus - bitte im Auftrag erteilen.</div>` : ''}
            ${faellige.length ? `<div class="pruef-erinnerung">🔔 ${faellige.length === 1 ? 'Eine Prüfung ist fällig' : `${faellige.length} Prüfungen sind fällig`}: ${faellige.map(p => p.bezeichnung).join(', ')}</div>` : ''}
            <div class="progress-row" style="margin:12px 0;">
                <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
                <div class="progress-label">${gemeldet} / ${soll} Stk</div>
            </div>
            <div class="pruefpunkt-eingabe">
                <input type="number" step="1" min="1" inputmode="numeric" class="runden-input" data-maschinen-runden="${order._id}" placeholder="Gefahrene Runden">
                <button type="button" data-maschinen-melden="${order._id}">Erfassen</button>
            </div>
            <button type="button" class="btn btn-secondary maschinen-oeffnen" data-maschinen-order="${order._id}">Auftrag öffnen (Prüfungen, Zeichnung, FSK)</button>
        </div>`;
    }).join('');

    inhalt.querySelectorAll('[data-maschinen-melden]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const orderId = btn.dataset.maschinenMelden;
            const input = inhalt.querySelector(`[data-maschinen-runden="${orderId}"]`);
            const runden = Number(input.value);
            if (!runden || runden <= 0) return;
            await meldeRunden(orderId, runden);
            renderMaschinenModus();
        });
    });
    inhalt.querySelectorAll('[data-maschinen-order]').forEach(btn => {
        btn.addEventListener('click', () => openDetail(btn.dataset.maschinenOrder, 'maschine'));
    });
}

// --- Detail ---

// Woher das Auftragsdetail geöffnet wurde - der Zurück-Button führt dorthin
// zurück (Tafel oder Produktionsliste), statt immer auf der Tafel zu landen.
let detailHerkunft = 'board';

async function openDetail(orderId, herkunft = 'board') {
    detailHerkunft = herkunft;
    activeOrderId = orderId;
    stopProduktionPolling();
    clearInterval(maschinenPollTimer);
    maschinenPollTimer = null;
    document.getElementById('maschinenView').classList.add('hidden');
    document.getElementById('produktionView').classList.add('hidden');
    document.getElementById('boardView').classList.add('hidden');
    document.getElementById('detailView').classList.remove('hidden');
    document.getElementById('topbarTitle').textContent = 'Auftragsdetail';
    await fetchDetail(orderId);
    clearInterval(detailPollTimer);
    detailPollTimer = setInterval(() => fetchDetail(orderId), 8000);
}

let currentDetail = null;

// Während ein Istwert-Feld (Erstfreigabe oder laufende Maßprüfung) fokussiert
// ist, nicht neu rendern - der 8-Sekunden-Poll würde sonst renderDetail() den
// kompletten Auftragsdetail-Bereich neu aufbauen und dabei die gerade
// eingetippte, noch nicht abgeschickte Eingabe löschen.
function istEingabeAktiv() {
    const el = document.activeElement;
    return el?.tagName === 'INPUT' && (el.hasAttribute('data-pruefpunkt-id') || el.hasAttribute('data-massung-pruefpunkt'));
}

async function fetchDetail(orderId) {
    try {
        const res = await fetch(`${API_URL}/orders/${orderId}`, { headers: authHeaders() });
        if (res.status === 401) return handleAuthExpired();
        if (!res.ok) return;
        currentDetail = await res.json();
        if (!istEingabeAktiv()) renderDetail();
    } catch (err) { /* stiller Retry beim nächsten Poll */ }
}

function renderDetail() {
    const { order, zeichnung, einstelldatenblatt, qpa, plp, erstfreigabeErforderlich, erstfreigabeOffen } = currentDetail;
    document.getElementById('detailTitle').textContent = `${order.artikelnummer || '–'} · ${order.auftragsnummer || ''}`;
    document.getElementById('detailSub').textContent = `${order.beschreibung || ''} · Menge ${order.menge || '–'}`;

    renderDateiPreview('zeichnungBox', order.artikelnummer, 'zeichnung', zeichnung, 'Keine Zeichnung hinterlegt.');
    // Einstelldatenblatt gibt es nur für Formgebung (Elastomer) - Karte bei CNC ausblenden.
    const einstelldatenblattCard = document.getElementById('einstelldatenblattCard');
    einstelldatenblattCard.classList.toggle('hidden', order.dbType !== 'Elastomer');
    if (order.dbType === 'Elastomer') {
        renderDateiPreview('einstelldatenblattBox', order.artikelnummer, 'einstelldatenblatt', einstelldatenblatt, 'Kein Einstelldatenblatt hinterlegt.');
    }
    renderDateiPreview('qpaBox', order.artikelnummer, 'qpa', qpa, 'Keine QPA hinterlegt.');
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
        renderMassungen(order, plp, currentDetail.pruefungen || []);
        renderFehler(order);
    }
    renderEndabnahme(order, currentDetail.endabnahme, currentDetail.rolle);
}

// Endabnahme: eigene Karte, weil sie anderen Regeln folgt als die laufenden
// Prüfungen - nur die QS darf sie erfassen (nicht, wer produziert hat) und erst,
// wenn die Menge fertig ist. Für eine Teilsendung kann die QS sie bewusst
// vorziehen.
function renderEndabnahme(order, endabnahme, rolle) {
    const card = document.getElementById('endabnahmeCard');
    const box = document.getElementById('endabnahmeBox');
    if (!endabnahme || !endabnahme.erforderlich) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');

    const istQs = rolle === 'qs';
    const offen = endabnahme.punkte.filter(p => !p.erledigt);
    const kopf = endabnahme.mengeFertig
        ? `<div class="pruef-erinnerung">✅ ${endabnahme.gemeldet} von ${endabnahme.soll} Stk gemeldet - die Endabnahme kann erfolgen.</div>`
        : `<div class="pruef-intervall-hinweis">Erst ${endabnahme.gemeldet} von ${endabnahme.soll} Stk gemeldet. Vollständig abgenommen wird nach der Produktion${istQs ? ' - für eine Teilsendung kann jetzt schon abgenommen werden.' : '.'}</div>`;

    if (!istQs) {
        box.innerHTML = kopf + `<div class="locked-note">🔒 Die Endabnahme darf nur die QS erfassen.</div>`
            + endabnahmeLog(endabnahme);
        return;
    }

    const teilsendung = !endabnahme.mengeFertig;
    box.innerHTML = kopf
        + (teilsendung ? `<div class="pruef-intervall-hinweis faellig">Wird als Teilsendung dokumentiert.</div>` : '')
        + endabnahme.punkte.map(p => {
            const istMass = p.typ === 'masspruefung';
            const eingabe = istMass
                ? `<div class="pruefpunkt-eingabe">
                    <input type="number" step="any" inputmode="decimal" data-endabnahme-pruefpunkt="${p.pruefpunktId}" placeholder="Istwert">
                    <span class="io-badge" data-endabnahme-badge="${p.pruefpunktId}"></span>
                    <button data-endabnahme-add="${p.pruefpunktId}">Erfassen</button>
                </div>`
                : `<div class="pruefpunkt-eingabe io-choice">
                    <button class="io-choice-btn ok" data-endabnahme-io="${p.pruefpunktId}" data-endabnahme-ergebnis="i.O.">✅ i.O.</button>
                    <button class="io-choice-btn nok" data-endabnahme-io="${p.pruefpunktId}" data-endabnahme-ergebnis="n.i.O.">❌ n.i.O.</button>
                </div>`;
            return `
                <div class="pruefpunkt-row">
                    <div class="pruefpunkt-head">
                        <span class="pruefpunkt-name">${p.bezeichnung}${p.erledigt ? ' <span class="io-badge ok">erfasst</span>' : ''}</span>
                        ${istMass ? `<span class="pruefpunkt-soll">Soll ${p.sollwert ?? '–'}${p.einheit ? ' ' + p.einheit : ''}${p.pruefmittel ? ' · ' + p.pruefmittel : ''}</span>` : ''}
                    </div>
                    ${eingabe}
                </div>`;
        }).join('')
        + (offen.length ? `<div class="pruef-intervall-hinweis">Noch offen: ${offen.map(p => p.bezeichnung).join(', ')}</div>` : '')
        + endabnahmeLog(endabnahme);

    box.querySelectorAll('input[data-endabnahme-pruefpunkt]').forEach(input => {
        const p = endabnahme.punkte.find(pp => pp.pruefpunktId === input.dataset.endabnahmePruefpunkt);
        const badge = box.querySelector(`[data-endabnahme-badge="${p.pruefpunktId}"]`);
        input.addEventListener('input', () => {
            if (input.value === '') { badge.textContent = ''; badge.className = 'io-badge'; return; }
            const ioNio = berechneIoNioClient(Number(input.value), p.toleranzMin, p.toleranzMax);
            badge.textContent = ioNio;
            badge.className = `io-badge ${ioNio === 'i.O.' ? 'ok' : 'nok'}`;
        });
    });
    box.querySelectorAll('[data-endabnahme-add]').forEach(btn => {
        btn.addEventListener('click', () => {
            const pruefpunktId = btn.dataset.endabnahmeAdd;
            const input = box.querySelector(`input[data-endabnahme-pruefpunkt="${pruefpunktId}"]`);
            if (input.value === '') return;
            addMassung(pruefpunktId, { istwert: Number(input.value), teilsendung });
        });
    });
    box.querySelectorAll('[data-endabnahme-io]').forEach(btn => {
        btn.addEventListener('click', () => addMassung(btn.dataset.endabnahmeIo, { ergebnis: btn.dataset.endabnahmeErgebnis, teilsendung }));
    });
}

function endabnahmeLog(endabnahme) {
    const erledigt = endabnahme.punkte.filter(p => p.erledigt);
    if (erledigt.length === 0) return '';
    const massungen = (currentDetail.order.massungen || []).filter(m => m.stufe === 'endabnahme').slice().reverse();
    return `<div class="massung-log" style="margin-top:10px;">${massungen.map(m => `
        <div class="massung-log-row">
            <span>${m.bezeichnung}: ${m.istwert != null ? m.istwert + (m.einheit ? ' ' + m.einheit : '') + ' ' : ''}<span class="io-badge ${m.ioNio === 'i.O.' ? 'ok' : 'nok'}">${m.ioNio}</span> · ${m.kuerzel} · ${new Date(m.zeitpunkt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
        </div>`).join('')}</div>`;
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
            ${k.bezeichnung === 'Werkzeug' ? '' : `<span class="komponente-info-charge">Charge: <b>${k.charge || '–'}</b></span>`}
        </div>
    `).join('');
}

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

// Eine Object-URL je Box merken, zusammen mit dem Stand (material|feld|
// uploadedAt), aus dem sie erzeugt wurde. Die Detailansicht rendert alle 8
// Sekunden neu - ohne diesen Merker würde jedes Mal das PDF (~400 KB) erneut
// geladen und eine neue URL erzeugt.
const aktiveObjectUrls = {};

// datei enthält nur Metadaten (siehe GET /shopfloor/orders/:orderId), der
// Inhalt kommt über die eigene Datei-Route - einmal je Stand.
async function renderDateiPreview(boxId, material, feld, datei, leerText) {
    const box = document.getElementById(boxId);
    const stand = datei ? `${material}|${feld}|${datei.uploadedAt}` : null;
    const bekannt = aktiveObjectUrls[boxId];

    if (!datei) {
        if (bekannt) { URL.revokeObjectURL(bekannt.url); delete aktiveObjectUrls[boxId]; }
        box.innerHTML = `<div class="no-doc">${leerText}</div>`;
        return;
    }
    if (bekannt && bekannt.stand === stand) return; // unverändert, nichts neu laden

    if (bekannt) { URL.revokeObjectURL(bekannt.url); delete aktiveObjectUrls[boxId]; }
    box.innerHTML = `<div class="no-doc">${datei.filename} wird geladen…</div>`;
    let voll;
    try {
        const res = await fetch(`${API_URL}/artikel/${encodeURIComponent(material)}/datei/${feld}`, { headers: authHeaders() });
        if (!res.ok) throw new Error();
        voll = await res.json();
    } catch (err) {
        box.innerHTML = `<div class="no-doc">${datei.filename} konnte nicht geladen werden.</div>`;
        return;
    }

    const url = base64ToObjectUrl(voll.data, voll.mimeType);
    aktiveObjectUrls[boxId] = { url, stand };
    const isImage = (voll.mimeType || '').startsWith('image/');
    box.innerHTML = `
        <div class="zeichnung-preview">
            ${isImage ? `<img src="${url}" alt="${voll.filename}">` : ''}
            <div><a href="${url}" target="_blank" rel="noopener">${voll.filename} öffnen ↗</a></div>
        </div>
    `;
}

// Rundet Fließkomma-Rauschen aus Sollwert +/- Abweichung weg (z.B. 35.900000000000006).
function rundeToleranz(x) { return Math.round(x * 1e6) / 1e6; }

// Zeigt die Toleranz wie auf der FSK-Karte als Abweichung vom Sollwert (z.B.
// "± 0.3 mm" oder "+0.3 / -0.1 mm"), nicht als absolute Grenzen - genau so
// werden Sollwert/Abweichung auch in der Artikelverwaltung eingegeben.
function formatToleranz(p) {
    if (p.toleranzMin == null && p.toleranzMax == null) return '–';
    const einheit = p.einheit ? ' ' + p.einheit : '';
    if (p.sollwert == null) return `${p.toleranzMin ?? '–'} … ${p.toleranzMax ?? '–'}${einheit}`;
    const abwUnten = p.toleranzMin != null ? rundeToleranz(p.sollwert - p.toleranzMin) : null;
    const abwOben = p.toleranzMax != null ? rundeToleranz(p.toleranzMax - p.sollwert) : null;
    if (abwUnten != null && abwOben != null) {
        return abwUnten === abwOben ? `± ${abwOben}${einheit}` : `+${abwOben} / -${abwUnten}${einheit}`;
    }
    if (abwUnten != null) return `-${abwUnten}${einheit}`;
    return `+${abwOben}${einheit}`;
}

const PRUEFSTUFE_LABEL = { erstfreigabe: 'Erstfreigabe', laufend: 'laufend', endabnahme: 'Endabnahme (QS)' };

function renderPlp(plp) {
    const box = document.getElementById('plpBox');
    if (!plp || plp.length === 0) {
        box.innerHTML = '<div class="no-doc">Kein Produktionslenkungsplan hinterlegt.</div>';
        return;
    }
    box.innerHTML = `
        <div style="overflow-x:auto;">
        <table class="plp-table">
            <thead><tr><th>Typ</th><th>Bezeichnung</th><th>Stufe</th><th>Sollwert</th><th>Toleranz</th><th>Prüfmittel</th><th>Prüfintervall</th></tr></thead>
            <tbody>
                ${plp.map(r => `<tr>
                    <td>${r.typ === 'masspruefung' ? 'Maßprüfung' : r.typ === 'iopruefung' ? 'i.O./n.i.O.' : 'Prozess'}</td>
                    <td>${r.bezeichnung || ''}</td>
                    <td>${r.typ === 'prozess' ? '–' : PRUEFSTUFE_LABEL[r.stufe || 'laufend']}</td>
                    <td>${r.typ === 'masspruefung' ? (r.sollwert ?? '–') + (r.einheit ? ' ' + r.einheit : '') : '–'}</td>
                    <td>${r.typ === 'masspruefung' ? formatToleranz(r) : '–'}</td>
                    <td>${r.pruefmittel || '–'}</td>
                    <td>${pruefintervallText(r)}</td>
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

    // Sowohl Maßprüfungs- als auch i.O./n.i.O.-Prüfpunkte müssen vor der Erstfreigabe
    // dokumentiert und i.O. sein - außer der Endabnahme, die erst nach der
    // Produktion durch die QS erfolgt (gleiche Regel wie in routes/shopfloor.js).
    const massPunkte = plp.filter(p => (p.typ === 'masspruefung' || p.typ === 'iopruefung') && (p.stufe || 'laufend') !== 'endabnahme');
    box.innerHTML = `
        <div class="locked-note" style="margin-bottom: 14px;">🔒 Vor Serienproduktion müssen alle Prüfungen i.O. sein und die Erstfreigabe erteilt werden.</div>
        ${massPunkte.map(p => p.typ === 'masspruefung' ? `
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
        ` : `
            <div class="pruefpunkt-row">
                <div class="pruefpunkt-head">
                    <span class="pruefpunkt-name">${p.bezeichnung}</span>
                </div>
                <div class="pruefpunkt-eingabe io-choice">
                    <button type="button" class="io-choice-btn ok" data-io-pruefpunkt-id="${p._id}" data-io-ergebnis="i.O.">✅ i.O.</button>
                    <button type="button" class="io-choice-btn nok" data-io-pruefpunkt-id="${p._id}" data-io-ergebnis="n.i.O.">❌ n.i.O.</button>
                </div>
            </div>
        `).join('')}
        <button class="btn btn-primary erstfreigabe-submit" id="erstfreigabeSubmitBtn" ${massPunkte.length === 0 ? '' : 'disabled'}>Erstfreigabe erteilen</button>
    `;

    const inputs = box.querySelectorAll('input[data-pruefpunkt-id]');
    const ioBtns = box.querySelectorAll('[data-io-pruefpunkt-id]');
    const submitBtn = document.getElementById('erstfreigabeSubmitBtn');
    // Auswahl bei i.O./n.i.O.-Punkten wird erst mit dem Erstfreigabe-Klick
    // gesammelt abgeschickt (wie bei den Istwert-Feldern), nicht sofort.
    const ioAuswahl = {};

    function pruefeVollstaendig() {
        if (massPunkte.length === 0) { submitBtn.disabled = false; return; }
        let alleIo = true;
        massPunkte.forEach(p => {
            if (p.typ === 'masspruefung') {
                const input = box.querySelector(`input[data-pruefpunkt-id="${p._id}"]`);
                const badge = box.querySelector(`[data-badge-id="${p._id}"]`);
                if (input.value === '') { badge.textContent = ''; badge.className = 'io-badge'; alleIo = false; return; }
                const ioNio = berechneIoNioClient(Number(input.value), p.toleranzMin, p.toleranzMax);
                badge.textContent = ioNio;
                badge.className = `io-badge ${ioNio === 'i.O.' ? 'ok' : 'nok'}`;
                if (ioNio === 'n.i.O.') alleIo = false;
            } else {
                const ergebnis = ioAuswahl[p._id];
                if (!ergebnis || ergebnis === 'n.i.O.') alleIo = false;
            }
        });
        submitBtn.disabled = !alleIo;
    }
    inputs.forEach(input => input.addEventListener('input', pruefeVollstaendig));
    ioBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const pid = btn.dataset.ioPruefpunktId;
            ioAuswahl[pid] = btn.dataset.ioErgebnis;
            box.querySelectorAll(`[data-io-pruefpunkt-id="${pid}"]`).forEach(b => b.classList.toggle('selected', b === btn));
            pruefeVollstaendig();
        });
    });
    pruefeVollstaendig();

    submitBtn.addEventListener('click', async () => {
        const messungen = massPunkte.map(p => p.typ === 'masspruefung'
            ? { pruefpunktId: p._id, istwert: Number(box.querySelector(`input[data-pruefpunkt-id="${p._id}"]`).value) }
            : { pruefpunktId: p._id, ergebnis: ioAuswahl[p._id] });
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

// --- Maßprüfungen und i.O./n.i.O.-Prüfungen auf der Fehlersammelkarte ---

function renderMassungen(order, plp, pruefungen = []) {
    const box = document.getElementById('massungenBox');
    // Nur die serienbegleitenden Prüfungen: die Vorhaltemaße gehören zur
    // Erstfreigabe (einmal je Auftrag), die Endabnahme hat eine eigene Karte.
    const pruefPunkte = (plp || []).filter(p => (p.typ === 'masspruefung' || p.typ === 'iopruefung') && (p.stufe || 'laufend') === 'laufend');
    if (pruefPunkte.length === 0) { box.innerHTML = ''; return; }

    // Fälligkeit je Prüfpunkt kommt fertig gerechnet vom Server (Prüfintervall
    // aus dem Produktionslenkungsplan) - hier nur noch anzeigen.
    const faelligkeitJePunkt = new Map(pruefungen.map(p => [String(p.pruefpunktId), p]));
    const faellige = pruefungen.filter(p => p.status === 'faellig');
    const erinnerung = faellige.length
        ? `<div class="pruef-erinnerung">🔔 ${faellige.length === 1 ? 'Eine Prüfung ist fällig' : `${faellige.length} Prüfungen sind fällig`}: ${faellige.map(p => p.bezeichnung).join(', ')}</div>`
        : '';

    const massungen = order.massungen || [];
    box.innerHTML = `<h4 style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; color: #64748b; margin-bottom: 10px;">Maßprüfungen</h4>${erinnerung}` + pruefPunkte.map(p => {
        const faelligkeit = faelligkeitJePunkt.get(String(p._id));
        const faelligBadge = faelligkeit && faelligkeit.status === 'faellig'
            ? `<span class="pruef-faellig-badge">🔔 fällig</span>`
            : '';
        const faelligHinweis = faelligkeit && faelligkeit.hinweis
            ? `<div class="pruef-intervall-hinweis${faelligkeit.status === 'faellig' ? ' faellig' : ''}">${faelligkeit.hinweis}</div>`
            : '';
        const log = massungen.filter(m => String(m.pruefpunktId) === String(p._id)).slice().reverse();
        const istMass = p.typ === 'masspruefung';
        // Maßprüfung: Istwert eintragen, live i.O./n.i.O.-Vorschau, "Erfassen" speichert.
        // i.O./n.i.O.-Prüfung (z.B. Sichtprüfung): kein Messwert, ein Tap erfasst direkt.
        const eingabe = istMass
            ? `<div class="pruefpunkt-eingabe">
                <input type="number" step="any" inputmode="decimal" data-massung-pruefpunkt="${p._id}" placeholder="Istwert">
                <span class="io-badge" data-massung-badge="${p._id}"></span>
                <button data-massung-add="${p._id}">Erfassen</button>
            </div>`
            : `<div class="pruefpunkt-eingabe io-choice">
                <button class="io-choice-btn ok" data-massung-io="${p._id}" data-massung-ergebnis="i.O.">✅ i.O.</button>
                <button class="io-choice-btn nok" data-massung-io="${p._id}" data-massung-ergebnis="n.i.O.">❌ n.i.O.</button>
            </div>`;
        return `
            <div class="pruefpunkt-row${faelligkeit && faelligkeit.status === 'faellig' ? ' faellig' : ''}">
                <div class="pruefpunkt-head">
                    <span class="pruefpunkt-name">${p.bezeichnung}${faelligBadge}</span>
                    ${istMass ? `<span class="pruefpunkt-soll">Soll ${p.sollwert ?? '–'}${p.einheit ? ' ' + p.einheit : ''} (${formatToleranz(p)})</span>` : ''}
                </div>
                ${faelligHinweis}
                ${eingabe}
                <div class="massung-log">
                    ${log.map(m => `
                        <div class="massung-log-row">
                            <span>${m.istwert != null ? m.istwert + (m.einheit ? ' ' + m.einheit : '') + ' ' : ''}<span class="io-badge ${m.ioNio === 'i.O.' ? 'ok' : 'nok'}">${m.ioNio}</span> · ${m.kuerzel} · ${new Date(m.zeitpunkt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
                            <button data-massung-del="${m._id}">✕</button>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }).join('');

    box.querySelectorAll('input[data-massung-pruefpunkt]').forEach(input => {
        const p = pruefPunkte.find(pp => String(pp._id) === input.dataset.massungPruefpunkt);
        const badge = box.querySelector(`[data-massung-badge="${p._id}"]`);
        input.addEventListener('input', () => {
            if (input.value === '') { badge.textContent = ''; badge.className = 'io-badge'; return; }
            const ioNio = berechneIoNioClient(Number(input.value), p.toleranzMin, p.toleranzMax);
            badge.textContent = ioNio;
            badge.className = `io-badge ${ioNio === 'i.O.' ? 'ok' : 'nok'}`;
        });
    });
    box.querySelectorAll('[data-massung-add]').forEach(btn => {
        btn.addEventListener('click', () => {
            const pruefpunktId = btn.dataset.massungAdd;
            const input = box.querySelector(`input[data-massung-pruefpunkt="${pruefpunktId}"]`);
            if (input.value === '') return;
            addMassung(pruefpunktId, { istwert: Number(input.value) });
        });
    });
    box.querySelectorAll('[data-massung-io]').forEach(btn => {
        btn.addEventListener('click', () => addMassung(btn.dataset.massungIo, { ergebnis: btn.dataset.massungErgebnis }));
    });
    box.querySelectorAll('[data-massung-del]').forEach(btn => {
        btn.addEventListener('click', () => removeMassung(btn.dataset.massungDel));
    });
}

async function addMassung(pruefpunktId, payload) {
    try {
        const res = await fetch(`${API_URL}/orders/${activeOrderId}/massung`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ pruefpunktId, ...payload }),
        });
        // Gesperrte Prüfungen (Endabnahme ohne QS-Rolle oder vor Produktionsende)
        // nicht still schlucken - sonst passiert scheinbar einfach nichts.
        if (!res.ok) {
            const daten = await res.json().catch(() => ({}));
            if (daten.error) alert(daten.error);
        }
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

// --- Export (Artikelmappe + FSK-Historie) ---

document.getElementById('artikelmappeBtn')?.addEventListener('click', async () => {
    const note = document.getElementById('exportNote');
    const { order, zeichnung, einstelldatenblatt, qpa, plp } = currentDetail;
    note.style.color = '#64748b';
    note.textContent = 'Erzeuge PDF...';
    try {
        await exportArtikelmappe({
            material: order.artikelnummer, bezeichnung: order.beschreibung, dbType: order.dbType,
            maschine: '', kavitaet: null, zeichnung, einstelldatenblatt, qpa, plp,
        }, async (feld) => {
            const res = await fetch(`${API_URL}/artikel/${encodeURIComponent(order.artikelnummer)}/datei/${feld}`, { headers: authHeaders() });
            if (!res.ok) throw new Error();
            return res.json();
        });
        note.style.color = '#15803d';
        note.textContent = '✅ Artikelmappe heruntergeladen.';
    } catch (err) {
        note.style.color = '#b91c1c';
        note.textContent = 'Export fehlgeschlagen.';
    }
});

document.getElementById('fskHistorieBtn')?.addEventListener('click', async () => {
    const note = document.getElementById('exportNote');
    const { order } = currentDetail;
    note.style.color = '#64748b';
    note.textContent = 'Lade Auftragshistorie...';
    try {
        const res = await fetch(`${API_URL}/artikel/${encodeURIComponent(order.artikelnummer)}/auftraege`, { headers: authHeaders() });
        const auftraege = await res.json();
        if (!res.ok) throw new Error(auftraege.error);
        exportFskHistorie(order.artikelnummer, order.beschreibung, auftraege);
        note.style.color = '#15803d';
        note.textContent = `✅ Excel heruntergeladen (${auftraege.length} Auftrag${auftraege.length === 1 ? '' : 'e'}).`;
    } catch (err) {
        note.style.color = '#b91c1c';
        note.textContent = 'Export fehlgeschlagen.';
    }
});

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
    const rolleText = currentUser?.rolle === 'qs' ? ' · QS' : '';
    document.getElementById('userGreeting').textContent = currentUser ? `${currentUser.name} (${currentUser.kuerzel})${rolleText}` : '';
    fetchBoard();
    clearInterval(boardPollTimer);
    boardPollTimer = setInterval(() => {
        if (!activeOrderId
            && document.getElementById('produktionView').classList.contains('hidden')
            && document.getElementById('maschinenView').classList.contains('hidden')) fetchBoard();
    }, 8000);
    // Ein Tablet, das fest an einer Maschine hängt, startet direkt im
    // Maschinen-Modus - ohne dass jemand erst etwas auswählen muss.
    if (gewaehlteMaschine()) openMaschinenModus();
}

init();
