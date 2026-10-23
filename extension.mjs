import { createServer } from "node:http";
import { readFile, stat, mkdir, readdir } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { join, resolve, extname, dirname } from "node:path";
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
        return { name, locale: m ? `${m[1]}-${m[2]}` : "", label: m ? m[3][0].toUpperCase() + m[3].slice(1) : name, quality: m?.[4] };
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

let piperQueue = Promise.resolve();
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

async function synthesize(voice, text) {
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
            // serialize requests: the worker handles one at a time anyway
            const job = piperQueue.then(() => existsSync(file) ? null : piperSynthesize(model, text, file));
            piperQueue = job.catch(() => {});
            await job;
        }
        return { file, type: "audio/wav" };
    }
    throw new Error("bad voice");
}

function defaultPath(sessionId) {
    return join(COPILOT_HOME, "session-state", sessionId, "plan.md");
}

function resolveMd(p, sessionId) {
    const full = resolve(p || defaultPath(sessionId));
    const ext = extname(full).toLowerCase();
    if (![".md", ".markdown", ".txt"].includes(ext)) {
        throw new CanvasError("unsupported_file", "Only .md, .markdown or .txt files are supported.");
    }
    return full;
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
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(await readFile(join(HERE, "ui.html"), "utf8"));
            } else if (url.pathname === "/file") {
                const exists = existsSync(entry.path);
                const content = exists ? await readFile(entry.path, "utf8") : "";
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                res.end(JSON.stringify({ path: entry.path, exists, content }));
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
                let body = "";
                for await (const c of req) body += c;
                const { voice, text } = JSON.parse(body || "{}");
                const { file, type } = await synthesize(String(voice), String(text));
                res.setHeader("Content-Type", type);
                createReadStream(file).pipe(res);
            } else if (url.pathname === "/warm" && req.method === "POST") {
                let body = "";
                for await (const c of req) body += c;
                const { voice } = JSON.parse(body || "{}");
                const id = String(voice || "").replace(/^piper:/, "");
                const model = join(PIPER_DIR, id + ".onnx");
                if (/^[A-Za-z0-9_.-]+$/.test(id) && existsSync(model)) {
                    piperQueue = piperQueue.then(() => piperSynthesize(model, "", null)).catch(() => {});
                }
                res.setHeader("Content-Type", "application/json");
                res.end("{}");
            } else if (url.pathname === "/load" && req.method === "POST") {
                let body = "";
                for await (const c of req) body += c;
                const { path } = JSON.parse(body || "{}");
                entry.path = resolveMd(path, entry.sessionId);
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
                broadcast(e, { type: "reload" });
                return { path: e.path, exists: existsSync(e.path) };
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
process.on("exit", () => { try { piper?.proc.kill(); } catch {} });
