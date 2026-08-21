// Sbee tray arayüzü — tüm ağ istekleri Rust'taki api_request komutu üzerinden gider.
const { invoke } = window.__TAURI__.core;

const DEFAULTS = { base: 'http://10.11.18.110:8080', interval: 60, notif: true, mascot: true };
let settings = loadSettings();
let pollTimer = null;
let lastEventTs = localStorage.getItem('sbee-last-event-ts') || '';

function loadSettings() {
    try {
        return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('sbee-settings') || '{}') };
    } catch {
        return { ...DEFAULTS };
    }
}

function saveSettings() {
    localStorage.setItem('sbee-settings', JSON.stringify(settings));
}

async function api(path, { method = 'GET', body = null, timeoutMs = 30000 } = {}) {
    const raw = await invoke('api_request', {
        base: settings.base, path, method,
        body: body ? JSON.stringify(body) : null,
        timeoutMs,
    });
    const wrapper = JSON.parse(raw);
    let data = null;
    try { data = JSON.parse(wrapper.body); } catch { data = { raw: wrapper.body }; }
    if (wrapper.status >= 400) {
        throw new Error(data?.error || `HTTP ${wrapper.status}`);
    }
    return data;
}

// --- Yardımcılar ---
const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}
function fmtTime(iso) {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
}
const LEVELS = { ok: 'Sağlıklı', warning: 'Uyarı', critical: 'Sorun var' };

// Seçilen duruma göre job listesi: session verisi (hata mesajlı) + job durumları birleşir
function jobItems(s, filter) {
    const list = s.jobList || [];
    const base = (n) => String(n).replace(/\s*\(.*\)$/, '');
    if (filter === 'all') return list;
    if (filter === 'success') return list.filter((j) => j.lastResult === 'Success');
    const sess = filter === 'failed' ? (s.failedJobs || []) : (s.warningJobs || []);
    const want = filter === 'failed' ? 'Failed' : 'Warning';
    const items = sess.map((f) => ({ name: f.name, lastResult: want, lastRun: f.endTime, message: f.message }));
    for (const j of list) {
        if (j.lastResult === want && !items.some((i) => base(i.name) === j.name)) items.push(j);
    }
    return items;
}

function renderJobDetail(root, s, filter) {
    root.replaceChildren();
    if (!filter) return;
    const items = jobItems(s, filter);
    if (!items.length) {
        root.append(el('div', 'muted center', 'Bu durumda job yok.'));
        return;
    }
    for (const j of items) {
        const it = el('div', 'job-item');
        const head = el('div', 'ji-head');
        const res = j.lastResult || '';
        head.append(el('span', 'dot ' + (res === 'Failed' ? 'critical' : res === 'Warning' ? 'warning' : res === 'Success' ? 'ok' : 'gray')));
        head.append(el('b', null, j.name));
        head.append(el('span', 'ji-time', fmtTime(j.lastRun)));
        it.append(head);
        const sub = [];
        if (j.type) sub.push(j.type);
        if (j.status) sub.push('Durum: ' + j.status);
        if (j.nextRun) sub.push('Sonraki: ' + fmtTime(j.nextRun));
        if (sub.length) it.append(el('div', 'ji-sub', sub.join(' · ')));
        if (j.message) it.append(el('div', 'ji-msg' + (res === 'Failed' ? ' err' : ''), j.message));
        root.append(it);
    }
}

