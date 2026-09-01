// Gemeinsame Export-Funktionen für Büro-App und Shopfloor (beide binden diese
// Datei ein) - Artikelmappe als PDF (pdf-lib) und FSK-Historie als Excel
// (SheetJS, wie die übrigen Exports in der App).

function base64ToUint8Array(base64) {
    const byteChars = atob(base64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    return bytes;
}

function downloadBytes(bytes, filename, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pruefpunktToleranzText(p) {
    if (p.toleranzMin == null && p.toleranzMax == null) return '–';
    return `${p.toleranzMin ?? '–'} … ${p.toleranzMax ?? '–'}${p.einheit ? ' ' + p.einheit : ''}`;
}

// --- Artikelmappe (PDF: Zeichnung + Einstelldatenblatt + Produktionslenkungsplan) ---

const A4_BREITE = 595.28;
const A4_HOEHE = 841.89;
const SEITENRAND = 40;

async function pdfCoverSeite(pdfDoc, font, fontBold, article) {
    const page = pdfDoc.addPage([A4_BREITE, A4_HOEHE]);
    let y = A4_HOEHE - 60;
    page.drawText('Artikelmappe', { x: SEITENRAND, y, size: 22, font: fontBold });
    y -= 34;
    page.drawText(`${article.material} - ${article.bezeichnung || ''}`, { x: SEITENRAND, y, size: 14, font });
    y -= 30;

    const zeilen = [
        ['Typ', article.dbType === 'PTFE' ? 'CNC' : article.dbType === 'Elastomer' ? 'Formgebung' : '–'],
        ['Maschine', article.maschine || '–'],
        ['Kavität', article.kavitaet ? String(article.kavitaet) : '–'],
        ['Erstellt am', new Date().toLocaleDateString('de-DE')],
    ];
    zeilen.forEach(([label, wert]) => {
        page.drawText(label + ':', { x: SEITENRAND, y, size: 11, font: fontBold });
        page.drawText(wert, { x: SEITENRAND + 110, y, size: 11, font });
        y -= 18;
    });
    return page;
}

function pdfPlpTabelle(pdfDoc, font, fontBold, plp) {
    const spalten = [
        { key: 'typ', label: 'Typ', breite: 65, get: (p) => p.typ === 'masspruefung' ? 'Maßprüfung' : 'Prozess' },
        { key: 'bezeichnung', label: 'Bezeichnung', breite: 130, get: (p) => p.bezeichnung || '' },
        { key: 'sollwert', label: 'Sollwert', breite: 60, get: (p) => p.typ === 'masspruefung' ? `${p.sollwert ?? '–'}${p.einheit ? ' ' + p.einheit : ''}` : '–' },
        { key: 'toleranz', label: 'Toleranz', breite: 90, get: (p) => p.typ === 'masspruefung' ? pruefpunktToleranzText(p) : '–' },
        { key: 'pruefmittel', label: 'Prüfmittel', breite: 85, get: (p) => p.pruefmittel || '–' },
        { key: 'haeufigkeit', label: 'Häufigkeit', breite: 85, get: (p) => p.pruefhaeufigkeit || '–' },
    ];
    const zeilenHoehe = 20;
    let page = pdfDoc.addPage([A4_BREITE, A4_HOEHE]);
    let y = A4_HOEHE - 50;
    page.drawText('Produktionslenkungsplan', { x: SEITENRAND, y, size: 16, font: fontBold });
    y -= 30;

    function kopfzeile() {
        let x = SEITENRAND;
        spalten.forEach(s => {
            page.drawText(s.label, { x, y, size: 9, font: fontBold });
            x += s.breite;
        });
        y -= 16;
        page.drawLine({ start: { x: SEITENRAND, y: y + 6 }, end: { x: A4_BREITE - SEITENRAND, y: y + 6 }, thickness: 0.5 });
    }
    kopfzeile();

    if (!plp || plp.length === 0) {
        page.drawText('Keine Prüfpunkte hinterlegt.', { x: SEITENRAND, y, size: 10, font });
        return;
    }

    plp.forEach(p => {
        if (y < SEITENRAND + zeilenHoehe) {
            page = pdfDoc.addPage([A4_BREITE, A4_HOEHE]);
            y = A4_HOEHE - 50;
            kopfzeile();
        }
        let x = SEITENRAND;
        spalten.forEach(s => {
            const text = String(s.get(p)).slice(0, 40);
            page.drawText(text, { x, y, size: 9, font });
            x += s.breite;
        });
        y -= zeilenHoehe;
    });
}

async function pdfDateiSeite(pdfDoc, font, fontBold, titel, datei) {
    if (!datei || !datei.data) return;
    const bytes = base64ToUint8Array(datei.data);
    try {
        if (datei.mimeType === 'application/pdf') {
            const srcDoc = await PDFLib.PDFDocument.load(bytes);
            const kopierteSeiten = await pdfDoc.copyPages(srcDoc, srcDoc.getPageIndices());
            kopierteSeiten.forEach(p => pdfDoc.addPage(p));
            return;
        }
        let bild;
        if (datei.mimeType === 'image/png') bild = await pdfDoc.embedPng(bytes);
        else if (datei.mimeType === 'image/jpeg' || datei.mimeType === 'image/jpg') bild = await pdfDoc.embedJpg(bytes);
        if (bild) {
            const page = pdfDoc.addPage([A4_BREITE, A4_HOEHE]);
            page.drawText(titel, { x: SEITENRAND, y: A4_HOEHE - 40, size: 12, font: fontBold });
            const maxBreite = A4_BREITE - SEITENRAND * 2;
            const maxHoehe = A4_HOEHE - 100;
            const skalierung = Math.min(maxBreite / bild.width, maxHoehe / bild.height, 1);
            const breite = bild.width * skalierung;
            const hoehe = bild.height * skalierung;
            page.drawImage(bild, { x: (A4_BREITE - breite) / 2, y: (A4_HOEHE - 80 - hoehe) / 2, width: breite, height: hoehe });
            return;
        }
    } catch (err) {
        // Datei nicht einbettbar (unbekanntes Format o.ä.) - Hinweisseite statt Absturz.
    }
    const page = pdfDoc.addPage([A4_BREITE, A4_HOEHE]);
    page.drawText(titel, { x: SEITENRAND, y: A4_HOEHE - 40, size: 12, font: fontBold });
    page.drawText(`${datei.filename} (${datei.mimeType}) konnte nicht eingebettet werden - Originaldatei separat prüfen.`, {
        x: SEITENRAND, y: A4_HOEHE - 70, size: 10, font,
    });
}

async function exportArtikelmappe(article) {
    const pdfDoc = await PDFLib.PDFDocument.create();
    const font = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaBold);

    await pdfCoverSeite(pdfDoc, font, fontBold, article);
    pdfPlpTabelle(pdfDoc, font, fontBold, article.plp || []);
    await pdfDateiSeite(pdfDoc, font, fontBold, 'Zeichnung', article.zeichnung);
    await pdfDateiSeite(pdfDoc, font, fontBold, 'Einstelldatenblatt', article.einstelldatenblatt);

    const bytes = await pdfDoc.save();
    downloadBytes(bytes, `Artikelmappe-${article.material}.pdf`, 'application/pdf');
}

// --- FSK-Historie (Excel: alle Aufträge eines Artikels über alle Phasen) ---

function exportFskHistorie(material, bezeichnung, auftraege) {
    const uebersicht = auftraege.map(o => ({
        'Auftrag': o.auftragsnummer,
        'Bestellung': o.bestellnummer || '',
        'Phase': o.phase,
        'Start': o.startDatum ? new Date(o.startDatum).toLocaleDateString('de-DE') : '',
        'Ende': o.endDatum ? new Date(o.endDatum).toLocaleDateString('de-DE') : '',
        'Erstfreigabe': o.erstfreigabe?.erteilt ? 'erteilt' : 'ausstehend',
        'Erstfreigabe von': o.erstfreigabe?.kuerzel || '',
        'Erstfreigabe am': o.erstfreigabe?.zeitpunkt ? new Date(o.erstfreigabe.zeitpunkt).toLocaleString('de-DE') : '',
        'Fehler gesamt': (o.fehlersammelkarte || []).length,
        'Maßprüfungen gesamt': (o.massungen || []).length,
        'davon n.i.O.': (o.massungen || []).filter(m => m.ioNio === 'n.i.O.').length,
    }));

    const fehler = [];
    auftraege.forEach(o => (o.fehlersammelkarte || []).forEach(f => fehler.push({
        'Auftrag': o.auftragsnummer, 'Fehlerart': f.fehlerart, 'Kürzel': f.kuerzel,
        'Zeitpunkt': new Date(f.zeitpunkt).toLocaleString('de-DE'),
    })));

    const massungen = [];
    auftraege.forEach(o => (o.massungen || []).forEach(m => massungen.push({
        'Auftrag': o.auftragsnummer, 'Prüfpunkt': m.bezeichnung, 'Istwert': m.istwert,
        'Sollwert': m.sollwert ?? '', 'Tol. min': m.toleranzMin ?? '', 'Tol. max': m.toleranzMax ?? '',
        'Einheit': m.einheit || '', 'Ergebnis': m.ioNio, 'Kürzel': m.kuerzel,
        'Zeitpunkt': new Date(m.zeitpunkt).toLocaleString('de-DE'),
    })));

    const erstfreigaben = auftraege
        .filter(o => o.erstfreigabe?.erteilt)
        .flatMap(o => (o.erstfreigabe.messungen || []).map(m => ({
            'Auftrag': o.auftragsnummer, 'Erteilt von': o.erstfreigabe.kuerzel,
            'Erteilt am': new Date(o.erstfreigabe.zeitpunkt).toLocaleString('de-DE'),
            'Prüfpunkt': m.bezeichnung, 'Istwert': m.istwert, 'Sollwert': m.sollwert ?? '',
            'Tol. min': m.toleranzMin ?? '', 'Tol. max': m.toleranzMax ?? '', 'Einheit': m.einheit || '', 'Ergebnis': m.ioNio,
        })));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(uebersicht), 'Übersicht');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(erstfreigaben.length ? erstfreigaben : [{ Hinweis: 'Keine Erstfreigaben' }]), 'Erstfreigaben');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(massungen.length ? massungen : [{ Hinweis: 'Keine Maßprüfungen' }]), 'Maßprüfungen');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fehler.length ? fehler : [{ Hinweis: 'Keine Fehler erfasst' }]), 'Fehlersammlung');
    XLSX.writeFile(wb, `FSK-Historie-${material}.xlsx`);
}
