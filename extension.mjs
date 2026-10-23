import { createServer } from "node:http";
import { readFile, stat, mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { join, resolve, extname, dirname, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";

const HERE = dirname(fileURLToPath(import.meta.url));
const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const instances = new Map(); // instanceId -> { server, url, path, sessionId, clients }

// ---------- Neural voices: Edge online (edge-tts) + Piper offline (piper-tts) ----------
const HELPER = join(HERE, "edge_helper.py");
const PIPER_WORKER = join(HERE, "piper_worker.py");
const PIPER_DIR = join(HERE, "artifacts", "piper-voices");
const CACHE_DIR = join(tmpdir(), "plan-reader-tts");
const EDGE_LOCALES = ["en-US", "en-GB", "lt-LT"];
let pythonCmd; // resolved lazily: [cmd, ...prefixArgs] or null
let edgeCache;

function run(cmd, args, input, timeoutMs = 60000) {
    return new Promise((res) => {
        let p;
        try {
            p = spawn(cmd, args, { windowsHide: true });
        } catch (e) {
            return res({ code: -1, out: "", err: String(e) });
        }
        let out = "", err = "";
        const t = setTimeout(() => p.kill(), timeoutMs);
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (err += d));
        p.on("error", (e) => { clearTimeout(t); res({ code: -1, out, err: String(e) }); });
        p.on("close", (code) => { clearTimeout(t); res({ code, out, err }); });
        if (input != null) p.stdin.end(Buffer.from(input, "utf8"));
        else p.stdin.end();
    });
}

async function findPython() {
    if (pythonCmd !== undefined) return pythonCmd;
    for (const c of [["python"], ["py", "-3"], ["python3"]]) {
        const r = await run(c[0], [...c.slice(1), "-c", "import sys; print(sys.version_info[0])"], null, 20000);
        if (r.code === 0 && r.out.trim() === "3") return (pythonCmd = c);
    }
    return (pythonCmd = null);
}

async function edgeVoices() {
    if (edgeCache) return edgeCache;
    const py = await findPython();
    if (!py) return { available: false, reason: "Python not found", voices: [] };
    const r = await run(py[0], [...py.slice(1), HELPER, "voices"]);
    if (r.code === 3) return { available: false, reason: "edge-tts not installed (pip install edge-tts)", voices: [] };
    if (r.code !== 0) return { available: false, reason: (r.err || "voice list failed").slice(-300), voices: [] };
    const voices = JSON.parse(r.out).filter((v) => EDGE_LOCALES.includes(v.locale));
    edgeCache = { available: true, voices };
    return edgeCache;
}

async function piperVoices() {
    let files = [];
    try { files = (await readdir(PIPER_DIR)).filter((f) => f.endsWith(".onnx")); } catch {}
    const voices = files.map((f) => {
        const name = f.replace(/\.onnx$/, "");
        const m = name.match(/^([a-z]{2,3})_([A-Z]{2})-([^-]+)-(.+)$/);
        const PRETTY = { ingute: "Ingutė", reginute1: "Reginutė" };
        return { name, locale: m ? `${m[1]}-${m[2]}` : "", label: m ? PRETTY[m[3]] || m[3][0].toUpperCase() + m[3].slice(1) : name, quality: m?.[4] };
    });
    if (!voices.length) return { available: false, reason: `No Piper voices in ${PIPER_DIR}`, voices };
    const py = await findPython();
    if (!py) return { available: false, reason: "Python not found", voices: [] };
    return { available: true, voices };
}

// Persistent Piper worker so models are loaded once.
let piper; // { proc, pending: Map, nextId, ready: Promise }
function piperWorker(py) {
    if (piper && !piper.dead) return piper;
    const proc = spawn(py[0], [...py.slice(1), PIPER_WORKER], { windowsHide: true });
    const w = { proc, pending: new Map(), nextId: 1, dead: false, err: "" };
    let buf = "";
    let resolveReady, rejectReady;
    w.ready = new Promise((a, b) => { resolveReady = a; rejectReady = b; });
    w.ready.catch(() => {});
    proc.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.ready) { resolveReady(); continue; }
            const p = w.pending.get(msg.id);
            if (!p) continue;
            w.pending.delete(msg.id);
            msg.ok ? p.resolve() : p.reject(new Error(msg.error || "piper failed"));
        }
    });
    proc.stderr.on("data", (d) => { w.err = (w.err + d).slice(-500); });
    const die = (e) => {
        if (w.dead) return;
        w.dead = true;
        const reason = /not installed/.test(w.err) ? "piper-tts not installed (pip install piper-tts)" : (e || w.err || "piper worker exited");
        rejectReady(new Error(reason));
        for (const p of w.pending.values()) p.reject(new Error(reason));
        w.pending.clear();
    };
    proc.on("error", (e) => die(String(e)));
    proc.on("exit", () => die());
    piper = w;
    return w;
}