// --- Durum sekmesi ---
function renderStatus(st) {
    const root = $('#status-content');
    root.replaceChildren();

    const overall = st.overall || 'gray';
    const pill = $('#overall-pill');
    pill.className = 'pill ' + overall;
    pill.textContent = LEVELS[overall] || '—';

    if (!st.servers?.length) {
        root.append(el('div', 'muted center', 'İzlenen sunucu yok. Sunucular sekmesinden ekleyin.'));
        return;
    }

    // Aktif uyarılar
    if (st.alerts?.length) {
        const card = el('div', 'card');
        card.append(el('h3', null, `Aktif sorunlar (${st.alerts.length})`));
        for (const a of st.alerts.slice(0, 15)) {
            card.append(el('div', 'alert-item ' + a.level, a.message));
        }
        root.append(card);
    }

    // Sunucu kartları
    for (const s of st.servers) {
        const card = el('div', 'card');
        const h = el('h3');
        const level = s.error ? 'critical'
            : (st.alerts || []).some((a) => a.serverId === s.serverId && a.level === 'critical') ? 'critical'
            : (st.alerts || []).some((a) => a.serverId === s.serverId && a.level === 'warning') ? 'warning' : 'ok';
        h.append(el('span', 'dot ' + level), document.createTextNode(' ' + s.server));
        card.append(h);

        if (s.error) {
            card.append(el('div', 'alert-item critical', s.error));
            root.append(card);
            continue;
        }

        // Durum kutuları tıklanabilir: ilgili job'ları hata mesajlarıyla listeler
        const row = el('div', 'stat-row');
        const detail = el('div', 'job-detail');
        let curFilter = null;
        const applyFilter = (f) => {
            curFilter = curFilter === f ? null : f;
            row.querySelectorAll('.stat').forEach((t) => t.classList.toggle('sel', t.dataset.f === curFilter));
            renderJobDetail(detail, s, curFilter);
        };
        const mk = (cls, num, lbl, filter) => {
            const d = el('div', 'stat ' + cls);
            d.dataset.f = filter;
            d.title = 'Tıkla: bu durumdaki job\'ları göster';
            d.append(el('b', null, String(num)), el('span', null, lbl));
            d.addEventListener('click', () => applyFilter(filter));
            return d;
        };
        row.append(
            mk('s-ok', s.sessions?.success ?? 0, 'Başarılı', 'success'),
            mk('s-warn', s.sessions?.warning ?? 0, 'Uyarı', 'warning'),
            mk('s-fail', s.sessions?.failed ?? 0, 'Başarısız', 'failed'),
            mk('', `${s.jobs?.total ?? 0}`, `Job (${s.jobs?.disabled ?? 0} kapalı)`, 'all'),
        );
        card.append(row, detail);

        for (const r of s.repositories || []) {
            if (r.usedPct == null) continue;
            const rb = el('div', 'repo-bar');
            const lbl = el('div', 'rb-label');
            lbl.append(el('span', null, r.name), el('span', null, `%${r.usedPct} · ${Math.round(r.freeGB)} GB boş`));
            const track = el('div', 'rb-track');
            const fill = el('div', 'rb-fill' + (r.usedPct >= 90 ? ' crit' : r.usedPct >= 80 ? ' warn' : ''));
            fill.style.width = Math.min(100, r.usedPct) + '%';
            track.append(fill);
            rb.append(lbl, track);
            card.append(rb);
        }
        root.append(card);
    }

    // AI günlük özeti
    if (st.digest?.text) {
        const card = el('div', 'card');
        const det = el('details');
        det.append(el('summary', null, '🤖 AI günlük değerlendirme (' + fmtTime(st.digest.generatedAt) + ')'));
        det.append(el('div', 'digest', st.digest.text));
        card.append(det);
        root.append(card);
    }

    // Son olaylar
    if (st.events?.length) {
        const card = el('div', 'card');
        const det = el('details');
        det.append(el('summary', null, `Son olaylar (${st.events.length})`));
        for (const ev of st.events.slice(0, 20)) {
            const item = el('div', 'event-item');
            const tag = el('span', ev.type === 'raised' ? 'ev-raised' : 'ev-resolved',
                ev.type === 'raised' ? '▲' : '▼');
            item.append(tag, document.createTextNode(` ${fmtTime(ev.ts)} — ${ev.message}`));
            det.append(item);
        }
        card.append(det);
        root.append(card);
    }
}

function notifyNewEvents(st) {
    if (!settings.notif || !st.events?.length) return;
    // events yeniden-eskiye sıralı gelir
    const fresh = st.events.filter((ev) => ev.type === 'raised' && ev.ts > lastEventTs);
    if (lastEventTs) {
        for (const ev of fresh.slice(0, 3)) {
            invoke('notify', {
                title: ev.level === 'critical' ? 'Sbee: Kritik sorun' : 'Sbee: Uyarı',
                body: ev.message.slice(0, 180),
            }).catch(() => {});
        }
        // Kritik sorunlarda karakter de haber versin
        const crit = fresh.find((ev) => ev.level === 'critical');
        if (crit && settings.mascot) {
            invoke('mascot_say', { text: crit.message.slice(0, 160), level: 'critical' }).catch(() => {});
        }
    }
    const newest = st.events[0]?.ts;
    if (newest && newest > lastEventTs) {
        lastEventTs = newest;
        localStorage.setItem('sbee-last-event-ts', lastEventTs);
    }
}

async function refresh(force = false) {
    try {
        if (force) await api('/api/monitor/poll', { method: 'POST', timeoutMs: 90000 });
        const st = await api('/api/status');
        renderStatus(st);
        notifyNewEvents(st);
        const overall = st.overall || 'gray';
        const parts = [];
        for (const s of st.servers || []) {
            if (s.error) parts.push(`${s.server}: erişilemiyor`);
            else parts.push(`${s.server}: ${s.sessions?.failed ?? 0} hata / ${s.sessions?.warning ?? 0} uyarı`);
        }
        invoke('set_status', {
            status: overall,
            tooltip: 'Sbee — ' + (LEVELS[overall] || '') + (parts.length ? '\n' + parts.join('\n') : ''),
        }).catch(() => {});
        $('#meta').textContent = 'Son güncelleme: ' + fmtTime(st.fetchedAt)
            + (st.quota ? ` · AI kotası ${st.quota.used}/${st.quota.limit}` : '');
        $('#subtitle').textContent = 'Veeam izleme';
    } catch (err) {
        $('#status-content').replaceChildren(
            el('div', 'error-box', 'Sbee sunucusuna ulaşılamadı: ' + (err.message || err)
                + ' — Ayarlar sekmesinden adresi kontrol edin.'));
        const pill = $('#overall-pill');
        pill.className = 'pill gray';
        pill.textContent = 'Çevrimdışı';
        invoke('set_status', { status: 'unknown', tooltip: 'Sbee — sunucuya ulaşılamıyor' }).catch(() => {});
    }
}

function schedulePolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refresh, Math.max(30, settings.interval) * 1000);
}

// --- Sunucular sekmesi ---
async function renderServers() {
    const root = $('#server-list');
    try {
        const servers = await api('/api/servers');
        root.replaceChildren();
        if (!servers.length) {
            root.append(el('div', 'muted center', 'Kayıtlı sunucu yok.'));
        }
        for (const s of servers) {
            const item = el('div', 'server-item');
            const name = el('div', 'sv-name');
            name.append(el('b', null, s.name), el('span', null, `${s.webUrl} · ${(s.product || 'vbr').toUpperCase()}`));
            item.append(name);
            if (s.active) {
                item.append(el('span', 'badge', 'AI aktif'));
            } else {
                const act = el('button', 'btn small', 'AI aktif et');
                act.title = 'Sohbet sorularının gideceği sunucu yapar (izleme için gerekmez)';
                act.onclick = async () => {
                    try { await api(`/api/servers/${s.id}/activate`, { method: 'POST' }); renderServers(); } catch (e) { alert(e.message); }
                };
                item.append(act);
            }
            const del = el('button', 'btn small danger', '✕');
            del.title = 'Sunucuyu kaldır';
            del.onclick = async () => {
                if (!confirm(`"${s.name}" kaldırılsın mı?`)) return;
                try { await api(`/api/servers/${s.id}`, { method: 'DELETE' }); renderServers(); refresh(); } catch (e) { alert(e.message); }
            };
            item.append(del);
            root.append(item);
        }
    } catch (err) {
        root.replaceChildren(el('div', 'error-box', 'Sunucu listesi alınamadı: ' + (err.message || err)));
    }
}

$('#server-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
        await api('/api/servers', {
            method: 'POST',
            body: {
                name: f.get('name'), address: f.get('address'), product: f.get('product'),
                username: f.get('username'), password: f.get('password'),
            },
        });
        e.target.reset();
        $('#add-server').open = false;
        renderServers();
        refresh(true); // yeni sunucu hemen izlemeye girsin
    } catch (err) {
        alert('Eklenemedi: ' + (err.message || err));
    }
});

// --- Ayarlar sekmesi ---
async function renderSettings() {
    const form = $('#settings-form');
    form.base.value = settings.base;
    form.interval.value = settings.interval;
    form.notif.checked = settings.notif;
    form.mascot.checked = settings.mascot !== false;
    try { form.autostart.checked = await invoke('autostart_enabled'); } catch { /* desteklenmiyor */ }
}

$('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    settings.base = form.base.value.trim().replace(/\/+$/, '');
    settings.interval = Number(form.interval.value) || 60;
    settings.notif = form.notif.checked;
    settings.mascot = form.mascot.checked;
    saveSettings();
    invoke(settings.mascot ? 'mascot_show' : 'mascot_hide').catch(() => {});
    try { await invoke('autostart_set', { enabled: form.autostart.checked }); } catch { /* desteklenmiyor */ }
    $('#settings-msg').textContent = 'Kaydedildi.';
    setTimeout(() => { $('#settings-msg').textContent = ''; }, 2000);
    schedulePolling();
    refresh();
});

// --- Sekmeler ve düğmeler ---
document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        $('#tab-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'servers') renderServers();
        if (btn.dataset.tab === 'settings') renderSettings();
    });
});

$('#btn-min').addEventListener('click', () => invoke('hide_window'));
$('#btn-close').addEventListener('click', () => invoke('quit_app'));

// Başlıktan taşıma: data-tauri-drag-region çalışmadığı ortamlar için Rust yedeği
const header = document.querySelector('header');
let hdrPress = null;
header.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('button')) hdrPress = { x: e.screenX, y: e.screenY };
});
window.addEventListener('mousemove', (e) => {
    if (hdrPress && (Math.abs(e.screenX - hdrPress.x) > 3 || Math.abs(e.screenY - hdrPress.y) > 3)) {
        hdrPress = null;
        invoke('start_drag', { label: 'main' }).catch(() => {});
    }
});
window.addEventListener('mouseup', () => { hdrPress = null; });
$('#btn-refresh').addEventListener('click', () => refresh(true));
$('#btn-web').addEventListener('click', () => invoke('open_url', { url: settings.base }));

// --- Başlangıç ---
renderSettings();
refresh();
schedulePolling();

// Karakter: açılışta göster (ayar kapalı değilse); tepsiden değişirse ayarı eşitle
if (settings.mascot !== false) invoke('mascot_show').catch(() => {});
window.__TAURI__.event.listen('mascot-visibility', (ev) => {
    settings.mascot = !!ev.payload;
    saveSettings();
    const form = $('#settings-form');
    if (form?.mascot) form.mascot.checked = settings.mascot;
}).catch(() => {});
