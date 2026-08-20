// Sbee izleme katmanı: VBR REST API'den (port 9419) periyodik durum toplama,
// kural motoru ve olay geçmişi. Veeam Intelligence kotası HARCAMAZ.
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const REST_PORT = Number(process.env.VBR_REST_PORT || 9419);
const POLL_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS || 5 * 60 * 1000);
const SESSION_WINDOW_H = Number(process.env.MONITOR_SESSION_WINDOW_H || 24);
const RPO_HOURS = Number(process.env.MONITOR_RPO_HOURS || 26);
const REPO_WARN_PCT = Number(process.env.MONITOR_REPO_WARN_PCT || 80);
const REPO_CRIT_PCT = Number(process.env.MONITOR_REPO_CRIT_PCT || 90);
const LICENSE_WARN_DAYS = Number(process.env.MONITOR_LICENSE_WARN_DAYS || 30);
const EVENTS_FILE = process.env.EVENTS_FILE || '/web/data/events.json';
const MAX_EVENTS = 500;

// Sunucu sürümüne göre desteklenen API sürümü değişir; yeniden eskiye dener,
// tutanı sunucu bazında ezberleriz.
const API_VERSIONS = ['1.3-rev1', '1.3-rev0', '1.2-rev1', '1.2-rev0', '1.1-rev1'];

// serverId -> { apiVersion, token, tokenExpiresAt }
const authCache = new Map();

