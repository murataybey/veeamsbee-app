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

// Kalıcı bağlantı havuzu: her sorgu için yeni TLS bağlantısı açmak yerine
// en fazla 8 bağlantıyı tekrar kullan — yoğun VBR'da bağlantı fırtınasını önler
const restAgent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 });

function restRequest(host, apiPath, { method = 'GET', headers = {}, body = null, timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: host,
            port: REST_PORT,
            path: apiPath,
            method,
            headers,
            rejectUnauthorized: false,
            timeout: timeoutMs,
            agent: restAgent,
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

async function restGet(srv, auth, apiPath, timeoutMs) {
    const host = new URL(srv.webUrl).hostname;
    const res = await restRequest(host, apiPath, {
        headers: {
            Authorization: 'Bearer ' + auth.token,
            'x-api-version': auth.apiVersion,
        },
        timeoutMs,
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

// --- Müşteri raporu: ada göre (job adı ya da resource pool/folder) eşleşen
// backup/replikasyon job'ları, yedekler, restore point'ler ve saklama politikası.
// Tamamı VBR REST'ten gelir; Intelligence kotası harcamaz.
function trLower(s) {
    return String(s || '').toLocaleLowerCase('tr');
}

// Sorguyu parçalara ayır: "FirmaPerakende" → firmaperakende, firma, perakende
// (snapshot volume adları çoğu zaman müşteri adının yalnızca bir parçasını taşır)
function matchTokens(q) {
    const base = trLower(q).trim();
    const camel = String(q).replace(/([a-zçğıöşü0-9])([A-ZÇĞİÖŞÜ])/g, '$1 $2');
    const parts = [...base.split(/[-_ .]+/), ...camel.split(/[\s\-_.]+/).map(trLower)];
    return [...new Set([base, ...parts])].filter((t) => t.length >= 4);
}

function retentionText(rp) {
    if (!rp?.type) return null;
    if (/day/i.test(rp.type)) return `${rp.quantity} gün saklanır`;
    return `son ${rp.quantity} restore point saklanır`;
}

// Job zamanlamasını insan diline çevir ("Günde 1, saat 18:00" gibi)
function scheduleText(sch) {
    if (!sch) return null;
    if (sch.runAutomatically === false) return 'Manuel çalıştırılır';
    if (sch.daily?.isEnabled) {
        const k = sch.daily.dailyKind;
        const base = k === 'Everyday' ? 'Günde 1'
            : k === 'WeekDays' ? 'Hafta içi günde 1'
            : `Haftada ${(sch.daily.days || []).length} gün`;
        return `${base}, saat ${sch.daily.localTime || '?'}`;
    }
    if (sch.monthly?.isEnabled) {
        const when = sch.monthly.isLastDayOfMonth
            ? 'ay sonu'
            : [sch.monthly.dayNumberInMonth, sch.monthly.dayOfWeek].filter(Boolean).join('. ');
        return `Ayda 1 (${when}, saat ${sch.monthly.localTime || '?'})`;
    }
    if (sch.periodically?.isEnabled) {
        const k = sch.periodically.periodicallyKind || '';
        const unit = /hour/i.test(k) ? 'saatte' : /min/i.test(k) ? 'dakikada' : k + '';
        return `Her ${sch.periodically.frequency} ${unit} bir`;
    }
    if (sch.afterThisJob?.isEnabled) return 'Zincirleme (önceki job bitince)';
    if (sch.continuously?.isEnabled) return 'Sürekli';
    return null;
}

// GFS (uzun dönem saklama): "ayda 1 → 12 ay" gibi
function gfsText(g) {
    if (!g?.isEnabled) return null;
    const p = [];
    if (g.weekly?.isEnabled) p.push(`haftada 1 → ${g.weekly.keepForNumberOfWeeks} hafta`);
    if (g.monthly?.isEnabled) p.push(`ayda 1 → ${g.monthly.keepForNumberOfMonths} ay`);
    if (g.yearly?.isEnabled) p.push(`yılda 1 → ${g.yearly.keepForNumberOfYears} yıl`);
    return p.length ? p.join(' · ') : null;
}

async function customerReportForServer(srv, q) {
    const out = { server: srv.name, jobs: [], totals: { jobs: 0, healthy: 0, warning: 0, failed: 0, other: 0, vms: 0, vmsActive: 0, vmsStale: 0, restorePoints: 0, rpBackup: 0, rpSnapshot: 0, rpReplica: 0 } };
    if (srv.product !== 'vbr') {
        out.error = 'Rapor şimdilik yalnızca VBR sunucularını destekliyor';
        return out;
    }
    try {
        const auth = await getToken(srv);
        const [statesRes, configsRes, backupsRes, replicasRes] = await Promise.all([
            restGet(srv, auth, '/api/v1/jobs/states?limit=500'),
            restGet(srv, auth, '/api/v1/jobs?limit=500').catch(() => null),
            restGet(srv, auth, '/api/v1/backups?limit=500').catch(() => null),
            restGet(srv, auth, '/api/v1/replicas?limit=500').catch(() => null),
        ]);
        const states = statesRes.json?.data || [];
        const configs = new Map((configsRes?.json?.data || []).map((c) => [c.id, c]));
        const backups = backupsRes?.json?.data || [];
        const replicas = replicasRes?.json?.data || [];

        // Yedeğin makineleri /api/v1/backups/{id}/objects'ten; nokta sayısı ve
        // tarihler MAKİNE BAŞINA /api/v1/backupObjects/{id}/restorePoints'ten gelir.
        // DİKKAT: restorePoints?backupIdFilter VBR 13.0.1'de yok sayılıyor (tüm
        // ortamın 56 bin noktasını döndürüyor) — asla ona güvenme.
        // Makinenin nokta listesi tek çağrıda çekilir ve İLGİLİ ZİNCİRE (backupId)
        // göre süzülür — böylece snapshot bölümü snapshot sayısını, backup bölümü
        // backup sayısını gösterir; kırılım toplamları da bundan çıkar
        const backupVm = async (o, backupId, activeDays = 7) => {
            const res = await restGet(srv, auth,
                `/api/v1/backupObjects/${encodeURIComponent(o.id)}/restorePoints?limit=500&orderColumn=CreationTime&orderAsc=false`, 90000)
                .catch(() => null);
            const all = res?.json?.data || [];
            const chain = all.filter((p) => p.backupId === backupId);
            const newestTs = chain[0]?.creationTime ? new Date(chain[0].creationTime).getTime() : 0;
            return {
                objId: o.id,
                name: o.name,
                active: newestTs > 0 && (Date.now() - newestTs) < activeDays * 86400000,
                restorePoints: all.length ? chain.length : (res?.json?.pagination?.total ?? o.restorePointsCount ?? null),
                newest: chain[0]?.creationTime || null,
                oldest: chain.length ? chain[chain.length - 1].creationTime : null,
            };
        };

        const OBJ_CAP = 150;
        const backupBlock = async (b, activeDays = 7) => {
            let objErr = null;
            // Yüklü sunucuda büyük listelemeler 20 sn'yi aşabiliyor: 90 sn + 1 tekrar
            const objUrl = `/api/v1/backups/${encodeURIComponent(b.id)}/objects?limit=500`;
            let objsRes = await restGet(srv, auth, objUrl, 90000).catch(() => null);
            if (!objsRes) {
                objsRes = await restGet(srv, auth, objUrl, 90000)
                    .catch((e) => { objErr = String(e?.message || e); return null; });
            }
            if (!objErr && objsRes && objsRes.status !== 200) {
                objErr = `HTTP ${objsRes.status}${objsRes.json?.message ? ': ' + objsRes.json.message : ''}`;
            }
            const all = objsRes?.json?.data || [];
            const objs = all.slice(0, OBJ_CAP);
            const vms = [];
            for (let i = 0; i < objs.length; i += 8) {
                vms.push(...await Promise.all(objs.slice(i, i + 8).map((o) => backupVm(o, b.id, activeDays))));
            }
            return {
                name: b.name + (all.length > OBJ_CAP ? ` (ilk ${OBJ_CAP}/${all.length} makine)` : ''),
                activeCount: vms.filter((v) => v.active).length,
                staleCount: vms.filter((v) => !v.active).length,
                repository: b.repositoryName || null,
                error: objErr ? `Makine listesi alınamadı: ${objErr}` : undefined,
                vms,
                totalRestorePoints: vms.reduce((a, v) => a + (v.restorePoints || 0), 0),
                newestPoint: vms.map((v) => v.newest).filter(Boolean).sort().at(-1) || null,
                oldestPoint: vms.map((v) => v.oldest).filter(Boolean).sort()[0] || null,
            };
        };

        // Depo bilgisi + silinemezlik (immutability): normal ve SOBR uçlarını dene,
        // cevaptaki "immutab*" alanlarını tara (şema depo türüne göre değişiyor)
        const repoCache = new Map();
        const repoInfo = async (id) => {
            if (!id) return null;
            if (repoCache.has(id)) return repoCache.get(id);
            let res = await restGet(srv, auth, `/api/v1/backupInfrastructure/repositories/${encodeURIComponent(id)}`, 30000).catch(() => null);
            if (!res || res.status !== 200) {
                res = await restGet(srv, auth, `/api/v1/backupInfrastructure/scaleOutRepositories/${encodeURIComponent(id)}`, 30000).catch(() => null);
            }
            const j = res?.status === 200 ? res.json : null;
            const scanImmutab = (obj) => {
                const found = [];
                const walk = (o) => {
                    if (!o || typeof o !== 'object') return;
                    for (const [k, v] of Object.entries(o)) {
                        if (/immutab/i.test(k) && (v === null || typeof v !== 'object')) found.push([k, v]);
                        if (v && typeof v === 'object') walk(v);
                    }
                };
                walk(obj);
                return found;
            };
            const immutabText = (found) => {
                const bools = found.filter(([, v]) => typeof v === 'boolean');
                const nums = found.filter(([, v]) => typeof v === 'number' && v > 0);
                const enabled = bools.some(([, v]) => v) || (bools.length === 0 && nums.length > 0);
                if (enabled) return 'Silinemez damgalı' + (nums.length ? ` (${nums[0][1]} gün)` : '');
                return found.length ? 'Silinemezlik kapalı' : null;
            };
            let info = null;
            if (j) {
                let found = scanImmutab(j);
                // SOBR'da silinemezlik üyelerde (extent) tanımlıdır — orada yoksa üyelere in
                if (!found.some(([, v]) => v === true || (typeof v === 'number' && v > 0))) {
                    const extentIds = [];
                    const collect = (o) => {
                        if (!o || typeof o !== 'object') return;
                        for (const [k, v] of Object.entries(o)) {
                            if (/extent/i.test(k) && Array.isArray(v)) {
                                for (const e of v) {
                                    if (typeof e === 'string') extentIds.push(e);
                                    else if (e?.id) extentIds.push(e.id);
                                }
                            } else if (v && typeof v === 'object') collect(v);
                        }
                    };
                    collect(j);
                    for (const eid of extentIds.slice(0, 4)) {
                        const er = await restGet(srv, auth, `/api/v1/backupInfrastructure/repositories/${encodeURIComponent(eid)}`, 30000).catch(() => null);
                        if (er?.status === 200) {
                            const ef = scanImmutab(er.json);
                            if (ef.some(([, v]) => v === true || (typeof v === 'number' && v > 0))) {
                                found = ef;
                                break;
                            }
                            if (ef.length && !found.length) found = ef;
                        }
                    }
                }
                info = { name: j.name || null, immutability: immutabText(found) };
            }
            repoCache.set(id, info);
            return info;
        };

        // Aynı makine birden fazla yedekte görünebilir (storage snapshot + normal
        // backup) — genel toplamlarda her makineyi bir kez say
        // Makineler tekil sayılır; restore point'ler zincir bazında toplanır
        // (her nokta tek bir zincire ait olduğundan çift sayım olmaz)
        const seenObj = new Set();
        const addTotals = (blk, rpKind) => {
            for (const v of blk.vms) {
                const key = v.objId || v.name;
                if (!seenObj.has(key)) {
                    seenObj.add(key);
                    out.totals.vms += 1;
                    if (v.active) out.totals.vmsActive += 1;
                    else out.totals.vmsStale += 1;
                }
            }
            out.totals.restorePoints += blk.totalRestorePoints || 0;
            out.totals[rpKind] += blk.totalRestorePoints || 0;
        };

        // Replika noktaları /api/v1/replicaPoints'ten gelir (replicaIdFilter ÇALIŞIYOR;
        // restorePoints?backupIdFilter replika id'sini yok sayıp TÜM ortamı döndürüyor — kullanma).
        // Nokta kaydının adı kaynak VM adıdır; replika kaydının adı değil.
        const replicaVm = async (r, activeDays = 7) => {
            const [newestRes, oldestRes] = await Promise.all([
                restGet(srv, auth, `/api/v1/replicaPoints?limit=1&replicaIdFilter=${encodeURIComponent(r.id)}&orderColumn=CreationTime&orderAsc=false`, 45000).catch(() => null),
                restGet(srv, auth, `/api/v1/replicaPoints?limit=1&replicaIdFilter=${encodeURIComponent(r.id)}&orderColumn=CreationTime&orderAsc=true`, 45000).catch(() => null),
            ]);
            const np = newestRes?.json?.data?.[0];
            const newestTs = np?.creationTime ? new Date(np.creationTime).getTime() : 0;
            return {
                name: (np?.name || r.name || '?') + (r.state && r.state !== 'Ready' ? ` (${r.state})` : ''),
                active: newestTs > 0 && (Date.now() - newestTs) < activeDays * 86400000,
                restorePoints: newestRes?.json?.pagination?.total ?? null,
                newest: np?.creationTime || null,
                oldest: oldestRes?.json?.data?.[0]?.creationTime || null,
            };
        };

        const REPLICA_CAP = 150;
        const replicaBlock = async (list, activeDays = 7) => {
            const capped = list.slice(0, REPLICA_CAP);
            const vms = [];
            // Sunucuyu boğmamak için 8'erli gruplar halinde sorgula
            for (let i = 0; i < capped.length; i += 8) {
                vms.push(...await Promise.all(capped.slice(i, i + 8).map((r) => replicaVm(r, activeDays))));
            }
            const times = vms.filter((v) => v.newest);
            return {
                name: 'Replikalar' + (list.length > REPLICA_CAP ? ` (ilk ${REPLICA_CAP}/${list.length})` : ''),
                activeCount: vms.filter((v) => v.active).length,
                staleCount: vms.filter((v) => !v.active).length,
                repository: null,
                vms,
                totalRestorePoints: vms.reduce((a, v) => a + (v.restorePoints || 0), 0),
                newestPoint: times.length ? times.map((v) => v.newest).sort().at(-1) : null,
                oldestPoint: vms.filter((v) => v.oldest).map((v) => v.oldest).sort()[0] || null,
            };
        };

        // Eşleşme: job adı q içerir YA DA job'ın kapsamındaki resource pool/folder/VM adı q içerir
        const matched = states.filter((s) => {
            if (trLower(s.name).includes(q)) return true;
            const inc = configs.get(s.id)?.virtualMachines?.includes || [];
            return inc.some((o) => trLower(o.name).includes(q));
        });

        for (const s of matched) {
            const cfg = configs.get(s.id);
            const inc = cfg?.virtualMachines?.includes || [];
            const matchedScope = inc.filter((o) => trLower(o.name).includes(q)).map((o) => `${o.type}: ${o.name}`);
            const job = {
                name: s.name,
                kind: /replica/i.test(s.type || '') ? 'Replikasyon' : 'Backup',
                type: s.type,
                status: s.status,
                lastResult: s.lastResult,
                lastRun: s.lastRun || null,
                nextRun: s.nextRun || null,
                retention: retentionText(cfg?.storage?.retentionPolicy)
                    // Replikasyon job'larında saklama jobSettings.restorePointsToKeep'tedir
                    || (cfg?.jobSettings?.restorePointsToKeep
                        ? `son ${cfg.jobSettings.restorePointsToKeep} restore point saklanır` : null)
                    || (cfg?.storage?.retentionPolicy ? JSON.stringify(cfg.storage.retentionPolicy) : null),
                matchedVia: trLower(s.name).includes(q) ? 'job adı' : (matchedScope[0] || 'kapsam'),
                policy: {
                    schedule: scheduleText(cfg?.schedule),
                    gfs: gfsText(cfg?.storage?.gfsPolicy),
                },
                _repoId: cfg?.storage?.backupRepositoryId || null,
                backups: [],
            };

            // Aktiflik penceresi: job periyodunun 3 katı (gunluk→3 gun, aylik→93 gun)
            const sch2 = cfg?.schedule;
            let periodDays = 1;
            if (sch2?.monthly?.isEnabled) periodDays = 31;
            else if (sch2?.periodically?.isEnabled) periodDays = Math.max(1, (sch2.periodically.frequency || 1) / 24);
            const activeDays = Math.max(3, Math.ceil(periodDays * 3));

            // Bu job'a bağlı yedekler → VM'ler, restore point sayıları, en yeni/en eski nokta
            for (const b of backups.filter((x) => x.jobId === s.id)) {
                const blk = await backupBlock(b, activeDays);
                job.backups.push(blk);
                addTotals(blk, 'rpBackup');
            }

            // Replikasyon job'ı ise replika envanterini ekle
            const jobReplicas = replicas.filter((r) => r.jobId === s.id);
            if (jobReplicas.length) {
                const blk = await replicaBlock(jobReplicas, activeDays);
                job.backups.push(blk);
                addTotals(blk, 'rpReplica');
            }

            // Son çalışmanın makine bazında sonucu: "96 makineden 95 başarılı, 1 başarısız"
            try {
                // Yüklü sunucuda ilk deneme düşebilir — her iki sorguya da 1 tekrar hakkı
                const tryTwice = async (fn) => { try { return await fn(); } catch { return await fn(); } };
                const sesRes = await tryTwice(() => restGet(srv, auth,
                    `/api/v1/sessions?limit=3&jobIdFilter=${encodeURIComponent(s.id)}&orderColumn=CreationTime&orderAsc=false`, 45000));
                const lastDone = (sesRes.json?.data || []).find((x) => x.endTime || /stopped/i.test(x.state || ''));
                if (lastDone) {
                    const tRes = await tryTwice(() => restGet(srv, auth,
                        `/api/v1/sessions/${encodeURIComponent(lastDone.id)}/taskSessions?limit=500`, 90000));
                    const tasks = tRes.json?.data || [];
                    if (tasks.length) {
                        const pick = (want) => tasks
                            .filter((t) => t.result?.result === want)
                            .map((t) => ({ name: t.name, message: (t.result?.message || '').slice(0, 250) }));
                        const failedVms = pick('Failed');
                        const warningVms = pick('Warning');
                        job.lastRunTasks = {
                            sessionName: lastDone.name,
                            endTime: lastDone.endTime || null,
                            total: tasks.length,
                            success: tasks.filter((t) => t.result?.result === 'Success').length,
                            warning: warningVms.length,
                            failed: failedVms.length,
                            failedVms,
                            warningVms,
                        };
                    }
                }
            } catch { /* görev detayı alınamazsa rapor onsuz devam eder */ }

            // Çıktısı olmayan job'ları açıklamasız bırakma
            if (!job.backups.length) {
                job.note = /snap/i.test(s.name)
                    ? 'Storage snapshot çıktıları VBR envanterinde job\'a bağlanmaz — bu müşterinin snapshot verileri raporun "Storage Snapshot" bölümünde listelenir.'
                    : 'Bu job\'a bağlı yedek kaydı VBR envanterinde bulunamadı.';
            }

            out.totals.jobs += 1;
            if (s.lastResult === 'Success') out.totals.healthy += 1;
            else if (s.lastResult === 'Warning') out.totals.warning += 1;
            else if (s.lastResult === 'Failed') out.totals.failed += 1;
            else out.totals.other += 1; // calisiyor ya da henuz sonuc yok
            out.jobs.push(job);
        }

        // Job'ı silinmiş / farklı adlandırılmış ama adı eşleşen yedekler de kapsansın.
        // jobId'si boş GUID / türü Unknown olanlar storage snapshot ya da içe aktarılmış
        // yedeklerdir — VBR bunları job'a hiç bağlamaz.
        const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
        const isDetached = (b) => !b.jobId || b.jobId === ZERO_GUID || b.jobType === 'Unknown';
        const matchedIds = new Set(matched.map((s) => s.id));
        const pushOrphan = (b, blk, via) => {
            out.jobs.push({
                name: b.name,
                kind: isDetached(b) ? 'Storage Snapshot' : 'Backup',
                type: b.jobType || null,
                status: null,
                lastResult: null,
                lastRun: null,
                nextRun: null,
                retention: null,
                matchedVia: via,
                _repoId: b.repositoryId || null,
                backups: [blk],
            });
            out.totals.jobs += 1;
            out.totals.other += 1; // bagimsiz bolumlerin job durumu yoktur
            addTotals(blk, isDetached(b) ? 'rpSnapshot' : 'rpBackup');
        };
        const included = new Set();
        for (const b of backups.filter((x) => !matchedIds.has(x.jobId) && trLower(x.name).includes(q))) {
            included.add(b.id);
            pushOrphan(b, await backupBlock(b), isDetached(b) ? 'snapshot/yedek adı' : 'yedek adı (job\'ı aktif listede yok)');
        }

        // Adı eşleşmeyen snapshot/bağımsız yedekler: içerik yoklaması — makinelerinin
        // çoğunluğu müşteri adını taşıyorsa raporun parçasıdır (volume adı farklı olabilir)
        const probeCandidates = backups
            .filter((b) => isDetached(b) && !included.has(b.id) && !trLower(b.name).includes(q))
            .slice(0, 15);
        const tokens = matchTokens(q);
        for (const b of probeCandidates) {
            const probe = await restGet(srv, auth, `/api/v1/backups/${encodeURIComponent(b.id)}/objects?limit=200`, 60000).catch(() => null);
            const objs = probe?.json?.data || [];
            if (!objs.length) continue;
            // 1) En güçlü sinyal: makineleri raporun eşleşen job'larındaki makinelerle
            //    aynı mı? (isim kalıbından bağımsız, kimlik bazlı — yanlış müşteri imkânsız)
            const overlap = objs.filter((o) => seenObj.has(o.id)).length;
            // 2) İkincil: makine adları sorgu parçalarından birini taşıyor mu?
            const nameHits = objs.filter((o) => tokens.some((t) => trLower(o.name).includes(t))).length;
            if (overlap / objs.length >= 0.3) {
                pushOrphan(b, await backupBlock(b), `makine eşleşmesi (${overlap}/${objs.length} raporla ortak)`);
            } else if (nameHits / objs.length >= 0.3) {
                pushOrphan(b, await backupBlock(b), `içerik eşleşmesi (${nameHits}/${objs.length} makine adı)`);
            }
        }

        // Depo adı ve silinemezlik bilgisini job'lara işle
        for (const job of out.jobs) {
            if (job._repoId) {
                const info = await repoInfo(job._repoId);
                if (info) {
                    job.policy = job.policy || {};
                    if (info.name) job.policy.repository = info.name;
                    if (info.immutability) job.policy.immutability = info.immutability;
                } else if (job.retention) {
                    // Depo REST'te yok = storage array snapshot pseudo-deposu.
                    // Snapshot silinemezliği job ayarında var ama VBR 13.0.1 REST API
                    // bu alanı dışarı vermiyor — dürüstçe belirt.
                    job.policy = job.policy || {};
                    job.policy.immutability = 'Konsolda tanımlı olabilir (VBR API bu ayarı raporlamıyor)';
                }
            }
            delete job._repoId;
        }

        // Adı eşleşen ama eşleşen job'lara bağlı olmayan replikalar
        const orphanReplicas = replicas.filter((r) => !matchedIds.has(r.jobId) && trLower(r.name || '').includes(q));
        if (orphanReplicas.length) {
            const blk = await replicaBlock(orphanReplicas);
            out.jobs.push({
                name: 'Replikalar (ad eşleşmesi)',
                kind: 'Replikasyon',
                type: null,
                status: null,
                lastResult: null,
                lastRun: null,
                nextRun: null,
                retention: null,
                matchedVia: 'replika adı',
                backups: [blk],
            });
            out.totals.jobs += 1;
            addTotals(blk, 'rpReplica');
        }
    } catch (err) {
        out.error = String(err?.message || err);
    }
    return out;
}

// Rapor önbelleği: aynı müşteri için 10 dk içinde gelen istekler (ekran + Word + PDF)
// veriyi bir kez toplar — VBR'a üç kez yüklenmeyiz, dışa aktarma anında iner
const REPORT_CACHE_MS = 10 * 60 * 1000;
const reportCache = new Map(); // q -> { ts, promise }

export function customerReport(name) {
    const q = trLower(name).trim();
    const hit = reportCache.get(q);
    if (hit && Date.now() - hit.ts < REPORT_CACHE_MS) return hit.promise;

    const promise = (async () => {
        const servers = listServers();
        const sections = await Promise.all(servers.map((srv) => customerReportForServer(srv, q)));
        return {
            query: name,
            generatedAt: new Date().toISOString(),
            servers: sections,
        };
    })();
    reportCache.set(q, { ts: Date.now(), promise });
    // Hatalı/kısmi sonuç önbellekte kalmasın — VBR kendine gelince tekrar deneme taze veri getirsin
    promise.then((rep) => {
        if (rep.servers.some((s) => s.error)) reportCache.delete(q);
    }).catch(() => reportCache.delete(q));
    return promise;
}

// Rapor araması için ad önerileri: job adları + müşteri öneki (ilk ayraçtan öncesi)
export function suggestNames(q) {
    const ql = trLower(q);
    const set = new Set();
    for (const s of latest.servers || []) {
        for (const j of s.jobList || []) {
            if (!j.name) continue;
            set.add(j.name);
            const prefix = j.name.split(/[-_ ]/)[0];
            if (prefix && prefix.length >= 3) set.add(prefix);
        }
    }
    return [...set]
        .filter((n) => trLower(n).includes(ql))
        .sort((a, b) => a.localeCompare(b, 'tr'))
        .slice(0, 12);
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