// Priority job queue for the single Piper worker. The chunk the listener is waiting for
// ("urgent") jumps ahead of prefetches; jobs whose requests were all aborted are dropped
// before they start, so clicking a far-away block doesn't wait behind stale work.
const piperPending = [];
const piperByFile = new Map();
let piperRunning = false;
let piperSeq = 0;

function piperJob(model, text, file, urgent) {
    let job = file ? piperByFile.get(file) : null;
    if (!job) {
        job = { model, text, file, urgent: !!urgent, waiters: 0, started: false, seq: piperSeq++ };
        job.promise = new Promise((a, b) => { job.resolve = a; job.reject = b; });
        job.promise.catch(() => {});
        piperPending.push(job);
        if (file) piperByFile.set(file, job);
        setImmediate(pumpPiper);
    } else if (urgent) {
        job.urgent = true;
    }
    return job;
}

function dropPiperJob(job) {
    const i = piperPending.indexOf(job);
    if (i >= 0) piperPending.splice(i, 1);
    if (job.file && piperByFile.get(job.file) === job) piperByFile.delete(job.file);
    job.reject(new Error("cancelled"));
}

async function pumpPiper() {
    if (piperRunning || !piperPending.length) return;
    piperPending.sort((a, b) => (b.urgent - a.urgent) || (a.seq - b.seq));
    const job = piperPending.shift();
    job.started = true;
    piperRunning = true;
    try {
        if (!(job.file && existsSync(job.file))) await piperSynthesize(job.model, job.text, job.file);
        job.resolve();
    } catch (e) {
        job.reject(e);
    } finally {
        if (job.file && piperByFile.get(job.file) === job) piperByFile.delete(job.file);
        piperRunning = false;
        pumpPiper();
    }
}

async function piperSynthesize(model, text, out) {
    const py = await findPython();
    if (!py) throw new Error("Python not found");
    const w = piperWorker(py);
    await w.ready;
    const id = w.nextId++;
    const done = new Promise((resolve, reject) => w.pending.set(id, { resolve, reject }));
    w.proc.stdin.write(JSON.stringify({ id, model, text, out }) + "\n");
    return done;
}

async function synthesize(voice, text, opts = {}) {
    if (!text || text.length > 3000) throw new Error("bad text");
    await mkdir(CACHE_DIR, { recursive: true });
    const key = createHash("sha1").update(`${voice}|${text}`).digest("hex");
    const [engine, id] = [voice.slice(0, voice.indexOf(":")), voice.slice(voice.indexOf(":") + 1)];
    if (engine === "edge") {
        if (!/^(en-US|en-GB|lt-LT)-[A-Za-z0-9]+Neural$/.test(id)) throw new Error("bad voice");
        const file = join(CACHE_DIR, key + ".mp3");
        if (!existsSync(file)) {
            const py = await findPython();
            if (!py) throw new Error("Python not found");
            const r = await run(py[0], [...py.slice(1), HELPER, "speak", id, "+0%", file], text);
            if (r.code !== 0 || !existsSync(file)) throw new Error((r.err || "synthesis failed").slice(-300));
        }
        return { file, type: "audio/mpeg" };
    }
    if (engine === "piper") {
        if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error("bad voice");
        const model = join(PIPER_DIR, id + ".onnx");
        if (!existsSync(model)) throw new Error("Piper voice not found: " + id);
        const file = join(CACHE_DIR, key + ".wav");
        if (!existsSync(file)) {
            const job = piperJob(model, text, file, opts.urgent);
            job.waiters++;
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                job.waiters--;
                if (!job.started && job.waiters <= 0) dropPiperJob(job);
            };
            if (opts.onCancel) opts.onCancel(release);
            try { await job.promise; } finally { release(); }
        }
        return { file, type: "audio/wav" };
    }
    throw new Error("bad voice");
}