function restRequest(host, apiPath, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: host,
            port: REST_PORT,
            path: apiPath,
            method,
            headers,
            rejectUnauthorized: false,
            timeout: 20000,
        }, (res) => {
            let data = '';
            res.on('data', (ch) => { data += ch; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* metin cevap */ }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('timeout', () => req.destroy(new Error('REST isteği zaman aşımına uğradı')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function getToken(srv) {
    const cached = authCache.get(srv.id);
    if (cached?.token && cached.tokenExpiresAt > Date.now() + 60_000) return cached;

    const form = new URLSearchParams({
        grant_type: 'password',
        username: srv.username,
        password: srv.password,
    }).toString();
    const host = new URL(srv.webUrl).hostname;
    const versions = cached?.apiVersion ? [cached.apiVersion] : API_VERSIONS;
    let lastErr = null;
    for (const v of versions) {
        try {
            const res = await restRequest(host, '/api/oauth2/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'x-api-version': v,
                },
                body: form,
            });
            if (res.status === 200 && res.json?.access_token) {
                const entry = {
                    apiVersion: v,
                    token: res.json.access_token,
                    tokenExpiresAt: Date.now() + Math.max(60, (res.json.expires_in || 900) - 60) * 1000,
                };
                authCache.set(srv.id, entry);
                return entry;
            }
            lastErr = new Error(`Kimlik doğrulama başarısız (HTTP ${res.status}${res.json?.message ? ': ' + res.json.message : ''})`);
            // 401 = parola yanlış, sürüm denemeye devam etmenin anlamı yok
            if (res.status === 401) break;
        } catch (err) {
            lastErr = err;
        }
    }
    authCache.delete(srv.id);
    throw lastErr || new Error('Kimlik doğrulama başarısız');
}

async function restGet(srv, auth, apiPath) {
    const host = new URL(srv.webUrl).hostname;
    const res = await restRequest(host, apiPath, {
        headers: {
            Authorization: 'Bearer ' + auth.token,
            'x-api-version': auth.apiVersion,
        },
    });
    if (res.status === 401) {
        authCache.delete(srv.id);
        throw new Error('Oturum süresi doldu (401)');
    }
    return res;
}

// --- Olay geçmişi (kalıcı) ---
let events = [];
try {
    const saved = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
    if (Array.isArray(saved)) events = saved;
} catch { /* ilk çalıştırma */ }

function persistEvents() {
    try {
        fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
        fs.writeFileSync(EVENTS_FILE, JSON.stringify(events.slice(-MAX_EVENTS)));
    } catch (err) {
        console.error('events persist failed:', err?.message || err);
    }
}

function addEvent(type, alert) {
    events.push({
        ts: new Date().toISOString(),
        type, // 'raised' | 'resolved'
        level: alert.level,
        server: alert.server,
        code: alert.code,
        message: alert.message,
        key: alert.key,
    });
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    persistEvents();
}

// --- Kural motoru ---
// Veri kaybı riski taşımayan altyapı/sistem oturum türleri
const SYSTEM_SESSION_TYPES = new Set([
    'VolumesDiscover', 'AgentDiscovery', 'SecurityComplianceAnalyzer',
    'InfrastructureRescan', 'RepositoryMaintenance', 'DatabaseMaintenance',
    'AgentDiscoveryImport',
]);

function evaluateRules(snap) {
    const alerts = [];
    const S = snap.server;
    const add = (level, code, message, keySuffix) => alerts.push({
        key: `${code}:${snap.serverId}:${keySuffix || ''}`,
        level, code, message, server: S, serverId: snap.serverId,
    });

    if (snap.error) {
        add('critical', 'unreachable', `${S}: sunucuya erişilemiyor veya kimlik doğrulama başarısız — ${snap.error}`);
        return alerts;
    }
    for (const j of snap.failedJobs || []) {
        // Sistem oturumları (discovery, compliance vb.) veri kaybı riski taşımaz → uyarı
        const level = SYSTEM_SESSION_TYPES.has(j.type) ? 'warning' : 'critical';
        add(level, 'job-failed', `${S}: "${j.name}" job'ı başarısız${j.message ? ' — ' + j.message : ''}`, j.name);
    }
    for (const j of snap.warningJobs || []) {
        add('warning', 'job-warning', `${S}: "${j.name}" job'ı uyarıyla tamamlandı${j.message ? ' — ' + j.message : ''}`, j.name);
    }
    for (const j of snap.staleJobs || []) {
        add('warning', 'job-stale', `${S}: "${j.name}" ${RPO_HOURS} saattir hiç çalışmamış (son çalışma: ${j.lastRun || 'bilinmiyor'})`, j.name);
    }
    for (const r of snap.repositories || []) {
        if (r.usedPct == null) continue;
        if (r.usedPct >= REPO_CRIT_PCT) {
            add('critical', 'repo-full', `${S}: "${r.name}" deposu %${r.usedPct} dolu (${r.freeGB} GB boş kaldı)`, r.name);
        } else if (r.usedPct >= REPO_WARN_PCT) {
            add('warning', 'repo-warn', `${S}: "${r.name}" deposu %${r.usedPct} doluluğa ulaştı (${r.freeGB} GB boş)`, r.name);
        }
    }
    if (snap.malware?.count > 0) {
        const m = snap.malware.events[0];
        add('critical', 'malware', `${S}: ${snap.malware.count} kötü amaçlı yazılım/şüpheli aktivite tespiti${m ? ' (son: ' + (m.machine || '?') + ')' : ''}`);
    }
    if (snap.license?.expirationDate) {
        const days = Math.floor((new Date(snap.license.expirationDate) - Date.now()) / 86_400_000);
        if (days >= 0 && days <= LICENSE_WARN_DAYS) {
            add(days <= 7 ? 'critical' : 'warning', 'license', `${S}: lisansın bitmesine ${days} gün kaldı`);
        }
    }
    return alerts;
}

// --- Veri toplama ---
function pickSessionInfo(s) {
    return {
        name: s.name,
        type: s.sessionType,
        endTime: s.endTime || null,
        result: s.result?.result || 'None',
        message: (s.result?.message || '').slice(0, 300),
    };
}

async function collectServer(srv) {
    const snap = {
        serverId: srv.id,
        server: srv.name,
        product: srv.product,
        fetchedAt: new Date().toISOString(),
    };
    if (srv.product !== 'vbr') {
        snap.error = 'İzleme şimdilik yalnızca VBR sunucularını destekliyor';
        snap.unsupported = true;
        return snap;
    }
    try {
        const auth = await getToken(srv);
        snap.apiVersion = auth.apiVersion;
        const since = new Date(Date.now() - SESSION_WINDOW_H * 3600_000).toISOString();

        const [jobsRes, sessionsRes, reposRes, malwareRes, licenseRes] = await Promise.all([
            restGet(srv, auth, '/api/v1/jobs/states?limit=500'),
            restGet(srv, auth, `/api/v1/sessions?limit=500&createdAfterFilter=${encodeURIComponent(since)}`),
            restGet(srv, auth, '/api/v1/backupInfrastructure/repositories/states?limit=500'),
            restGet(srv, auth, `/api/v1/malwareDetection/events?limit=100&detectedAfterTimeUtcFilter=${encodeURIComponent(since)}`).catch(() => null),
            restGet(srv, auth, '/api/v1/license').catch(() => null),
        ]);

        // Job durumları
        const jobs = jobsRes.json?.data || [];
        snap.jobs = {
            total: jobs.length,
            disabled: jobs.filter((j) => /disabled/i.test(j.status || '')).length,
            running: jobs.filter((j) => /running|working/i.test(j.status || '')).length,
        };
        snap.jobList = jobs.map((j) => ({
            name: j.name,
            type: j.type,
            status: j.status,
            lastResult: j.lastResult,
            lastRun: j.lastRun || null,
            nextRun: j.nextRun || null,
        }));

        // Son 24 saatin session sonuçları (bitmiş olanlar)
        const sessions = (sessionsRes.json?.data || []).filter((s) => s.endTime || /stopped/i.test(s.state || ''));
        const byResult = { Success: 0, Warning: 0, Failed: 0, None: 0 };
        for (const s of sessions) {
            const r = s.result?.result || 'None';
            byResult[r] = (byResult[r] || 0) + 1;
        }
        snap.sessions = {
            windowHours: SESSION_WINDOW_H,
            total: sessions.length,
            success: byResult.Success,
            warning: byResult.Warning,
            failed: byResult.Failed,
        };
        // Aynı job'ın en güncel sonucu esas alınır (gece düşüp sabah düzelen job "başarısız" sayılmasın)
        const latestByName = new Map();
        for (const s of sessions) {
            const prev = latestByName.get(s.name);
            if (!prev || new Date(s.endTime || 0) > new Date(prev.endTime || 0)) latestByName.set(s.name, s);
        }
        snap.failedJobs = [...latestByName.values()]
            .filter((s) => s.result?.result === 'Failed')
            .map(pickSessionInfo);
        snap.warningJobs = [...latestByName.values()]
            .filter((s) => s.result?.result === 'Warning')
            .map(pickSessionInfo);

        // RPO: etkin ve zamanlanmış (nextRun'ı olan) ama RPO_HOURS'tır çalışmamış job'lar
        const cutoff = Date.now() - RPO_HOURS * 3600_000;
        snap.staleJobs = jobs
            .filter((j) => !/disabled/i.test(j.status || '') && j.nextRun)
            .filter((j) => j.lastRun && new Date(j.lastRun).getTime() < cutoff)
            .map((j) => ({ name: j.name, lastRun: j.lastRun }));

        // Depolar
        snap.repositories = (reposRes.json?.data || []).map((r) => {
            const cap = Number(r.capacityGB) || 0;
            const free = Number(r.freeGB) || 0;
            return {
                name: r.name,
                type: r.type,
                capacityGB: cap,
                freeGB: free,
                usedPct: cap > 0 ? Math.round(((cap - free) / cap) * 100) : null,
            };
        });

        // Malware tespitleri (12.1+; eski sürümde 404 → null)
        if (malwareRes?.status === 200 && Array.isArray(malwareRes.json?.data)) {
            snap.malware = {
                count: malwareRes.json.data.length,
                events: malwareRes.json.data.slice(0, 10).map((e) => ({
                    time: e.detectionTimeUtc || e.createdOn || null,
                    machine: e.machine?.displayName || e.machine?.name || null,
                    details: (e.details || '').slice(0, 200),
                })),
            };
        }

        // Lisans (Backup Viewer rolünde 403 döner → sessizce atlanır;
        // 13.x'te bitiş tarihi instanceLicenseSummary altına taşınmış olabilir)
        if (licenseRes?.status === 200 && licenseRes.json) {
            snap.license = {
                edition: licenseRes.json.edition || null,
                status: licenseRes.json.status || null,
                expirationDate: licenseRes.json.expirationDate
                    || licenseRes.json.instanceLicenseSummary?.expirationDate
                    || null,
            };
        }
    } catch (err) {
        snap.error = String(err?.message || err);
    }
    return snap;
}

// --- Durum makinesi ---
let latest = { fetchedAt: null, servers: [], alerts: [] };
let prevAlertKeys = new Map(); // key -> alert (önceki turdan)
let pollTimer = null;
let polling = null;
let listServers = () => [];

function overallLevel(alerts) {
    if (alerts.some((a) => a.level === 'critical')) return 'critical';
    if (alerts.some((a) => a.level === 'warning')) return 'warning';
    return 'ok';
}

async function pollOnce() {
    const servers = listServers().filter((s) => !s.disabled);
    const snaps = await Promise.all(servers.map(collectServer));
    const alerts = snaps.flatMap(evaluateRules);

    // raised/resolved olayları üret
    const nowKeys = new Map(alerts.map((a) => [a.key, a]));
    for (const [key, alert] of nowKeys) {
        if (!prevAlertKeys.has(key)) addEvent('raised', alert);
    }
    for (const [key, alert] of prevAlertKeys) {
        if (!nowKeys.has(key)) addEvent('resolved', alert);
    }
    prevAlertKeys = nowKeys;

    latest = {
        fetchedAt: new Date().toISOString(),
        overall: overallLevel(alerts),
        servers: snaps,
        alerts,
    };
    return latest;
}

export function startMonitor(getServers) {
    listServers = getServers;
    const run = () => {
        if (polling) return polling;
        polling = pollOnce()
            .catch((err) => console.error('monitor poll failed:', err?.message || err))
            .finally(() => { polling = null; });
        return polling;
    };
    run();
    pollTimer = setInterval(run, POLL_INTERVAL_MS);
    pollTimer.unref?.();
    console.log(`monitor: ${POLL_INTERVAL_MS / 1000}s aralıkla izleme başladı`);
}

export async function forcePoll() {
    if (polling) return polling.then(() => latest);
    await pollOnce();
    return latest;
}

export function getStatus() {
    return latest;
}

export function getEvents(limit = 50) {
    return events.slice(-limit).reverse();
}

// AI özeti için kompakt, insan-okur veri (Intelligence'a prompt içinde gönderilir)
export function summaryForDigest() {
    const lines = [];
    for (const s of latest.servers) {
        if (s.error) {
            lines.push(`${s.server}: ERİŞİLEMİYOR (${s.error})`);
            continue;
        }
        lines.push(`${s.server}: ${s.jobs.total} job (${s.jobs.disabled} devre dışı); `
            + `son ${s.sessions.windowHours}s: ${s.sessions.success} başarılı, ${s.sessions.warning} uyarı, ${s.sessions.failed} başarısız`);
        for (const f of s.failedJobs || []) lines.push(`  BAŞARISIZ: ${f.name} — ${f.message}`);
        for (const w of s.warningJobs || []) lines.push(`  UYARI: ${w.name} — ${w.message}`);
        for (const j of s.staleJobs || []) lines.push(`  ÇALIŞMAMIŞ: ${j.name} (son: ${j.lastRun})`);
        for (const r of s.repositories || []) {
            if (r.usedPct != null) lines.push(`  Depo ${r.name}: %${r.usedPct} dolu, ${r.freeGB} GB boş`);
        }
        if (s.malware?.count) lines.push(`  MALWARE TESPİTİ: ${s.malware.count} olay!`);
    }
    return lines.join('\n');
}
