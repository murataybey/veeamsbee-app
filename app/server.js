import express from 'express';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.WEB_PORT || 8080);
// MCP server child process: MCP_COMMAND overrides everything ("python /app/server.py"),
// otherwise node runs MCP_ENTRY. The tool is auto-discovered unless MCP_TOOL_NAME is set.
const MCP_COMMAND = process.env.MCP_COMMAND || '';
const MCP_ENTRY = process.env.MCP_ENTRY || '/app/build/index.js';
const MCP_TOOL_NAME = process.env.MCP_TOOL_NAME || '';
const MCP_QUESTION_ARG = process.env.MCP_QUESTION_ARG || '';
// Veeam Intelligence can take well over a minute on complex analysis questions
const ASK_TIMEOUT_MS = Number(process.env.ASK_TIMEOUT_MS || 240_000);
const MAX_QUESTION_LEN = 4000;

// UI configuration served to the frontend — override per deployment via env
const UI_TITLE = process.env.UI_TITLE || 'Siaflex Sbee Intelligence';
const UI_WELCOME = process.env.UI_WELCOME
    || 'Merhaba, ben Sbee! Veeam ortamınızla ilgili sorularınızı yanıtlamaya hazırım. '
    + 'Aşağıdaki örneklerden birine tıklayabilir ya da kendi sorunuzu yazabilirsiniz. '
    + 'Kapsamlı analizler 1–2 dakika sürebilir.';
let UI_SUGGESTIONS = [
    'Which jobs failed recently and why? Explain root causes from session logs',
    'List all backup jobs with their latest session result',
    'Show repository capacity and free space',
    'Are there any active alerts or warnings I should know about?',
];
if (process.env.UI_SUGGESTIONS) {
    try {
        const parsed = JSON.parse(process.env.UI_SUGGESTIONS);
        if (Array.isArray(parsed)) UI_SUGGESTIONS = parsed.map(String);
    } catch {
        console.error('UI_SUGGESTIONS is not valid JSON, using defaults');
    }
}

// Env vars that belong to the web app itself; everything else is forwarded to the MCP child
const WEB_OWN_ENV = new Set([
    'WEB_PORT', 'ASK_TIMEOUT_MS', 'QUOTA_LIMIT', 'QUOTA_FILE',
    'MCP_COMMAND', 'MCP_ENTRY', 'MCP_TOOL_NAME', 'MCP_QUESTION_ARG',
    'UI_TITLE', 'UI_WELCOME', 'UI_SUGGESTIONS', 'NODE_ENV',
    'SERVERS_FILE', 'SERVER_NAME',
]);

// Resolved after the first connection (auto-discovery)
let resolvedTool = MCP_TOOL_NAME;
let resolvedArg = MCP_QUESTION_ARG;

// --- Sunucu kayıt defteri: birden fazla Veeam sunucusu, biri aktif ---
const SERVERS_FILE = process.env.SERVERS_FILE || '/web/data/servers.json';
const PRODUCT_PORTS = { vone: ':1239', vspc: ':1280', vbr: '' };
let registry = { servers: [], activeId: null };

function saveRegistry() {
    fs.mkdirSync(path.dirname(SERVERS_FILE), { recursive: true });
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(registry, null, 2), { mode: 0o600 });
}

function loadRegistry() {
    try {
        const parsed = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8'));
        if (parsed && Array.isArray(parsed.servers)) {
            registry = parsed;
            return;
        }
    } catch {
        // ilk çalıştırma: env'deki sunucuyla tohumla
    }
    if (process.env.WEB_URL) {
        const seed = {
            id: 'srv-' + Date.now().toString(36),
            name: process.env.SERVER_NAME || 'Demo VBR',
            webUrl: process.env.WEB_URL,
            product: process.env.PRODUCT_NAME || 'vbr',
            username: process.env.ADMIN_USERNAME || '',
            password: process.env.ADMIN_PASSWORD || '',
            acceptSelfSigned: (process.env.ACCEPT_SELF_SIGNED_CERT || 'true') === 'true',
            addedAt: new Date().toISOString(),
        };
        registry = { servers: [seed], activeId: seed.id };
        saveRegistry();
    }
}
loadRegistry();