function sessionDir(sessionId) {
    return join(COPILOT_HOME, "session-state", sessionId);
}

function defaultPath(sessionId) {
    return join(sessionDir(sessionId), "plan.md");
}

function resolveMd(p, sessionId, base) {
    const full = base ? resolve(base, p || "") : resolve(p || defaultPath(sessionId));
    const ext = extname(full).toLowerCase();
    if (![".md", ".markdown", ".txt"].includes(ext)) {
        throw new CanvasError("unsupported_file", "Only .md, .markdown or .txt files are supported.");
    }
    return full;
}

// Markdown files in the session folder (recursive, bounded).
async function listSessionFiles(sessionId, current) {
    const root = sessionDir(sessionId);
    const out = [];
    const walk = async (dir, depth) => {
        if (depth > 4 || out.length >= 500) return;
        let items = [];
        try { items = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const it of items) {
            if (it.name.startsWith(".") || it.name === "node_modules") continue;
            const full = join(dir, it.name);
            if (it.isDirectory()) await walk(full, depth + 1);
            else if (/\.(md|markdown)$/i.test(it.name)) out.push(full);
        }
    };
    await walk(root, 0);
    const files = out.map((p) => ({ path: p, name: relative(root, p) }));
    if (current && !files.some((f) => f.path.toLowerCase() === current.toLowerCase())) {
        files.push({ path: current, name: current, external: true });
    }
    const rank = (f) => (f.name.toLowerCase() === "plan.md" ? 0 : f.external ? 2 : 1);
    files.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    const recent = (await readRecent()).filter((p) => !files.some((f) => f.path.toLowerCase() === p.toLowerCase()) && existsSync(p));
    return { root, files, recent: recent.map((p) => ({ path: p, name: p.split(/[\\/]/).slice(-2).join("\\") })) };
}

// Recently opened files (user-global, outside git: artifacts/ is ignored).
const RECENT_FILE = join(HERE, "artifacts", "recent.json");
async function readRecent() {
    try { return JSON.parse(await readFile(RECENT_FILE, "utf8")); } catch { return []; }
}
async function addRecent(p) {
    if (!p || p.toLowerCase().includes(`${join(COPILOT_HOME, "session-state").toLowerCase()}`)) return;
    const list = [p, ...(await readRecent()).filter((x) => x.toLowerCase() !== p.toLowerCase())].slice(0, 15);
    try {
        await mkdir(dirname(RECENT_FILE), { recursive: true });
        await writeFile(RECENT_FILE, JSON.stringify(list, null, 1));
    } catch {}
}

