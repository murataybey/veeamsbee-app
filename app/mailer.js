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
const MAILCFG_FILE = process.env.MAILCONFIG_FILE || '/web/data/mailconfig.json';

let mailCfg = {};
try {
    mailCfg = JSON.parse(fs.readFileSync(MAILCFG_FILE, 'utf8')) || {};
} catch { /* ilk çalıştırma */ }

function cfgVal(k, envK) {
    return (mailCfg[k] !== undefined && mailCfg[k] !== '') ? mailCfg[k] : process.env[envK];
}

// Arayüze dönen görünüm — parola asla dönmez
export function getMailConfig() {
    return {
        host: cfgVal('host', 'SMTP_HOST') || '',
        port: Number(cfgVal('port', 'SMTP_PORT') || 587),
        user: cfgVal('user', 'SMTP_USER') || '',
        hasPass: Boolean(cfgVal('pass', 'SMTP_PASS')),
        secure: String(cfgVal('secure', 'SMTP_SECURE')) === 'true',
        from: cfgVal('from', 'MAIL_FROM') || '',
        configured: Boolean((cfgVal('host', 'SMTP_HOST') || '') && (cfgVal('from', 'MAIL_FROM') || '')),
    };
}

export function setMailConfig({ host, port, user, pass, secure, from }) {
    mailCfg = {
        host: String(host || '').trim(),
        port: Number(port) || 587,
        user: String(user || '').trim(),
        // Boş bırakılan parola alanı mevcut parolayı korur
        pass: pass ? String(pass) : (mailCfg.pass || ''),
        secure: secure === true || secure === 'true',
        from: String(from || '').trim(),
    };
    fs.mkdirSync(path.dirname(MAILCFG_FILE), { recursive: true });
    fs.writeFileSync(MAILCFG_FILE, JSON.stringify(mailCfg, null, 2), { mode: 0o600 });
}

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
    return getMailConfig().configured;
}

function transport() {
    const c = getMailConfig();
    return nodemailer.createTransport({
        host: c.host,
        port: c.port,
        secure: c.secure,
        auth: c.user ? { user: c.user, pass: String(cfgVal('pass', 'SMTP_PASS') || '') } : undefined,
        tls: { rejectUnauthorized: false },
        connectionTimeout: 20000,
        greetingTimeout: 20000,
    });
}

// nodemailer hatalarını yöneticinin doğrudan aksiyon alabileceği Türkçe metne çevirir
function smtpErrText(err) {
    const code = err?.code || '';
    const host = getMailConfig().host;
    if (code === 'EDNS' || code === 'EAI_AGAIN' || code === 'ENOTFOUND') {
        return `Sunucu adı çözümlenemedi (DNS): "${host}" — adı kontrol edin; kısa ad yerine tam alan adı (FQDN) veya IP deneyin.`;
    }
    if (code === 'ECONNREFUSED') {
        return `Bağlantı reddedildi: ${host} — port kapalı ya da SMTP servisi bu portu dinlemiyor.`;
    }
    if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION' || /timeout/i.test(String(err?.message || ''))) {
        return `Bağlantı kurulamadı (zaman aşımı): ${host} — güvenlik duvarının Sbee sunucusundan (10.11.18.110) bu porta erişime izin verdiğini kontrol edin.`;
    }
    if (code === 'EAUTH') {
        return 'Kimlik doğrulama başarısız — kullanıcı adı ve parolayı kontrol edin.' + (err?.response ? ` Sunucu yanıtı: ${err.response}` : '');
    }
    let m = String(err?.message || err);
    if (err?.response && !m.includes(err.response)) m += ' — sunucu yanıtı: ' + err.response;
    return m;
}

// SMTP bağlantı + isteğe bağlı test maili. Rapor üretmeden hızlıca doğrular.
export async function testSmtp(to) {
    if (!mailConfigured()) {
        throw new Error('SMTP yapılandırılmamış — önce formu doldurup kaydedin.');
    }
    const t = transport();
    try {
        await t.verify();
    } catch (err) {
        throw new Error('Bağlantı testi başarısız: ' + smtpErrText(err));
    }
    const addr = String(to || '').trim();
    if (!addr) return { verified: true, sent: false };
    try {
        await t.sendMail({
            from: getMailConfig().from,
            to: addr,
            subject: `Sbee SMTP testi (${trDate()})`,
            html: '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">'
                + '<p>Bu bir <b>Siaflex Sbee</b> SMTP test iletisidir.</p>'
                + '<p>Bu maili aldıysanız gönderim ayarları çalışıyor demektir; zamanlanmış raporlar da aynı yoldan gönderilecek. 🐝</p></div>',
        });
    } catch (err) {
        throw new Error('Bağlantı kuruldu ancak gönderim başarısız: ' + smtpErrText(err));
    }
    return { verified: true, sent: true, to: addr };
}

export function listMailReports() {
    return entries;
}

export function addMailReport({ query, days, to, hour, types }) {
    const entry = {
        id: 'mr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        query: String(query).trim(),
        days: Number(days) >= 1 && Number(days) <= 90 ? Number(days) : 7,
        to: (Array.isArray(to) ? to : String(to).split(/[,;\s]+/)).map((s) => s.trim()).filter(Boolean),
        hour: Number(hour) >= 0 && Number(hour) <= 23 ? Number(hour) : 8,
        types: ['backup', 'replica'].includes(types) ? types : 'all',
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
    try {
        await sendReportMailCore(entry);
    } catch (err) {
        const msg = smtpErrText(err);
        const stored = entries.find((e) => e.id === entry.id);
        if (stored) {
            stored.lastResult = 'Hata: ' + msg;
            persist();
        }
        throw new Error(msg);
    }
}

async function sendReportMailCore(entry) {
    if (!mailConfigured()) {
        throw new Error('SMTP yapılandırılmamış — Ayarlar → E-posta Raporları sekmesindeki SMTP formunu doldurup kaydedin.');
    }
    const rep = await customerReport(entry.query, entry.days || null, entry.types || 'all');
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
    const showB = (entry.types || 'all') !== 'replica';
    const showR = (entry.types || 'all') !== 'backup';
    const protHtml = prot ? `<p><b>Koruma durumu (son ${prot.days} gün):</b> ${prot.summary.total} aktif makine — `
        + (showB ? `Yedek: <span style="color:#1D9E54">${prot.summary.backupOk} güncel</span> / <span style="color:#DC2626">${prot.summary.backupMiss} eksik</span>` : '')
        + (showB && showR ? ' · ' : '')
        + (showR ? `Replika: <span style="color:#1D9E54">${prot.summary.replicaOk} güncel</span> / <span style="color:#DC2626">${prot.summary.replicaMiss} eksik</span>` + (prot.summary.noReplica ? ` / ${prot.summary.noReplica} replikasız` : '') : '')
        + '</p>' : '';
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222222">`
        + `<h2 style="margin:0 0 4px">${entry.query} — Yedekleme ve Replikasyon Raporu</h2>`
        + `<p style="color:#777777;margin:0 0 14px">${trDate()} · Siaflex Sbee</p>`
        + `<p><b>Özet:</b> ${g.jobs} job · <span style="color:#1D9E54">${g.healthy} başarılı</span> · `
        + `<span style="color:#D97706">${g.warning} uyarı</span> · <span style="color:#DC2626">${g.failed} başarısız</span></p>`
        + protHtml
        + `<p>Ayrıntılar ekteki PDF raporundadır.</p></div>`;

    await transport().sendMail({
        from: getMailConfig().from,
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