function activeServer() {
    return registry.servers.find((s) => s.id === registry.activeId) || null;
}

function publicServer(s) {
    return {
        id: s.id,
        name: s.name,
        webUrl: s.webUrl,
        product: s.product,
        username: s.username,
        active: s.id === registry.activeId,
        addedAt: s.addedAt,
    };
}

function buildWebUrl(address, product) {
    const a = address.trim();
    if (/^https?:\/\//i.test(a)) return a.endsWith('/') ? a : a + '/';
    return 'https://' + a + (PRODUCT_PORTS[product] || '') + '/';
}

// Hızlı erişilebilirlik testi: private API endpoint'i HTTP cevabı veriyor mu?
function testServerReachability(srv) {
    return new Promise((resolve) => {
        let url;
        try {
            url = new URL('private-api/oauth2/token', srv.webUrl);
        } catch {
            return resolve({ ok: false, detail: 'Geçersiz adres' });
        }
        const req = https.request({
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname,
            method: 'POST',
            rejectUnauthorized: false,
            timeout: 8000,
        }, (res) => {
            res.resume();
            if (res.statusCode === 404) {
                resolve({ ok: false, detail: 'Sunucuya erişildi ama Veeam private API bulunamadı (ürün/port yanlış olabilir)' });
            } else {
                resolve({ ok: true, detail: 'Erişilebilir (HTTP ' + res.statusCode + ')' });
            }
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', (e) => resolve({ ok: false, detail: 'Ulaşılamıyor: ' + (e.code || e.message) }));
        req.end();
    });
}

// Veeam Intelligence allows 200 questions per license per 24h. No Veeam API
// exposes the counter, so we track questions asked through this app locally.
const QUOTA_LIMIT = Number(process.env.QUOTA_LIMIT || 200);
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
const QUOTA_FILE = process.env.QUOTA_FILE || '/web/data/quota.json';

let askLog = [];
try {
    const saved = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
    if (Array.isArray(saved)) askLog = saved.filter((t) => typeof t === 'number');
} catch {
    // no history yet
}

function pruneAskLog() {
    const cutoff = Date.now() - QUOTA_WINDOW_MS;
    askLog = askLog.filter((t) => t > cutoff);
}

function recordAsk() {
    pruneAskLog();
    askLog.push(Date.now());
    try {
        fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
        fs.writeFileSync(QUOTA_FILE, JSON.stringify(askLog));
    } catch (err) {
        console.error('quota persist failed:', err?.message || err);
    }
}

function quotaState() {
    pruneAskLog();
    return {
        limit: QUOTA_LIMIT,
        used: askLog.length,
        remaining: Math.max(0, QUOTA_LIMIT - askLog.length),
    };
}

let client = null;
let connecting = null;

async function connectClient() {
    const childEnv = { ...getDefaultEnvironment() };
    for (const [k, v] of Object.entries(process.env)) {
        if (!WEB_OWN_ENV.has(k) && v !== undefined) childEnv[k] = v;
    }
    // Aktif sunucunun bağlantı bilgileri env'i ezer
    const srv = activeServer();
    if (srv) {
        childEnv.PRODUCT_NAME = srv.product;
        childEnv.WEB_URL = srv.webUrl;
        childEnv.ADMIN_USERNAME = srv.username;
        childEnv.ADMIN_PASSWORD = srv.password;
        childEnv.ACCEPT_SELF_SIGNED_CERT = String(srv.acceptSelfSigned);
    }
    let command = process.execPath;
    let args = [MCP_ENTRY];
    if (MCP_COMMAND) {
        const parts = MCP_COMMAND.split(/\s+/).filter(Boolean);
        command = parts[0];
        args = parts.slice(1);
    }
    const transport = new StdioClientTransport({
        command,
        args,
        env: childEnv,
        stderr: 'inherit',
    });
    const c = new Client({ name: 'sbee-web', version: '1.0.0' });
    c.onclose = () => {
        if (client === c) client = null;
    };
    await c.connect(transport);

    // Tool auto-discovery: take the configured tool, or the server's first tool
    if (!resolvedTool || !resolvedArg) {
        const { tools } = await c.listTools();
        if (!tools?.length) throw new Error('MCP server hiç tool sunmuyor.');
        const tool = (resolvedTool && tools.find((t) => t.name === resolvedTool)) || tools[0];
        resolvedTool = tool.name;
        if (!resolvedArg) {
            const props = tool.inputSchema?.properties || {};
            const required = tool.inputSchema?.required || [];
            // Tek zorunlu string parametre varsa onu, yoksa 'question'/'query' benzerini seç
            const stringProps = Object.keys(props).filter((p) => props[p]?.type === 'string');
            resolvedArg = (required.length === 1 && stringProps.includes(required[0]) && required[0])
                || stringProps.find((p) => /question|query|prompt|input|message/i.test(p))
                || stringProps[0]
                || 'question';
        }
        console.log(`MCP tool: ${resolvedTool} (parametre: ${resolvedArg})`);
    }
    return c;
}

async function getClient() {
    if (client) return client;
    if (!connecting) {
        connecting = connectClient()
            .then((c) => {
                client = c;
                return c;
            })
            .finally(() => {
                connecting = null;
            });
    }
    return connecting;
}

async function dropClient(c) {
    if (!c) return;
    if (client === c) client = null;
    try {
        await c.close();
    } catch {
        // already dead
    }
}

// Veeam Intelligence handles one conversation at a time; serialize questions
const MAX_QUEUE_DEPTH = 3;
let queueDepth = 0;
let queue = Promise.resolve();
function enqueue(fn) {
    queueDepth++;
    const wrapped = () => Promise.resolve().then(fn).finally(() => { queueDepth--; });
    const run = queue.then(wrapped, wrapped);
    queue = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

function extractPayload(result) {
    if (result.structuredContent && typeof result.structuredContent === 'object') {
        return result.structuredContent;
    }
    const text = result.content?.find((c) => c.type === 'text')?.text;
    if (typeof text === 'string') {
        try {
            return JSON.parse(text);
        } catch {
            return { message: text, artifacts: [] };
        }
    }
    return { message: 'Boş yanıt alındı.', artifacts: [] };
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/vendor/marked.js', (_req, res) =>
    res.sendFile(path.join(__dirname, 'node_modules/marked/marked.min.js')));
app.get('/vendor/purify.js', (_req, res) =>
    res.sendFile(path.join(__dirname, 'node_modules/dompurify/dist/purify.min.js')));

app.get('/api/config', (_req, res) => {
    res.json({
        title: UI_TITLE,
        welcome: UI_WELCOME,
        suggestions: UI_SUGGESTIONS,
        quotaEnabled: QUOTA_LIMIT > 0,
        tool: resolvedTool || null,
        activeServer: activeServer()?.name || null,
    });
});

// --- Sunucu yönetimi ---
app.get('/api/servers', (_req, res) => {
    res.json(registry.servers.map(publicServer));
});

app.post('/api/servers', (req, res) => {
    const { name, address, product, username, password, acceptSelfSigned } = req.body || {};
    if (!name?.trim() || !address?.trim()) {
        return res.status(400).json({ error: 'İsim ve IP/adres zorunludur.' });
    }
    if (!username?.trim() || !password) {
        return res.status(400).json({ error: 'Kullanıcı adı ve parola zorunludur (bağlantı için gerekli).' });
    }
    const prod = ['vbr', 'vone', 'vspc'].includes(product) ? product : 'vbr';
    const srv = {
        id: 'srv-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: name.trim(),
        webUrl: buildWebUrl(address, prod),
        product: prod,
        username: username.trim(),
        password: String(password),
        acceptSelfSigned: acceptSelfSigned !== false,
        addedAt: new Date().toISOString(),
    };
    registry.servers.push(srv);
    if (!registry.activeId) registry.activeId = srv.id;
    saveRegistry();
    res.json({ ok: true, server: publicServer(srv) });
});

app.post('/api/servers/:id/activate', async (req, res) => {
    const srv = registry.servers.find((s) => s.id === req.params.id);
    if (!srv) return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    if (registry.activeId !== srv.id) {
        registry.activeId = srv.id;
        saveRegistry();
        await dropClient(client); // yeni sunucuya ilk soruda yeniden bağlanılır
    }
    res.json({ ok: true, active: srv.name });
});

app.post('/api/servers/:id/test', async (req, res) => {
    const srv = registry.servers.find((s) => s.id === req.params.id);
    if (!srv) return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    res.json(await testServerReachability(srv));
});

app.delete('/api/servers/:id', async (req, res) => {
    const idx = registry.servers.findIndex((s) => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Sunucu bulunamadı.' });
    const wasActive = registry.servers[idx].id === registry.activeId;
    registry.servers.splice(idx, 1);
    if (wasActive) {
        registry.activeId = registry.servers[0]?.id || null;
        await dropClient(client);
    }
    saveRegistry();
    res.json({ ok: true });
});

app.get('/api/quota', (_req, res) => {
    res.json(quotaState());
});

app.get('/api/health', async (_req, res) => {
    let c = null;
    try {
        c = await getClient();
        await c.ping({ timeout: 10_000 });
        res.json({ ok: true, mcp: 'connected' });
    } catch (err) {
        await dropClient(c);
        res.status(503).json({ ok: false, error: String(err?.message || err) });
    }
});

app.post('/api/ask', async (req, res) => {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question) {
        return res.status(400).json({ error: 'Soru boş olamaz.' });
    }
    if (question.length > MAX_QUESTION_LEN) {
        return res.status(400).json({ error: `Soru en fazla ${MAX_QUESTION_LEN} karakter olabilir.` });
    }
    if (queueDepth >= MAX_QUEUE_DEPTH) {
        return res.status(503).json({ error: 'Sistem şu an meşgul (önde bekleyen sorular var), lütfen biraz sonra tekrar deneyin.' });
    }

    let abandoned = false;
    res.on('close', () => {
        if (!res.writableEnded) abandoned = true;
    });

    let usedClient = null;
    try {
        const result = await enqueue(async () => {
            // Don't burn a quota question on a browser that already gave up waiting
            if (abandoned) throw new Error('İstemci bağlantıyı kapattı.');
            usedClient = await getClient();
            return usedClient.callTool(
                { name: resolvedTool, arguments: { [resolvedArg]: question } },
                undefined,
                { timeout: ASK_TIMEOUT_MS },
            );
        });
        // The request reached Veeam Intelligence, so it consumed a quota question
        recordAsk();
        const payload = extractPayload(result);
        if (result.isError) {
            return res.status(502).json({ error: payload.message || 'Veeam Intelligence bir hata döndürdü.', quota: quotaState() });
        }
        res.json({
            message: typeof payload.message === 'string' ? payload.message : JSON.stringify(payload.message ?? ''),
            artifacts: Array.isArray(payload.artifacts) ? payload.artifacts : [],
            warning: payload.warning,
            quota: quotaState(),
        });
    } catch (err) {
        const msg = String(err?.message || err);
        // A timed-out request leaves the connection usable; verify before tearing it down
        if (usedClient) {
            try {
                await usedClient.ping({ timeout: 5_000 });
            } catch {
                await dropClient(usedClient);
            }
        }
        res.status(502).json({ error: msg });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`veeam-web listening on http://0.0.0.0:${PORT}`);
    // Warm up the MCP connection so the first question doesn't pay the startup cost
    getClient().catch((err) => console.error('MCP warmup failed:', err?.message || err));
});