// Native Windows "Open file" dialog. A PowerShell host with WinForms already loaded is
// kept warm in the background, so a click only has to show the dialog (no startup cost).
const BROWSE_PS = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$warm = New-Object System.Windows.Forms.OpenFileDialog; $warm.Dispose()
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while ($null -ne ($line = $in.ReadLine())) {
    $dir = $line.Trim()
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; StartPosition = 'CenterScreen'; Size = '1,1'; Opacity = 0 }
    $owner.Show(); $owner.Activate()
    $d = New-Object System.Windows.Forms.OpenFileDialog
    $d.Title = 'Open markdown file in Plan Reader'
    $d.Filter = 'Markdown (*.md;*.markdown)|*.md;*.markdown|Text (*.txt)|*.txt|All files (*.*)|*.*'
    if ($dir -and (Test-Path -LiteralPath $dir)) { $d.InitialDirectory = $dir }
    $r = if ($d.ShowDialog($owner) -eq 'OK') { $d.FileName } else { '' }
    $d.Dispose(); $owner.Close(); $owner.Dispose()
    [Console]::Out.WriteLine('RESULT:' + $r); [Console]::Out.Flush()
}
`;
let dialogHost = null; // { proc, ready: Promise, waiting: resolve fn | null, dead }
function getDialogHost() {
    if (dialogHost && !dialogHost.dead) return dialogHost;
    const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", Buffer.from(BROWSE_PS, "utf16le").toString("base64")], { windowsHide: true });
    const h = { proc, waiting: null, dead: false };
    let buf = "", readyFn;
    h.ready = new Promise((r) => (readyFn = r));
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, "");
            buf = buf.slice(i + 1);
            if (line === "READY") readyFn(true);
            else if (line.startsWith("RESULT:") && h.waiting) { const w = h.waiting; h.waiting = null; w(line.slice(7) || null); }
        }
    });
    const die = () => { h.dead = true; readyFn(false); if (h.waiting) { const w = h.waiting; h.waiting = null; w(null); } };
    proc.on("error", die);
    proc.on("exit", die);
    dialogHost = h;
    return h;
}

let browsing = null;
function browseForFile(initialDir) {
    if (browsing) return browsing;
    browsing = (async () => {
        const h = getDialogHost();
        if (!(await h.ready)) return null;
        const result = new Promise((r) => (h.waiting = r));
        h.proc.stdin.write((initialDir || "") + "\n");
        return result;
    })().finally(() => { browsing = null; });
    return browsing;
}

async function readJson(req) {
    let body = "";
    for await (const c of req) body += c;
    return JSON.parse(body || "{}");
}

function broadcast(entry, msg) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of entry.clients) res.write(data);
}

async function startServer(entry) {
    const server = createServer(async (req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        try {
            if (url.pathname === "/") {
                if (process.platform === "win32") getDialogHost();
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(await readFile(join(HERE, "ui.html"), "utf8"));
            } else if (url.pathname === "/file") {
                let st = null;
                try { st = await stat(entry.path); } catch {}
                const mtime = st ? `${st.mtimeMs}:${st.size}` : "";
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                const known = url.searchParams.get("known");
                if (st && known && known === `${entry.path}|${mtime}`) {
                    res.end(JSON.stringify({ path: entry.path, unchanged: true }));
                    return;
                }
                const content = st ? await readFile(entry.path, "utf8") : "";
                res.end(JSON.stringify({ path: entry.path, exists: !!st, content, version: `${entry.path}|${mtime}` }));
            } else if (url.pathname === "/files") {
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                res.end(JSON.stringify({ current: entry.path, ...(await listSessionFiles(entry.sessionId, entry.path)) }));
            } else if (url.pathname === "/browse" && req.method === "POST") {
                const picked = await browseForFile(dirname(entry.path));
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                if (!picked) { res.end(JSON.stringify({ cancelled: true })); return; }
                entry.path = resolveMd(picked, entry.sessionId);
                addRecent(entry.path);
                res.end(JSON.stringify({ path: entry.path }));
            } else if (url.pathname === "/events") {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                });
                res.write(": hi\n\n");
                entry.clients.add(res);
                req.on("close", () => entry.clients.delete(res));
            } else if (url.pathname === "/voices") {
                const [edge, piperV] = await Promise.all([edgeVoices(), piperVoices()]);
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ edge, piper: piperV }));
            } else if (url.pathname === "/tts" && req.method === "POST") {
                const { voice, text, urgent } = await readJson(req);
                let cancel = null;
                res.on("close", () => { if (!res.writableFinished && cancel) cancel(); });
                const { file, type } = await synthesize(String(voice), String(text), {
                    urgent: !!urgent,
                    onCancel: (fn) => { cancel = fn; if (res.destroyed) fn(); },
                });
                if (res.destroyed) return;
                res.setHeader("Content-Type", type);
                createReadStream(file).pipe(res);
            } else if (url.pathname === "/warm" && req.method === "POST") {
                const { voice } = await readJson(req);
                const id = String(voice || "").replace(/^piper:/, "");
                const model = join(PIPER_DIR, id + ".onnx");
                if (/^[A-Za-z0-9_.-]+$/.test(id) && existsSync(model)) piperJob(model, "", null, false);
                res.setHeader("Content-Type", "application/json");
                res.end("{}");
            } else if (url.pathname === "/load" && req.method === "POST") {
                const { path, relative: rel } = await readJson(req);
                entry.path = resolveMd(path, entry.sessionId, rel ? dirname(entry.path) : undefined);
                if (existsSync(entry.path)) addRecent(entry.path);
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ path: entry.path }));
            } else {
                res.statusCode = 404;
                res.end("not found");
            }
        } catch (e) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: String(e?.message || e) }));
        }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    entry.server = server;
    entry.url = `http://127.0.0.1:${server.address().port}/`;
}

