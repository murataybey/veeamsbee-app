// Müşteri raporu — Veeam ONE rapor stilinde Word (.docx) ve PDF çıktısı:
// beyaz zemin, sol başlık + sağ üst logo, parametre bloğu, özet, grafik, klasik detay tabloları.
import fs from 'node:fs';
import {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
    WidthType, BorderStyle, AlignmentType, VerticalAlign, TableLayoutType,
} from 'docx';
import PDFDocument from 'pdfkit';

const RESULT_TR = { Success: 'Başarılı', Warning: 'Uyarı', Failed: 'Başarısız' };
const COLOR = { ok: '1D9E54', warn: 'D97706', fail: 'DC2626', gray: '6B7480', dark: '111111', line: '2B2B2B', rowline: 'D0D5DA' };
const LOGO_PATHS = ['/web/public/assets/siaflex-logo.png', './public/assets/siaflex-logo.png'];

function logoFile() {
    for (const p of LOGO_PATHS) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// PNG başlığından boyut oku (Word'de oranı korumak için)
function pngSize(buf) {
    try {
        return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    } catch {
        return { w: 1, h: 1 };
    }
}

function fmt(iso, withTime = true) {
    if (!iso) return '—';
    try {
        const opts = withTime
            ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
            : { day: '2-digit', month: '2-digit', year: 'numeric' };
        return new Date(iso).toLocaleString('tr-TR', { ...opts, timeZone: process.env.TZ || 'Europe/Istanbul' });
    } catch {
        return iso;
    }
}

function grandTotals(rep) {
    const g = { jobs: 0, healthy: 0, warning: 0, failed: 0, other: 0, vms: 0, vmsActive: 0, vmsStale: 0, restorePoints: 0, rpBackup: 0, rpSnapshot: 0, rpReplica: 0 };
    for (const s of rep.servers) {
        for (const k of Object.keys(g)) g[k] += s.totals?.[k] || 0;
    }
    return g;
}

function statusInfo(j) {
    if (j.status === 'Running') return { text: 'Çalışıyor', color: '2563EB' };
    if (j.lastResult && RESULT_TR[j.lastResult]) {
        const map = { Success: COLOR.ok, Warning: COLOR.warn, Failed: COLOR.fail };
        return { text: RESULT_TR[j.lastResult] + (j.status === 'Disabled' ? ' (devre dışı)' : ''), color: map[j.lastResult] };
    }
    if (j.status === 'Disabled') return { text: 'Devre dışı', color: COLOR.gray };
    return { text: '—', color: COLOR.gray };
}

function reportParams(rep) {
    return [
        ['Müşteri', rep.query],
        ['Kapsam', 'Job adı ve vSphere resource pool / folder eşleşmesi'],
        ['Sunucular', rep.servers.map((s) => s.server).join(', ') || '—'],
        ['Job türleri', 'Backup, Replikasyon'],
        ['Rapor tarihi', fmt(rep.generatedAt)],
    ];
}

/* ============================== WORD ============================== */
const TBL_W = 9638;
const thinBlack = { style: BorderStyle.SINGLE, size: 6, color: COLOR.line };
const thinGray = { style: BorderStyle.SINGLE, size: 4, color: COLOR.rowline };
const none = { style: BorderStyle.NIL };
const noBorders = { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };

function run(text, { size = 20, bold = false, color = COLOR.dark, italics = false } = {}) {
    return new TextRun({ text, size, bold, color, italics });
}

function para(children, { before = 0, after = 60, align } = {}) {
    return new Paragraph({ spacing: { before, after }, alignment: align, children: Array.isArray(children) ? children : [children] });
}

function cell(children, { width, margins = { top: 60, bottom: 60, left: 80, right: 80 }, valign = VerticalAlign.CENTER } = {}) {
    return new TableCell({
        width: { size: width, type: WidthType.DXA },
        verticalAlign: valign,
        margins,
        children: Array.isArray(children) ? children : [children],
    });
}

// Her tabloya MUTLAKA columnWidths + fixed layout (Word'ün autofit bozması ve
// ızgarasız tabloları şerite çevirmesi bu ikisinin eksikliğindendi)
function table(rows, columnWidths, borders = noBorders) {
    return new Table({
        width: { size: TBL_W, type: WidthType.DXA },
        columnWidths,
        borders,
        rows,
        layout: TableLayoutType.FIXED,
    });
}

export async function reportToDocx(rep) {
    const g = grandTotals(rep);
    const children = [];

    // Başlık satırı: solda başlık + açıklama, sağda logo
    const titleCell = cell([
        para(run(`${rep.query} - Yedekleme ve Replikasyon Raporu`, { size: 32, bold: true }), { after: 40 }),
        para(run('Bu rapor, seçilen müşteri için korunan makinelerin yedekleme ve replikasyon durumunu özetler.', { size: 16, color: COLOR.gray }), { after: 0 }),
    ], { width: 7300, valign: VerticalAlign.TOP, margins: { top: 0, bottom: 0, left: 0, right: 80 } });
    const logoChildren = [];
    const lf = logoFile();
    if (lf) {
        const buf = fs.readFileSync(lf);
        const { w, h } = pngSize(buf);
        const targetH = 34;
        logoChildren.push(para(new ImageRun({
            type: 'png',
            data: buf,
            transformation: { width: Math.round((w / h) * targetH), height: targetH },
        }), { after: 0, align: AlignmentType.RIGHT }));
    } else {
        logoChildren.push(para(run('Siaflex', { size: 30, bold: true, color: '00B336' }), { after: 0, align: AlignmentType.RIGHT }));
    }
    children.push(table(
        [new TableRow({ children: [titleCell, cell(logoChildren, { width: 2338, valign: VerticalAlign.TOP, margins: { top: 0, bottom: 0, left: 80, right: 0 } })] })],
        [7300, 2338],
    ));
    children.push(para(run('', { size: 8 }), { after: 160 }));

    // Rapor Parametreleri
    children.push(para(run('Rapor Parametreleri', { size: 24, bold: true }), { before: 120, after: 80 }));
    for (const [k, v] of reportParams(rep)) {
        children.push(table(
            [new TableRow({
                children: [
                    cell(para(run(k, { size: 18, color: '444444' }), { after: 0 }), { width: 2600, margins: { top: 40, bottom: 40, left: 0, right: 80 } }),
                    cell(para(run(v, { size: 18 }), { after: 0 }), { width: 7038, margins: { top: 40, bottom: 40, left: 0, right: 0 } }),
                ],
            })],
            [2600, 7038],
        ));
    }

    // Özet
    children.push(para(run('Özet', { size: 24, bold: true }), { before: 260, after: 80 }));
    const sumHead = ['Job', 'Başarılı', 'Uyarı', 'Başarısız', 'Çalışıyor/Diğer', 'Makine', 'Restore Point'];
    const sumVals = [
        [String(g.jobs), COLOR.dark], [String(g.healthy), COLOR.ok], [String(g.warning), COLOR.warn],
        [String(g.failed), COLOR.fail], [String(g.other), '2563EB'], [String(g.vms), COLOR.dark], [String(g.restorePoints), COLOR.dark],
    ];
    const sw = Math.floor(TBL_W / 7);
    const sumWidths = [sw, sw, sw, sw, sw, sw, TBL_W - 6 * sw];
    children.push(table([
        new TableRow({
            tableHeader: true,
            children: sumHead.map((h, i) => cell(para(run(h, { size: 17, bold: true, color: '444444' }), { after: 0, align: AlignmentType.CENTER }), { width: sumWidths[i] })),
        }),
        new TableRow({
            children: sumVals.map(([v, c], i) => cell(para(run(v, { size: 26, bold: true, color: c }), { after: 0, align: AlignmentType.CENTER }), { width: sumWidths[i] })),
        }),
    ], sumWidths, { top: thinBlack, bottom: thinBlack, left: none, right: none, insideHorizontal: thinGray, insideVertical: none }));
    children.push(para(run(
        `Makine: ${g.vmsActive} aktif · ${g.vmsStale} eski/silinmiş      —      Restore point: yedek ${g.rpBackup} · storage snapshot ${g.rpSnapshot} · replika ${g.rpReplica}`,
        { size: 17, color: COLOR.gray },
    ), { before: 60, after: 0 }));

    // Detaylar
    children.push(para(run('Detaylar', { size: 24, bold: true }), { before: 300, after: 60 }));
    for (const s of rep.servers) {
        // Eslesmesi de hatasi da olmayan sunucular rapora girmez
        if (!s.error && !s.jobs.length) continue;
        children.push(para(run(s.server, { size: 21, bold: true }), { before: 160, after: 40 }));
        if (s.error) {
            children.push(para(run(s.error, { size: 18, color: COLOR.fail })));
            continue;
        }

        for (const j of s.jobs) {
            const st = statusInfo(j);
            children.push(para([
                run(j.name, { size: 19, bold: true }),
                run(`    ${j.kind}`, { size: 16, color: COLOR.gray }),
                run('    ', { size: 16 }),
                run(st.text, { size: 17, bold: true, color: st.color }),
            ], { before: 140, after: 20 }));
            const meta = [];
            if (j.retention) meta.push(`Saklama: ${j.retention}`);
            if (j.lastRun) meta.push(`Son çalışma: ${fmt(j.lastRun)}`);
            if (j.nextRun) meta.push(`Sonraki: ${fmt(j.nextRun)}`);
            if (meta.length) children.push(para(run(meta.join('    ·    '), { size: 16, color: COLOR.gray }), { after: 60 }));
            if (j.note) {
                children.push(para(run(j.note, { size: 16, color: '8A6D1A', italics: true }), { after: 60 }));
            }
            const lt = j.lastRunTasks;
            if (lt) {
                children.push(para([
                    run(`Son çalışma (${fmt(lt.endTime)}): ${lt.total} makine → `, { size: 17, bold: true }),
                    run(`${lt.success} başarılı`, { size: 17, bold: true, color: COLOR.ok }),
                    run(' · ', { size: 17, color: COLOR.gray }),
                    run(`${lt.warning} uyarı`, { size: 17, bold: true, color: COLOR.warn }),
                    run(' · ', { size: 17, color: COLOR.gray }),
                    run(`${lt.failed} başarısız`, { size: 17, bold: true, color: COLOR.fail }),
                ], { after: 40 }));
                for (const v of lt.failedVms.slice(0, 15)) {
                    children.push(para(run(`✗ ${v.name}${v.message && v.message !== 'Failed' ? ' — ' + v.message : ''}`, { size: 16, color: COLOR.fail }), { after: 20 }));
                }
                if (lt.failedVms.length > 15) {
                    children.push(para(run(`… ve ${lt.failedVms.length - 15} makine daha`, { size: 16, color: COLOR.fail }), { after: 20 }));
                }
                for (const v of lt.warningVms.slice(0, 8)) {
                    children.push(para(run(`⚠ ${v.name}${v.message && v.message !== 'Warning' ? ' — ' + v.message : ''}`, { size: 16, color: COLOR.warn }), { after: 20 }));
                }
                if (lt.warningVms.length > 8) {
                    children.push(para(run(`… ve ${lt.warningVms.length - 8} makine daha`, { size: 16, color: COLOR.warn }), { after: 20 }));
                }
            }

            for (const b of j.backups || []) {
                if (!b.vms.length) continue;
                children.push(para(run(
                    `${b.name !== j.name ? b.name + '  —  ' : ''}${b.vms.length} makine${b.staleCount ? ` (${b.activeCount} aktif · ${b.staleCount} eski/silinmiş)` : ''} · ${b.totalRestorePoints} restore point`,
                    { size: 16, color: '444444' },
                ), { before: 60, after: 40 }));
                const widths = [3600, 1500, 1900, 1900, TBL_W - 3600 - 1500 - 1900 - 1900];
                const head = ['Makine', 'Restore Point', 'En Yeni Nokta', 'En Eski Nokta', 'Depo'];
                const rows = [new TableRow({
                    tableHeader: true,
                    children: head.map((h, i) => cell(
                        para(run(h, { size: 16, bold: true }), { after: 0, align: i === 1 ? AlignmentType.CENTER : undefined }),
                        { width: widths[i], margins: { top: 60, bottom: 60, left: 60, right: 60 } },
                    )),
                })];
                for (const v of b.vms) {
                    rows.push(new TableRow({
                        children: [
                            cell(para(run(String(v.name) + (v.active === false ? '  (eski/silinmiş)' : ''), { size: 17, color: v.active === false ? '9AA0A6' : COLOR.dark }), { after: 0 }), { width: widths[0], margins: { top: 50, bottom: 50, left: 60, right: 60 } }),
                            cell(para(run(v.restorePoints == null ? '—' : String(v.restorePoints), { size: 17 }), { after: 0, align: AlignmentType.CENTER }), { width: widths[1], margins: { top: 50, bottom: 50, left: 60, right: 60 } }),
                            cell(para(run(fmt(v.newest || b.newestPoint), { size: 16, color: '333333' }), { after: 0 }), { width: widths[2], margins: { top: 50, bottom: 50, left: 60, right: 60 } }),
                            cell(para(run(fmt(v.oldest || b.oldestPoint), { size: 16, color: '333333' }), { after: 0 }), { width: widths[3], margins: { top: 50, bottom: 50, left: 60, right: 60 } }),
                            cell(para(run(b.repository || '—', { size: 16, color: '333333' }), { after: 0 }), { width: widths[4], margins: { top: 50, bottom: 50, left: 60, right: 60 } }),
                        ],
                    }));
                }
                children.push(table(rows, widths, {
                    top: thinBlack, bottom: thinBlack, left: none, right: none,
                    insideHorizontal: thinGray, insideVertical: none,
                }));
                children.push(para(run('', { size: 6 }), { after: 80 }));
            }
        }
    }

    // Job Yapılandırmaları (raporun sonunda)
    const cfgRows = rep.servers.flatMap((s) => (s.jobs || []).filter((j) => j.policy || j.retention));
    if (cfgRows.length) {
        children.push(para(run('Job Yapılandırmaları', { size: 24, bold: true }), { before: 300, after: 80 }));
        const widths = [2400, 1850, 1350, 2238, 1800];
        const head = ['Job', 'Zamanlama', 'Saklama', 'Uzun Dönem (GFS)', 'Silinemezlik'];
        const rows = [new TableRow({
            tableHeader: true,
            children: head.map((h, i) => cell(
                para(run(h, { size: 16, bold: true }), { after: 0 }),
                { width: widths[i], margins: { top: 60, bottom: 60, left: 60, right: 60 } },
            )),
        })];
        for (const j of cfgRows) {
            const vals = [j.name, j.policy?.schedule || '—', j.retention || '—', j.policy?.gfs || '—', j.policy?.immutability || '—'];
            rows.push(new TableRow({
                children: vals.map((v, i) => cell(
                    para(run(String(v), { size: 16, bold: i === 0 }), { after: 0 }),
                    { width: widths[i], margins: { top: 50, bottom: 50, left: 60, right: 60 } },
                )),
            }));
        }
        children.push(table(rows, widths, {
            top: thinBlack, bottom: thinBlack, left: none, right: none,
            insideHorizontal: thinGray, insideVertical: none,
        }));
    }

    const doc = new Document({
        styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
        sections: [{
            properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
            children,
        }],
    });
    return Packer.toBuffer(doc);
}

/* ============================== PDF ============================== */
function findFont(bold) {
    const names = bold ? ['DejaVuSans-Bold.ttf'] : ['DejaVuSans.ttf'];
    const dirs = ['/usr/share/fonts/ttf-dejavu/', '/usr/share/fonts/dejavu/', '/usr/share/fonts/truetype/dejavu/', '/usr/share/fonts/TTF/'];
    for (const d of dirs) {
        for (const n of names) {
            if (fs.existsSync(d + n)) return d + n;
        }
    }
    return null;
}

export function reportToPdf(rep, stream) {
    const doc = new PDFDocument({ margin: 46, size: 'A4', bufferPages: true });
    doc.pipe(stream);
    const F = findFont(false) || 'Helvetica';
    const FB = findFont(true) || 'Helvetica-Bold';
    const L = doc.page.margins.left;
    const R = doc.page.width - doc.page.margins.right;
    const W = R - L;
    const hx = (c) => '#' + c;

    const pageBreak = (need = 60) => {
        if (doc.y > doc.page.height - doc.page.margins.bottom - need) {
            doc.addPage();
            doc.y = doc.page.margins.top;
            doc.x = L;
        }
    };

    const section = (title) => {
        pageBreak(80);
        doc.moveDown(0.9);
        doc.font(FB).fontSize(13).fillColor(hx(COLOR.dark)).text(title, L, doc.y);
        doc.moveDown(0.35);
    };

    // --- Başlık: solda başlık + açıklama, sağda logo ---
    const lf = logoFile();
    if (lf) {
        try { doc.image(lf, R - 130, L - 12, { fit: [130, 36], align: 'right' }); } catch { /* logo okunamadı */ }
    }
    doc.font(FB).fontSize(16).fillColor(hx(COLOR.dark)).text(`${rep.query} - Yedekleme ve Replikasyon Raporu`, L, 44, { width: W - 145 });
    doc.font(F).fontSize(8.5).fillColor(hx(COLOR.gray))
        .text('Bu rapor, seçilen müşteri için korunan makinelerin yedekleme ve replikasyon durumunu özetler.', L, doc.y + 3, { width: W - 145 });

    // --- Rapor Parametreleri ---
    section('Rapor Parametreleri');
    doc.font(F).fontSize(9);
    for (const [k, v] of reportParams(rep)) {
        const y = doc.y;
        doc.fillColor('#444444').text(k, L, y, { width: 130, lineBreak: false });
        doc.fillColor(hx(COLOR.dark)).text(String(v), L + 140, y, { width: W - 140 });
        doc.y += 4;
    }

    // --- Özet ---
    const g = grandTotals(rep);
    section('Özet');
    {
        const cols = [
            { h: 'Job', v: String(g.jobs), c: COLOR.dark },
            { h: 'Başarılı', v: String(g.healthy), c: COLOR.ok },
            { h: 'Uyarı', v: String(g.warning), c: COLOR.warn },
            { h: 'Başarısız', v: String(g.failed), c: COLOR.fail },
            { h: 'Çalışıyor/Diğer', v: String(g.other), c: '2563EB' },
            { h: 'Makine', v: String(g.vms), c: COLOR.dark },
            { h: 'Restore Point', v: String(g.restorePoints), c: COLOR.dark },
        ];
        const cw = W / cols.length;
        const yh = doc.y;
        doc.moveTo(L, yh - 2).lineTo(R, yh - 2).strokeColor(hx(COLOR.line)).lineWidth(0.8).stroke();
        cols.forEach((c, i) => {
            doc.font(F).fontSize(8).fillColor('#444444').text(c.h, L + i * cw, yh + 4, { width: cw, align: 'center' });
        });
        cols.forEach((c, i) => {
            doc.font(FB).fontSize(15).fillColor(hx(c.c)).text(c.v, L + i * cw, yh + 17, { width: cw, align: 'center' });
        });
        const yb = yh + 40;
        doc.moveTo(L, yb).lineTo(R, yb).strokeColor(hx(COLOR.line)).lineWidth(0.8).stroke();
        doc.font(F).fontSize(8.5).fillColor(hx(COLOR.gray))
            .text(`Makine: ${g.vmsActive} aktif · ${g.vmsStale} eski/silinmiş      —      Restore point: yedek ${g.rpBackup} · snapshot ${g.rpSnapshot} · replika ${g.rpReplica}`, L, yb + 6, { width: W });
        doc.y = yb + 20;
    }

    // --- Grafik: job başına restore point (Veeam ONE tarzı dikey çubuklar) ---
    // Çıktısı olmayan job'lar (snapshot kabukları) grafikte 0'lık yanıltıcı
    // çubuk oluşturur — yalnızca veri taşıyan bölümler çizilir
    const chartJobs = rep.servers.flatMap((s) => (s.jobs || [])
        .filter((j) => (j.backups || []).length)
        .map((j) => ({
            name: j.name,
            rp: (j.backups || []).reduce((a, b) => a + (b.totalRestorePoints || 0), 0),
            color: statusInfo(j).color,
        }))).slice(0, 14);
    if (chartJobs.length) {
        section('Job Başına Restore Point');
        const chH = 110;
        pageBreak(chH + 74);
        const baseY = doc.y + chH + 14;
        const maxRp = Math.max(1, ...chartJobs.map((c) => c.rp));
        const slot = W / chartJobs.length;
        const barW = Math.min(46, slot * 0.55);
        // y ekseni çizgileri
        for (const frac of [0, 0.5, 1]) {
            const gy = baseY - chH * frac;
            doc.moveTo(L, gy).lineTo(R, gy).strokeColor(frac === 0 ? hx(COLOR.line) : '#E4E7EA').lineWidth(frac === 0 ? 0.8 : 0.5).stroke();
            doc.font(F).fontSize(6.5).fillColor('#999999').text(String(Math.round(maxRp * frac)), L - 34, gy - 3, { width: 30, align: 'right', lineBreak: false });
        }
        chartJobs.forEach((c, i) => {
            const x = L + i * slot + (slot - barW) / 2;
            const bh = Math.max(2, (c.rp / maxRp) * chH);
            doc.rect(x, baseY - bh, barW, bh).fill(hx(c.color === COLOR.gray ? '9AA69E' : c.color));
            doc.font(F).fontSize(7).fillColor('#333333').text(String(c.rp), x - 6, baseY - bh - 10, { width: barW + 12, align: 'center' });
            const label = c.name.length > 34 ? c.name.slice(0, 33) + '…' : c.name;
            doc.font(F).fontSize(6.5).fillColor('#555555')
                .text(label, L + i * slot + 2, baseY + 4, { width: slot - 4, align: 'center', height: 16 });
        });
        doc.y = baseY + 26;
        // gösterge
        const legend = [['Başarılı', COLOR.ok], ['Uyarı', COLOR.warn], ['Başarısız', COLOR.fail], ['Diğer', '9AA69E']];
        let lx = L;
        for (const [t, c] of legend) {
            doc.circle(lx + 3, doc.y + 4, 3).fill(hx(c));
            doc.font(F).fontSize(7.5).fillColor('#555555').text(t, lx + 10, doc.y, { lineBreak: false });
            lx += 14 + doc.widthOfString(t) + 16;
        }
        doc.y += 14;
        doc.x = L;
    }

    // --- Detaylar ---
    section('Detaylar');
    for (const s of rep.servers) {
        if (!s.error && !s.jobs.length) continue;
        pageBreak(70);
        doc.font(FB).fontSize(11).fillColor(hx(COLOR.dark)).text(s.server, L, doc.y);
        doc.moveDown(0.2);
        if (s.error) {
            doc.font(F).fontSize(9).fillColor(hx(COLOR.fail)).text(s.error, L, doc.y, { width: W });
            continue;
        }

        for (const j of s.jobs) {
            pageBreak(80);
            const st = statusInfo(j);
            doc.moveDown(0.4);
            doc.font(FB).fontSize(9.5).fillColor(hx(COLOR.dark)).text(j.name, L, doc.y, { continued: true });
            doc.font(F).fontSize(8).fillColor(hx(COLOR.gray)).text(`   ${j.kind}`, { continued: true });
            doc.font(FB).fontSize(8.5).fillColor(hx(st.color)).text(`   ${st.text}`);
            const meta = [];
            if (j.retention) meta.push(`Saklama: ${j.retention}`);
            if (j.lastRun) meta.push(`Son çalışma: ${fmt(j.lastRun)}`);
            if (j.nextRun) meta.push(`Sonraki: ${fmt(j.nextRun)}`);
            if (meta.length) doc.font(F).fontSize(7.8).fillColor(hx(COLOR.gray)).text(meta.join('    ·    '), L, doc.y + 1);
            if (j.note) {
                doc.font(F).fontSize(8).fillColor('#8a6d1a').text(j.note, L, doc.y + 2, { width: W, oblique: true });
            }
            const lt = j.lastRunTasks;
            if (lt) {
                pageBreak(30);
                doc.font(FB).fontSize(8.2).fillColor('#333333')
                    .text(`Son çalışma (${fmt(lt.endTime)}): ${lt.total} makine → `, L, doc.y + 2, { continued: true });
                doc.fillColor(hx(COLOR.ok)).text(`${lt.success} başarılı`, { continued: true });
                doc.fillColor('#666666').text(' · ', { continued: true });
                doc.fillColor(hx(COLOR.warn)).text(`${lt.warning} uyarı`, { continued: true });
                doc.fillColor('#666666').text(' · ', { continued: true });
                doc.fillColor(hx(COLOR.fail)).text(`${lt.failed} başarısız`);
                for (const v of lt.failedVms.slice(0, 15)) {
                    pageBreak(20);
                    doc.font(F).fontSize(8).fillColor(hx(COLOR.fail))
                        .text(`✗ ${v.name}${v.message && v.message !== 'Failed' ? ' — ' + v.message : ''}`, L + 10, doc.y + 1, { width: W - 20 });
                }
                if (lt.failedVms.length > 15) {
                    doc.font(F).fontSize(8).fillColor(hx(COLOR.fail)).text(`… ve ${lt.failedVms.length - 15} makine daha`, L + 10, doc.y + 1);
                }
                for (const v of lt.warningVms.slice(0, 8)) {
                    pageBreak(20);
                    doc.font(F).fontSize(8).fillColor(hx(COLOR.warn))
                        .text(`⚠ ${v.name}${v.message && v.message !== 'Warning' ? ' — ' + v.message : ''}`, L + 10, doc.y + 1, { width: W - 20 });
                }
                if (lt.warningVms.length > 8) {
                    doc.font(F).fontSize(8).fillColor(hx(COLOR.warn)).text(`… ve ${lt.warningVms.length - 8} makine daha`, L + 10, doc.y + 1);
                }
            }

            for (const b of j.backups || []) {
                if (!b.vms.length) continue;
                doc.moveDown(0.3);
                pageBreak(60);
                doc.font(F).fontSize(8.4).fillColor('#444444').text(
                    `${b.name !== j.name ? b.name + '  —  ' : ''}${b.vms.length} makine${b.staleCount ? ` (${b.activeCount} aktif · ${b.staleCount} eski/silinmiş)` : ''} · ${b.totalRestorePoints} restore point`,
                    L, doc.y, { width: W });
                doc.moveDown(0.2);
                // tablo başlığı
                const cols = [
                    { h: 'Makine', w: 0.34, get: (v) => String(v.name) + (v.active === false ? '  (eski/silinmiş)' : '') },
                    { h: 'Restore Point', w: 0.13, get: (v) => (v.restorePoints == null ? '—' : String(v.restorePoints)), align: 'center' },
                    { h: 'En Yeni Nokta', w: 0.18, get: (v) => fmt(v.newest || b.newestPoint) },
                    { h: 'En Eski Nokta', w: 0.18, get: (v) => fmt(v.oldest || b.oldestPoint) },
                    { h: 'Depo', w: 0.17, get: () => b.repository || '—' },
                ];
                let hy = doc.y;
                doc.moveTo(L, hy - 1).lineTo(R, hy - 1).strokeColor(hx(COLOR.line)).lineWidth(0.8).stroke();
                let cx = L;
                for (const c of cols) {
                    doc.font(FB).fontSize(7.8).fillColor(hx(COLOR.dark)).text(c.h, cx + 2, hy + 3, { width: W * c.w - 4, align: c.align });
                    cx += W * c.w;
                }
                let ry = hy + 15;
                doc.moveTo(L, ry).lineTo(R, ry).strokeColor(hx(COLOR.line)).lineWidth(0.8).stroke();
                // satırlar
                for (const v of b.vms) {
                    if (ry > doc.page.height - doc.page.margins.bottom - 24) {
                        doc.addPage();
                        ry = doc.page.margins.top;
                    }
                    let vx = L;
                    const rowColor = v.active === false ? '#9aa0a6' : '#222222';
                    for (const c of cols) {
                        doc.font(F).fontSize(7.8).fillColor(rowColor).text(c.get(v), vx + 2, ry + 4, { width: W * c.w - 4, align: c.align, lineBreak: false });
                        vx += W * c.w;
                    }
                    ry += 15;
                    doc.moveTo(L, ry).lineTo(R, ry).strokeColor('#E1E5E8').lineWidth(0.4).stroke();
                }
                doc.y = ry + 6;
                doc.x = L;
            }
        }
    }

    // --- Job Yapılandırmaları (raporun sonunda) ---
    const cfgRows = rep.servers.flatMap((s) => (s.jobs || [])
        .filter((j) => j.policy || j.retention)
        .map((j) => j));
    if (cfgRows.length) {
        section('Job Yapılandırmaları');
        const ccols = [
            { h: 'Job', w: 0.23, get: (j) => j.name },
            { h: 'Zamanlama', w: 0.19, get: (j) => j.policy?.schedule || '—' },
            { h: 'Saklama', w: 0.14, get: (j) => j.retention || '—' },
            { h: 'Uzun Dönem (GFS)', w: 0.24, get: (j) => j.policy?.gfs || '—' },
            { h: 'Silinemezlik', w: 0.20, get: (j) => j.policy?.immutability || '—' },
        ];
        let ry = doc.y;
        const drawHead = () => {
            doc.moveTo(L, ry - 1).lineTo(R, ry - 1).strokeColor(hx(COLOR.line)).lineWidth(0.8).stroke();
            let cx = L;
            for (const c of ccols) {
                doc.font(FB).fontSize(7.8).fillColor(hx(COLOR.dark)).text(c.h, cx + 2, ry + 3, { width: W * c.w - 6, lineBreak: false });
                cx += W * c.w;
            }
            ry += 15;
            doc.moveTo(L, ry).lineTo(R, ry).strokeColor(hx(COLOR.line)).lineWidth(0.8).stroke();
        };
        drawHead();
        for (const j of cfgRows) {
            const texts = ccols.map((c) => String(c.get(j)));
            doc.font(F).fontSize(7.8);
            const rh = Math.max(...texts.map((t, i) => doc.heightOfString(t, { width: W * ccols[i].w - 6 }))) + 8;
            if (ry + rh > doc.page.height - doc.page.margins.bottom - 20) {
                doc.addPage();
                ry = doc.page.margins.top;
                drawHead();
            }
            let cx = L;
            texts.forEach((t, i) => {
                doc.font(F).fontSize(7.8).fillColor('#222222').text(t, cx + 2, ry + 4, { width: W * ccols[i].w - 6 });
                cx += W * ccols[i].w;
            });
            ry += rh;
            doc.moveTo(L, ry).lineTo(R, ry).strokeColor('#E1E5E8').lineWidth(0.4).stroke();
        }
        doc.y = ry + 6;
        doc.x = L;
    }

    // --- Altbilgi ---
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        // pdfkit, alt kenar boşluğu içine yazınca otomatik yeni sayfa açar —
        // altbilgi yazarken boşluğu geçici sıfırla (klasik pdfkit footer deseni)
        const savedBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font(F).fontSize(7).fillColor('#666666')
            .text(`Rapor tarihi: ${fmt(rep.generatedAt)} (UTC+03:00) · Siaflex Sbee`, L, doc.page.height - 30, { width: W / 2, lineBreak: false })
            .text(`Sayfa ${i + 1}`, L + W / 2, doc.page.height - 30, { width: W / 2, align: 'right', lineBreak: false });
        doc.page.margins.bottom = savedBottom;
    }
    doc.end();
}
