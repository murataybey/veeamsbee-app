// Zamanlanmış e-posta raporları: müşteri + dönem + saat + alıcılar.
// SMTP ayarları .env'den gelir (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
// SMTP_SECURE, MAIL_FROM). Rapor PDF olarak eklenir, gövdede kısa özet olur.
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import nodemailer from 'nodemailer';
import { customerReport } from './monitor.js';
import { reportToPdf } from './report-export.js';

const MAIL_FILE = process.env.MAILREPORTS_FILE || '/web/data/mailreports.json';

let entries = [];
try {
    const saved = JSON.parse(fs.readFileSync(MAIL_FILE, 'utf8'));
    if (Array.isArray(saved)) entries = saved;
} catch { /* ilk çalıştırma */ }

function persist() {
    try {
        fs.mkdirSync(path.dirname(MAIL_FILE), { recursive: true });
        fs.writeFileSync(MAIL_FILE, JSON.stringify(entries, null, 2), { mode: 0o600 });
    } catch (err) {
        console.error('mailreports persist failed:', err?.message || err);
    }
}

export function mailConfigured() {
    return Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM);
}

function transport() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
            : undefined,
        tls: { rejectUnauthorized: false },
    });
}

export function listMailReports() {
    return entries;
}

export function addMailReport({ query, days, to, hour }) {
    const entry = {
        id: 'mr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        query: String(query).trim(),
        days: Number(days) >= 1 && Number(days) <= 90 ? Number(days) : 7,
        to: (Array.isArray(to) ? to : String(to).split(/[,;\s]+/)).map((s) => s.trim()).filter(Boolean),
        hour: Number(hour) >= 0 && Number(hour) <= 23 ? Number(hour) : 8,
        enabled: true,
        lastSentDay: null,
        lastResult: null,
    };
    if (!entry.query || entry.query.length < 2) throw new Error('Müşteri adı gerekli.');
    if (!entry.to.length) throw new Error('En az bir alıcı e-posta adresi gerekli.');
    entries.push(entry);
    persist();
    return entry;
}

export function deleteMailReport(id) {
    const i = entries.findIndex((e) => e.id === id);
    if (i === -1) return false;
    entries.splice(i, 1);
    persist();
    return true;
}

function trToday() {
    // Europe/Istanbul gün ve saat ('sv-SE' → YYYY-MM-DD HH:mm:ss biçimi verir)
    const s = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' });
    return { day: s.slice(0, 10), hour: Number(s.slice(11, 13)) };
}

function trDate() {
    return new Date().toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' });
}

function pdfBuffer(rep) {
    return new Promise((resolve, reject) => {
        const pt = new PassThrough();
        const chunks = [];
        pt.on('data', (c) => chunks.push(c));
        pt.on('end', () => resolve(Buffer.concat(chunks)));
        pt.on('error', reject);
        reportToPdf(rep, pt);
    });
}

export async function sendReportMail(entry) {
    if (!mailConfigured()) {
        throw new Error('SMTP yapılandırılmamış — sunucudaki .env dosyasına SMTP_HOST, MAIL_FROM (gerekirse SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE) ekleyip yeniden başlatın.');
    }
    const rep = await customerReport(entry.query, entry.days || null);
    if (rep.servers.length && rep.servers.every((s) => s.error)) {
        throw new Error('Hiçbir Veeam sunucusuna erişilemedi; rapor gönderilmedi.');
    }
    const buf = await pdfBuffer(rep);

    const g = { jobs: 0, healthy: 0, warning: 0, failed: 0 };
    let prot = null;
    for (const s of rep.servers) {
        for (const k of Object.keys(g)) g[k] += s.totals?.[k] || 0;
        if (s.protection?.vms?.length) prot = s.protection;
    }
    const protHtml = prot ? `<p><b>Koruma durumu (son ${prot.days} gün):</b> ${prot.summary.total} aktif makine — `
        + `Yedek: <span style="color:#1D9E54">${prot.summary.backupOk} güncel</span> / <span style="color:#DC2626">${prot.summary.backupMiss} eksik</span> · `
        + `Replika: <span style="color:#1D9E54">${prot.summary.replicaOk} güncel</span> / <span style="color:#DC2626">${prot.summary.replicaMiss} eksik</span>`
        + (prot.summary.noReplica ? ` / ${prot.summary.noReplica} replikasız` : '') + '</p>' : '';
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222222">`
        + `<h2 style="margin:0 0 4px">${entry.query} — Yedekleme ve Replikasyon Raporu</h2>`
        + `<p style="color:#777777;margin:0 0 14px">${trDate()} · Siaflex Sbee</p>`
        + `<p><b>Özet:</b> ${g.jobs} job · <span style="color:#1D9E54">${g.healthy} başarılı</span> · `
        + `<span style="color:#D97706">${g.warning} uyarı</span> · <span style="color:#DC2626">${g.failed} başarısız</span></p>`
        + protHtml
        + `<p>Ayrıntılar ekteki PDF raporundadır.</p></div>`;

    await transport().sendMail({
        from: process.env.MAIL_FROM,
        to: entry.to.join(', '),
        subject: `${entry.query} — Yedekleme ve Replikasyon Raporu (${trDate()})`,
        html,
        attachments: [{
            filename: `rapor-${entry.query.replace(/[^\w-]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.pdf`,
            content: buf,
            contentType: 'application/pdf',
        }],
    });

    const stored = entries.find((e) => e.id === entry.id);
    if (stored) {
        stored.lastSentDay = trToday().day;
        stored.lastResult = 'Gönderildi: ' + new Date().toISOString();
        persist();
    }
}

export function startMailScheduler() {
    const tick = async () => {
        if (!mailConfigured() || !entries.length) return;
        const { day, hour } = trToday();
        for (const e of entries) {
            if (!e.enabled || Number(e.hour) !== hour || e.lastSentDay === day) continue;
            try {
                await sendReportMail(e);
                console.log(`e-posta raporu gönderildi: ${e.query} → ${e.to.join(', ')}`);
            } catch (err) {
                e.lastResult = 'Hata: ' + String(err?.message || err);
                persist();
                console.error(`e-posta raporu gönderilemedi (${e.query}):`, err?.message || err);
            }
        }
    };
    const timer = setInterval(tick, 10 * 60 * 1000);
    timer.unref?.();
    console.log('e-posta zamanlayıcısı başladı (10 dk aralıkla kontrol)');
}