function getEntry(instanceId) {
    const e = instances.get(instanceId);
    if (!e) throw new CanvasError("not_open", "Canvas instance is not open.");
    return e;
}

const canvas = createCanvas({
    id: "plan-reader",
    displayName: "Plan Reader (TTS)",
    description: "Render a markdown file (default: this session's plan.md) and read it aloud with text-to-speech.",
    inputSchema: {
        type: "object",
        properties: {
            path: { type: "string", description: "Absolute path to a .md file. Defaults to the session's plan.md." },
        },
        additionalProperties: false,
    },
    actions: [
        {
            name: "load",
            description: "Load another markdown file into the reader.",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
                additionalProperties: false,
            },
            handler: async (ctx) => {
                const e = getEntry(ctx.instanceId);
                e.path = resolveMd(ctx.input?.path, ctx.sessionId);
                if (existsSync(e.path)) addRecent(e.path);
                broadcast(e, { type: "reload" });
                return { path: e.path, exists: existsSync(e.path) };
            },
        },
        {
            name: "list",
            description: "List markdown files in this session's folder that can be loaded.",
            handler: async (ctx) => {
                const e = instances.get(ctx.instanceId);
                return await listSessionFiles(ctx.sessionId, e?.path);
            },
        },
        {
            name: "play",
            description: "Start or resume reading aloud.",
            handler: async (ctx) => {
                const e = getEntry(ctx.instanceId);
                broadcast(e, { type: "play" });
                return { ok: true, listeners: e.clients.size };
            },
        },
        {
            name: "stop",
            description: "Stop reading aloud.",
            handler: async (ctx) => {
                const e = getEntry(ctx.instanceId);
                broadcast(e, { type: "stop" });
                return { ok: true, listeners: e.clients.size };
            },
        },
    ],
    open: async (ctx) => {
        let entry = instances.get(ctx.instanceId);
        const path = resolveMd(ctx.input?.path, ctx.sessionId);
        if (ctx.input?.path && existsSync(path)) addRecent(path);
        if (!entry) {
            entry = { path, sessionId: ctx.sessionId, clients: new Set() };
            await startServer(entry);
            instances.set(ctx.instanceId, entry);
        } else {
            entry.path = path;
            broadcast(entry, { type: "reload" });
        }
        let name = path.split(/[\\/]/).pop();
        try { await stat(path); } catch { name += " (not found)"; }
        return { title: `🔊 ${name}`, url: entry.url };
    },
    onClose: async (ctx) => {
        const e = instances.get(ctx.instanceId);
        if (!e) return;
        instances.delete(ctx.instanceId);
        for (const c of e.clients) c.end();
        await new Promise((r) => e.server.close(() => r()));
    },
});

await joinSession({ canvases: [canvas] });
process.on("exit", () => { try { piper?.proc.kill(); } catch {} try { dialogHost?.proc.kill(); } catch {} });
