// GODMIX local server · by Kyler Simzer (kyler@stems.fm). Binds to 127.0.0.1 only and needs nothing but Node.js (20+).
// Usage: node app/server.js [port] [--open] [--demo]        (port: GODMIX_PORT, then the argument, then 8333)
//
// --demo (or GODMIX_DEMO=1) is the public, online copy: "Try GODMIX". It serves the demo album only, from MP3 copies in
// app/cache/public (python app/build_public.py), never shows a file path, and changes nothing on the server: no jobs,
// no state, no covers, no folders. Visitors' notes, marks and running order are kept in their own browser.
//
//   GET  /                                   the homepage (web/home.html)
//   GET  /app                                the app (web/index.html)
//   GET  /soon                               "coming soon", where the online demo's install links go (web/soon.html)
//   GET  /css/* /js/* /assets/*              static files from web/
//   GET  /api/health                         {"ok":true, version, mode: "local" | "demo", albums}
//   GET  /api/albums                         album list (data/albums.json);  ?cards=1 in demo mode: every released album,
//                                            for the homepage's album cards (titles and loudness art only, never playable;
//                                            unreleased albums are never sent)
//   GET  /data/<album>.json                  that album's track data (built by build_data.py)
//   GET  /audio/<album>/<orig|master>/<id>   a track's original or album master (Range requests, for seeking)
//   GET  /audio/<album>/version/<id>?v=...   one of its alternate versions
//   GET  /api/state?album=<id>               saved running order, notes, marks and settings for that album
//   POST /api/state?album=<id>               save them (state/<id>.json)
//   POST /api/open                           show an album folder, a track, or a finished export, in the file manager
//   GET  /api/jobs                           recent jobs (making versions, exports) with progress
//   POST /api/jobs                           queue one: {kind: "make", album, tracks?, versions?}, {kind: "export", album, ...spec},
//                                            {kind: "album", action: "add" | "edit", id?, title, subtitle, artist, folder?},
//                                            or {kind: "trace", album, items, version, recipients, phrase, voice, say_name, clips, density, formats}
//   POST /api/folder                         {path}: the audio files in a folder, to preview a new album
//   GET  /api/cover?album=<id>               the album's cover image for exports;  POST (raw PNG/JPEG bytes) sets it,
//                                            POST ?clear=1 removes it
//   GET  /api/trace                          Trace Tags: the saved tag recordings and the copies made so far (no paths)
//   GET  /api/trace/clip?name=               play a saved tag recording;  POST (raw audio) saves one, POST ?clear=1 removes it
//   POST /api/trace/preview                  {text, voice}: the typed words spoken, as a WAV
//   POST /api/trace/check?ext=mp3            (raw audio) a leaked file: queues a job that says whose copy it is
//   GET  /api/demo-export?fmt=wav|flac|mp3   the homepage's download: one tagged demo song, made into the cache on
//                                            first request ({ready, url} or {ready: false, job});  /api/demo-export/file?fmt=
//                                            serves it as a download
//
// Only audio files listed in the data files can be played or revealed, and static files must sit inside
// web/, so the server can't be used to read anything else on the machine.
//
// Environment: GODMIX_PORT, GODMIX_HOST (default 127.0.0.1; keep it behind a proxy when online), GODMIX_DEMO,
// GODMIX_DATA_DIR, GODMIX_STATE_DIR, GODMIX_PUBLIC_DIR (the demo's MP3s and downloads), GODMIX_PYTHON.
const http = require("http"), fs = require("fs"), path = require("path"), { spawn } = require("child_process");

const HERE = __dirname;
const VERSION = require(path.join(HERE, "..", "package.json")).version;
const WEB = path.join(HERE, "web");
const DATA = process.env.GODMIX_DATA_DIR || path.join(HERE, "data");
const STATE_DIR = process.env.GODMIX_STATE_DIR || path.join(HERE, "state");
const PUBLIC = process.env.GODMIX_PUBLIC_DIR || path.join(HERE, "cache", "public");
const DEMO_ID = "demo";
const DEMO_ENV = process.env.GODMIX_DEMO === "1" || process.argv.includes("--demo");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".webmanifest": "application/manifest+json", ".woff2": "font/woff2",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".aif": "audio/aiff", ".aiff": "audio/aiff", ".m4a": "audio/mp4",
};
const ID = /^[\w!.&' -]{1,40}$/;              // album ids like "000", "O", "demo"

// album data, re-read whenever build_data.py rewrites the file
const cache = {};
function album(id) {
  if (!ID.test(id || "")) return null;
  const f = path.join(DATA, `${id}.json`);
  if (!fs.existsSync(f)) return null;
  const m = fs.statSync(f).mtimeMs;
  if (!cache[id] || cache[id].m !== m) cache[id] = { m, d: JSON.parse(fs.readFileSync(f, "utf8")) };
  return cache[id].d;
}
const findTrack = (a, id) => a && a.tracks.find(t => t.name === id);
// the album data as the online demo shows it: everything but where the files are
const PRIVATE = new Set(["folder", "masters_folder", "versions_folder", "paths", "path"]);
function publicData(id) {
  const a = album(id);
  if (!a) return null;
  if (cache[id].pub == null) cache[id].pub = JSON.stringify(a, (k, v) => (PRIVATE.has(k) ? undefined : v));
  return cache[id].pub;
}
// the demo's streaming copy of a song or version: public/audio/<song>/<orig|master|version label>.mp3
function publicAudio(t, kind, label) {
  const dir = path.join(PUBLIC, "audio", path.parse(t.name).name);
  const names = kind === "version" ? [label] : kind === "orig" ? ["orig", "master"] : ["master"];
  for (const n of names) {
    const f = path.join(dir, `${n}.mp3`);
    if (f.startsWith(PUBLIC + path.sep) && fs.existsSync(f)) return f;
  }
  return null;
}
const albumList = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, "albums.json"), "utf8")); } catch { return []; } };

function sendFile(req, res, file, { cache: maxAge = 0, download = null } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("not found"); return; }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const head = { "Content-Type": type, "Accept-Ranges": "bytes", "ETag": etag,
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-cache", "X-Content-Type-Options": "nosniff" };
    if (download) head["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;
    if (req.headers["if-none-match"] === etag && !req.headers.range) { res.writeHead(304, head).end(); return; }
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (m) {
      const start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]);
      const end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      if (start > end) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }).end(); return; }
      res.writeHead(206, { ...head, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${st.size}` });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...head, "Content-Length": st.size });
      if (req.method === "HEAD") res.end(); else fs.createReadStream(file).pipe(res);
    }
  });
}

// a file under web/, or null if the path tries to leave it
function webFile(rel) {
  const f = path.resolve(WEB, "." + path.posix.normalize("/" + rel));
  return f.startsWith(WEB + path.sep) ? f : null;
}

function readBody(req, cb) {
  let body = "";
  req.on("data", c => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on("end", () => { try { cb(JSON.parse(body || "{}")); } catch { cb(null); } });
}

// show a folder, or a file selected in its folder, in the system file manager
function reveal(target, isFile) {
  const run = (cmd, args, opts = {}) => spawn(cmd, args, { detached: true, stdio: "ignore", ...opts }).unref();
  if (process.platform === "win32")      // explorer.exe exits with code 1 even when it works, so the result is ignored
    run("explorer.exe", [isFile ? `/select,"${target}"` : `"${target}"`], { windowsVerbatimArguments: true });
  else if (process.platform === "darwin") run("open", isFile ? ["-R", target] : [target]);
  else run("xdg-open", [isFile ? path.dirname(target) : target]);
}

// ── jobs: Python work the app asks for (app/jobs.py), one at a time ──
const ROOT = path.join(HERE, "..");
const PY = process.env.GODMIX_PYTHON || [path.join(ROOT, ".venv", "Scripts", "python.exe"), path.join(ROOT, ".venv", "bin", "python")].find(p => fs.existsSync(p))
  || (process.platform === "win32" ? "python" : "python3");
const JOB_DIR = path.join(HERE, "cache", "jobs");
const jobs = [];          // newest last; finished ones are kept for the session (the last 30)
let running = null;
const publicJob = j => ({ id: j.id, kind: j.kind, album: j.album, label: j.label, tracks: j.tracks, versions: j.versions, status: j.status,
  action: j.action, p: j.p, msg: j.msg, result: j.result ? { folder: j.result.folder, files: j.result.files, made: j.result.made, fell_back: j.result.fell_back, album: j.result.album, match: j.result.match } : null,
  error: j.error, log: j.status === "error" ? j.log.slice(-12) : undefined, started: j.started, ended: j.ended });
function runNext() {
  if (running) return;
  const j = jobs.find(x => x.status === "queued");
  if (!j) return;
  running = j; j.status = "running"; j.started = Date.now(); j.msg = "Starting…";
  const child = spawn(PY, ["-u", path.join(HERE, "jobs.py"), ...j.args], { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: "utf-8" }, windowsHide: true });
  let buf = "";
  child.stdout.on("data", d => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
      if (line.startsWith("@@ ")) {
        try { const m = JSON.parse(line.slice(3)); if (m.p != null) j.p = m.p; j.msg = m.msg; if (m.result) j.result = m.result; if (m.error) j.error = m.error; } catch {}
      } else if (line.trim()) { j.log.push(line); if (j.log.length > 200) j.log.shift(); }
    }
  });
  child.stderr.on("data", d => { for (const l of d.toString("utf8").split(/\r?\n/)) if (l.trim() && !/Warning|warn\(/.test(l)) j.log.push(l); });
  child.on("error", e => { j.error = `Couldn't start Python (${PY}): ${e.message}`; });
  child.on("close", code => {
    j.ended = Date.now(); j.status = code === 0 && !j.error ? "done" : "error";
    if (j.status === "error" && !j.error) j.error = j.log.slice(-1)[0] || `exited with code ${code}`;
    if (j.specFile) fs.rm(j.specFile, { force: true }, () => {});
    running = null;
    while (jobs.length > 30 && !["running", "queued"].includes(jobs[0].status)) jobs.shift();
    runNext();
  });
}
const FORMATS = ["wav", "wav24_48", "wav24_441", "wav16", "aiff", "flac", "alac", "mp3", "aac"];
const AUDIO = /\.(wav|flac|aiff?)$/i;
const coverFile = id => ["png", "jpg"].map(e => path.join(STATE_DIR, "covers", `${id}.${e}`)).find(f => fs.existsSync(f));
const publicCover = () => ["png", "jpg"].map(e => path.join(PUBLIC, `cover.${e}`)).find(f => fs.existsSync(f));
const str = (v, n = 300) => (typeof v === "string" ? v.slice(0, n) : "");
// adding an album, or changing an album's title, subtitle or artist
function queueAlbumJob(body) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let j;
  const spec = { action: body.action, id: body.id, title: str(body.title, 80), subtitle: str(body.subtitle, 80), artist: str(body.artist, 120), folder: str(body.folder, 1000) };
  if (spec.action === "edit" && !albumList().some(x => x.id === spec.id)) return [400, "unknown album"];
  if (spec.action === "add" && !(path.isAbsolute(spec.folder) && fs.existsSync(spec.folder) && fs.statSync(spec.folder).isDirectory())) return [400, "that folder doesn't exist"];
  if (!["add", "edit"].includes(spec.action)) return [400, "unknown action"];
  fs.mkdirSync(JOB_DIR, { recursive: true });
  const specFile = path.join(JOB_DIR, `${id}.json`);
  fs.writeFileSync(specFile, JSON.stringify(spec));
  j = { kind: "album", action: spec.action, specFile, label: spec.action === "add" ? `Adding ${spec.title || "the album"}` : `Saving ${spec.title}`, args: ["album", specFile] };
  Object.assign(j, { id, album: spec.action === "edit" ? spec.id : null, status: "queued", p: 0, msg: "Waiting", log: [], result: null, error: null });
  jobs.push(j); runNext();
  return [200, publicJob(j)];
}

function queueJob(body) {
  if (body.kind === "album") return queueAlbumJob(body);
  const a = album(body.album);
  if (!a) return [400, "unknown album"];
  const names = new Set(a.tracks.map(t => t.name)), kinds = a.version_kinds || ["Slowed + Reverb", "Sped Up", "Other Room", "Bass Boosted", "Max Bass Boost"];
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let j;
  if (body.kind === "make") {
    const tracks = (body.tracks || []).filter(n => names.has(n)), versions = (body.versions || []).filter(v => kinds.includes(v));
    if ((body.tracks || []).length !== tracks.length || (body.versions || []).length !== versions.length) return [400, "unknown track or version"];
    j = { kind: "make", tracks, versions, label: versions.length === 1 ? `Making ${versions[0]}` : "Making versions",
      args: ["make", "--album", a.id, ...tracks.flatMap(t => ["--track", t]), ...versions.flatMap(v => ["--version", v])] };
  } else if (body.kind === "export") {
    const items = (body.items || []).filter(i => i && names.has(i.id)).map(i => ({ id: i.id, title: str(i.title, 200) || a.tracks.find(t => t.name === i.id).title }));
    if (!items.length) return [400, "nothing to export"];
    const formats = (body.formats || []).filter(f => FORMATS.includes(f));
    const meta = Object.fromEntries(["artist", "album_artist", "album", "year", "genre", "label", "composer", "copyright", "comment"].map(k => [k, str(body.meta?.[k])]));
    const isrc = Object.fromEntries(Object.entries(body.isrc || {}).filter(([k, v]) => names.has(k) && /^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/i.test(v)).map(([k, v]) => [k, v.toUpperCase()]));
    const spec = { album: a.id, what: ["songs", "album", "both"].includes(body.what) ? body.what : "songs", version: kinds.includes(body.version) ? body.version : "",
      items, gap: Math.min(10, Math.max(0, +body.gap || 0)), formats: formats.length ? formats : ["wav"], meta, isrc, cover: body.cover ? coverFile(a.id) || null : null };
    fs.mkdirSync(JOB_DIR, { recursive: true });
    const specFile = path.join(JOB_DIR, `${id}.json`);
    fs.writeFileSync(specFile, JSON.stringify(spec));
    j = { kind: "export", what: spec.what, specFile, label: spec.what === "album" ? "Rendering the full album" : "Exporting", args: ["export", specFile] };
  } else if (body.kind === "trace") {
    const items = (body.items || []).filter(i => i && names.has(i.id)).map(i => ({ id: i.id, title: str(i.title, 200) || a.tracks.find(t => t.name === i.id).title }));
    const recipients = [...new Set((Array.isArray(body.recipients) ? body.recipients : []).map(r => str(r, 60).replace(/[\\/:*?"<>|]/g, "").trim()).filter(Boolean))].slice(0, 50);
    const clips = (Array.isArray(body.clips) ? body.clips : []).filter(c => CLIP_NAME.test(c) && fs.existsSync(path.join(CLIP_DIR, c)));
    const phrase = str(body.phrase, 200).trim();
    const formats = (Array.isArray(body.formats) ? body.formats : []).filter(f => ["wav", "mp3"].includes(f));
    if (!items.length) return [400, "pick at least one song"];
    if (!recipients.length) return [400, "add at least one person"];
    if (!phrase && !clips.length) return [400, "add some words or a recording for the tag"];
    const spec = { album: a.id, items, version: kinds.includes(body.version) ? body.version : "", recipients, phrase, clips,
      voice: body.voice === "female" ? "female" : "male", say_name: !!body.say_name,
      density: ["light", "normal", "heavy"].includes(body.density) ? body.density : "normal", formats: formats.length ? formats : ["wav"] };
    fs.mkdirSync(JOB_DIR, { recursive: true });
    const specFile = path.join(JOB_DIR, `${id}.json`);
    fs.writeFileSync(specFile, JSON.stringify(spec));
    const n = items.length * recipients.length;
    j = { kind: "trace", specFile, label: `Trace Tags: ${n} cop${n === 1 ? "y" : "ies"}`, args: ["trace", specFile] };
  } else return [400, "unknown job"];
  Object.assign(j, { id, album: a.id, status: "queued", p: 0, msg: "Waiting", log: [], result: null, error: null });
  jobs.push(j); runNext();
  return [200, publicJob(j)];
}

// ── Trace Tags: tag recordings, spoken previews, the ledger, and checking a leak ──
const CLIP_DIR = path.join(STATE_DIR, "trace-clips");
const CLIP_NAME = /^[\w .()&'-]{1,80}\.(wav|flac|aiff?|mp3)$/i;
const TRACE_TMP = path.join(HERE, "cache", "trace");
function traceInfo() {
  const clips = fs.existsSync(CLIP_DIR) ? fs.readdirSync(CLIP_DIR).filter(f => CLIP_NAME.test(f)).sort() : [];
  let copies = [];
  try { copies = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "trace-tags.json"), "utf8")).copies || []; } catch {}
  return { clips, total: copies.length,
    recent: copies.slice(-40).reverse().map(c => ({ id: c.id, made: c.made, album: c.album, title: c.title, version: c.version, recipient: c.recipient })) };
}
// a raw request body → a file (uploads); calls back with null if it's empty or over the limit
function saveBody(req, file, limit, cb) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(file);
  let size = 0, over = false;
  req.on("data", c => {
    if (over) return;
    size += c.length;
    if (size > limit) { over = true; out.destroy(); fs.rm(file, { force: true }, () => {}); cb(null); req.destroy(); }
    else out.write(c);
  });
  req.on("end", () => { if (!over) out.end(() => { if (!size) fs.rmSync(file, { force: true }); cb(size ? file : null); }); });
}
function tracePreview(req, res) {
  readBody(req, body => {
    const text = body && str(body.text, 200).trim();
    if (!text) return json(res, { error: "type something to hear it" }, 400);
    fs.mkdirSync(TRACE_TMP, { recursive: true });
    const out = path.join(TRACE_TMP, `preview-${Date.now().toString(36)}.wav`);
    const child = spawn(PY, [path.join(ROOT, "trace_tags.py"), "speak", text, out, body.voice === "female" ? "female" : "male"], { cwd: ROOT, windowsHide: true });
    let err = "";
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => json(res, { error: `Couldn't start Python: ${e.message}` }, 500));
    child.on("close", code => {
      if (code !== 0 || !fs.existsSync(out)) return json(res, { error: err.trim().split(/\r?\n/).pop() || "no voice" }, 500);
      res.on("finish", () => fs.rm(out, { force: true }, () => {}));
      sendFile(req, res, out);
    });
  });
}
function traceCheck(req, res, ext) {
  if (!["wav", "flac", "aif", "aiff", "mp3", "m4a"].includes(ext)) return json(res, { error: "WAV, FLAC, AIFF, MP3 or M4A" }, 415);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  saveBody(req, path.join(TRACE_TMP, `check-${id}.${ext}`), 300e6, file => {
    if (!file) return json(res, { error: "that file is empty or too big" }, 413);
    fs.mkdirSync(JOB_DIR, { recursive: true });
    const specFile = path.join(JOB_DIR, `${id}.json`);
    fs.writeFileSync(specFile, JSON.stringify({ file }));
    const j = { id, kind: "trace-check", album: null, specFile, label: "Checking whose copy it is", args: ["trace-check", specFile],
      status: "queued", p: 0, msg: "Waiting", log: [], result: null, error: null };
    jobs.push(j); runNext();
    json(res, publicJob(j));
  });
}

// ── the homepage's demo download: one tagged song in one format, exported into the cache the first time it's asked for ──
// Online (demo mode) the files are made ahead of time by build_public.py, into public/download, and nothing runs.
const DEMO_EXPORT = path.join(HERE, "cache", "demo-export");
const DEMO_FMTS = { wav: ".wav", flac: ".flac", mp3: ".mp3" };
const demoExportFile = (fmt, dir = DEMO_EXPORT) => fs.existsSync(dir) && fs.readdirSync(dir).filter(f => /^\d\d\. /.test(f) && f.toLowerCase().endsWith(DEMO_FMTS[fmt])).map(f => path.join(dir, f))[0];
function demoExport(fmt, res, demo) {
  const a = album("demo");
  if (!a || !DEMO_FMTS[fmt]) return json(res, { error: "no demo album" }, 404);
  if (demo) {
    const f = demoExportFile(fmt, path.join(PUBLIC, "download"));
    return f ? json(res, { ready: true, url: `/api/demo-export/file?fmt=${fmt}`, name: path.basename(f), size: fs.statSync(f).size }) : json(res, { error: "not prepared" }, 404);
  }
  // a job still writing the file comes first, or a half-written file would be served
  const live = jobs.find(j => j.demo === fmt && ["queued", "running"].includes(j.status));
  if (live) return json(res, { ready: false, job: publicJob(live) });
  const f = demoExportFile(fmt);
  if (f) return json(res, { ready: true, url: `/api/demo-export/file?fmt=${fmt}`, name: path.basename(f), size: fs.statSync(f).size });
  const t = a.tracks.find(x => x.title === "Blue") || a.tracks[0];
  const cover = coverFile("demo") || path.join(ROOT, "design", "logo", "godmix-mark-white-on-black-1024.png");
  const year = String(a.year || new Date().getFullYear()), artist = a.artist || "";
  const spec = { album: "demo", what: "songs", version: "", items: [{ id: t.name, title: t.title }], gap: 0, formats: [fmt],
    meta: { artist, album_artist: artist, album: a.title, year, genre: "", label: "", composer: artist, copyright: artist ? `© ${year} ${artist}. All rights reserved.` : "", comment: "Exported by GODMIX" },
    isrc: t.isrc ? { [t.name]: t.isrc } : {}, cover: fs.existsSync(cover) ? cover : null, folder: DEMO_EXPORT };
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  fs.mkdirSync(JOB_DIR, { recursive: true });
  const specFile = path.join(JOB_DIR, `${id}.json`);
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const j = { id, kind: "export", demo: fmt, album: "demo", specFile, label: `Preparing the ${fmt.toUpperCase()} download`, args: ["export", specFile],
    status: "queued", p: 0, msg: "Waiting", log: [], result: null, error: null };
  jobs.push(j); runNext();
  return json(res, { ready: false, job: publicJob(j) });
}

// the two pages; in demo mode they're marked with class="demo", so they say "Try GODMIX" from the first paint
function sendPage(req, res, file, demo) {
  if (!demo) return sendFile(req, res, file);
  fs.readFile(file, "utf8", (err, html) => {
    if (err) return res.writeHead(404).end("not found");
    const body = html.replace('<html lang="en">', '<html lang="en" class="demo">');
    res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" });
    res.end(req.method === "HEAD" ? undefined : body);
  });
}

const json = (res, body, code = 200) => res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-cache" })
  .end(typeof body === "string" ? body : JSON.stringify(body));

// The installed app answers only requests addressed to this computer, so a web page can't reach it through a
// DNS name that points here (DNS rebinding). The online demo sits behind a proxy and answers any host.
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.localhost)(:\d+)?$/i;

function handle(req, res, demo) {
  if (!demo && !LOOPBACK.test(req.headers.host || "")) return res.writeHead(421).end("GODMIX only answers on localhost");
  const url = new URL(req.url, "http://localhost");
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return res.writeHead(400).end(); }
  // online, the demo album is the only album there is
  const album_ = demo ? id => (id === DEMO_ID ? album(id) : null) : album;
  const list = () => (demo ? albumList().filter(a => a.id === DEMO_ID) : albumList());
  if (req.method === "GET" || req.method === "HEAD") {
    if (p === "/" || p === "/home") return sendPage(req, res, path.join(WEB, "home.html"), demo);
    if (p === "/app" || p === "/app/" || p === "/index.html") return sendPage(req, res, path.join(WEB, "index.html"), demo);
    if (p === "/soon") return sendPage(req, res, path.join(WEB, "soon.html"), demo);
    if (p === "/favicon.ico") return sendFile(req, res, path.join(WEB, "assets", "favicon-32.png"), { cache: 86400 });
    if (/^\/(css|js|assets)\//.test(p)) {
      const f = webFile(p.slice(1));
      return f ? sendFile(req, res, f, { cache: p.startsWith("/assets/") ? 3600 : 0 }) : res.writeHead(404).end();
    }
    if (p === "/manifest.webmanifest") return sendFile(req, res, path.join(WEB, "manifest.webmanifest"));
    if (p === "/api/health") return json(res, { ok: true, name: "godmix", version: VERSION, mode: demo ? "demo" : "local", albums: list().map(a => a.id) });
    if (p === "/api/albums") return json(res, demo && url.searchParams.get("cards") ? albumList().filter(a => a.released) : list());
    if (p === "/api/jobs") return json(res, demo ? [] : jobs.map(publicJob));
    if (p === "/api/cover") {
      const id = url.searchParams.get("album"), f = album_(id) && (demo ? publicCover() : coverFile(id));
      return f ? sendFile(req, res, f) : res.writeHead(404).end();
    }
    if (p === "/api/trace") return demo ? res.writeHead(404).end() : json(res, traceInfo());
    if (p === "/api/trace/clip") {
      const name = url.searchParams.get("name") || "";
      return !demo && CLIP_NAME.test(name) ? sendFile(req, res, path.join(CLIP_DIR, name)) : res.writeHead(404).end();
    }
    // installed, this starts a job, so like every write it needs the header (another website can't send it)
    if (p === "/api/demo-export") return !demo && req.headers["x-god-mix"] !== "1" ? res.writeHead(403).end() : demoExport(url.searchParams.get("fmt"), res, demo);
    if (p === "/api/demo-export/file") {
      const fmt = url.searchParams.get("fmt"), f = DEMO_FMTS[fmt] && demoExportFile(fmt, demo ? path.join(PUBLIC, "download") : DEMO_EXPORT);
      return f ? sendFile(req, res, f, { download: path.basename(f) }) : res.writeHead(404).end();
    }
    let m = /^\/data\/([^/]+)\.json$/.exec(p);
    if (m) {
      if (!album_(m[1])) return res.writeHead(404).end();
      return demo ? json(res, publicData(m[1])) : sendFile(req, res, path.join(DATA, `${m[1]}.json`));
    }
    if (p === "/api/state") {
      const id = url.searchParams.get("album");
      if (!album_(id)) return res.writeHead(404).end();
      if (demo) return json(res, "{}");                 // online, the browser keeps its own notes
      const f = path.join(STATE_DIR, `${id}.json`);
      return json(res, fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "{}");
    }
    m = /^\/audio\/([^/]+)\/(orig|master|version)\/(.+)$/.exec(p);
    if (m) {
      const t = findTrack(album_(m[1]), m[3]);
      if (!t) return res.writeHead(404).end("not found");
      const v = url.searchParams.get("v") || "";
      if (m[2] === "version" && !Object.hasOwn(t.paths.versions || {}, v)) return res.writeHead(404).end("not found");
      // online: the MP3 copy, streamed (cached a day; the files only change when build_public.py runs)
      const pub = demo && publicAudio(t, m[2], v);
      if (pub) return sendFile(req, res, pub, { cache: 86400 });
      const f = m[2] === "version" ? t.paths.versions[v] : t.paths[m[2]];
      return f ? sendFile(req, res, f) : res.writeHead(404).end("not found");
    }
    return res.writeHead(404).end("not found");
  }
  if (req.method === "POST") {
    // the online demo changes nothing on the server
    if (demo) return json(res, { error: "This is the online demo. Install GODMIX to do this with your own albums." }, 403);
    // a custom header forces a CORS preflight, which this server never approves, so other websites can't post here
    if (req.headers["x-god-mix"] !== "1") return res.writeHead(403).end();
    if (p === "/api/state") {
      const id = url.searchParams.get("album");
      if (!album(id)) return res.writeHead(404).end();
      return readBody(req, body => {
        if (!body || typeof body !== "object" || Array.isArray(body)) return res.writeHead(400).end();
        fs.mkdirSync(STATE_DIR, { recursive: true });
        const f = path.join(STATE_DIR, `${id}.json`), tmp = f + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(body, null, 2));          // write then rename, so a crash never leaves half a file
        fs.renameSync(tmp, f);
        json(res, { ok: true });
      });
    }
    if (p === "/api/folder") return readBody(req, body => {
      const dir = body && str(body.path, 1000).trim().replace(/^"|"$/g, "");
      if (!dir || !path.isAbsolute(dir)) return json(res, { ok: false, error: "Paste the full path of the album's folder" });
      fs.readdir(dir, { withFileTypes: true }, (err, list) => {
        if (err) return json(res, { ok: false, error: "No folder there" });
        const files = list.filter(d => d.isFile() && AUDIO.test(d.name)).map(d => d.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        json(res, { ok: true, path: dir, files: files.slice(0, 200), count: files.length });
      });
    });
    if (p === "/api/trace/preview") return tracePreview(req, res);
    if (p === "/api/trace/check") return traceCheck(req, res, (url.searchParams.get("ext") || "").toLowerCase());
    if (p === "/api/trace/clip") {
      const name = url.searchParams.get("name") || "";
      if (!CLIP_NAME.test(name)) return json(res, { error: "WAV, FLAC, AIFF or MP3, with a plain file name" }, 400);
      const f = path.join(CLIP_DIR, name);
      if (url.searchParams.get("clear")) { fs.rmSync(f, { force: true }); return json(res, { ok: true }); }
      return saveBody(req, f, 30e6, ok => (ok ? json(res, { ok: true, name }) : json(res, { error: "that recording is empty or over 30 MB" }, 413)));
    }
    if (p === "/api/jobs") return readBody(req, body => { const [code, out] = body ? queueJob(body) : [400, "bad request"]; json(res, typeof out === "string" ? { error: out } : out, code); });
    if (p === "/api/cover") {
      const id = url.searchParams.get("album");
      if (!album(id)) return res.writeHead(404).end();
      const old = coverFile(id);
      if (url.searchParams.get("clear")) { if (old) fs.rmSync(old); return json(res, { ok: true }); }
      const type = req.headers["content-type"] || "", ext = type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : null;
      if (!ext) return json(res, { error: "PNG or JPEG only" }, 415);
      const chunks = []; let size = 0;
      req.on("data", c => { size += c.length; if (size > 20e6) req.destroy(); else chunks.push(c); });
      req.on("end", () => {
        fs.mkdirSync(path.join(STATE_DIR, "covers"), { recursive: true });
        if (old) fs.rmSync(old);
        fs.writeFileSync(path.join(STATE_DIR, "covers", `${id}.${ext}`), Buffer.concat(chunks));
        json(res, { ok: true });
      });
      return;
    }
    if (p === "/api/open") {
      return readBody(req, body => {
        if (body && body.job) {                    // a finished export: the folder comes from our own job record, not the browser
          const j = jobs.find(x => x.id === body.job), f = j?.result?.folder;
          if (!f || !fs.existsSync(f)) return res.writeHead(404).end();
          reveal(f, false); return json(res, { ok: true });
        }
        const a = body && album(body.album);
        if (!a) return res.writeHead(400).end();
        if (body.track) {
          const t = findTrack(a, body.track);
          const f = t && (body.where === "orig" ? t.paths.orig : body.where === "version" ? t.paths.versions[body.version] : t.paths.master);
          if (!f || !fs.existsSync(f)) return res.writeHead(404).end();
          reveal(f, true);
        } else {
          const dir = { orig: a.folder, master: a.masters_folder, versions: a.versions_folder }[body.folder];
          if (!dir) return res.writeHead(400).end();
          const d = body.sub ? path.join(dir, body.sub === "16" ? "16-bit 44.1kHz" : "24-bit 48kHz") : dir;
          if (!fs.existsSync(d)) return res.writeHead(404).end();
          reveal(d, false);
        }
        json(res, { ok: true });
      });
    }
  }
  res.writeHead(404).end();
}

// createServer({demo: true}) for the online copy; without it, --demo or GODMIX_DEMO=1 decide
const createServer = ({ demo = DEMO_ENV } = {}) => http.createServer((req, res) => handle(req, res, demo));
module.exports = { createServer };

if (require.main === module) {
  const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const PORT = +(process.env.GODMIX_PORT || process.env.PORT || args[0] || 8333);
  const OPEN = process.argv.includes("--open");
  const HOST = process.env.GODMIX_HOST || "127.0.0.1";
  // the installed app reads your folders and runs jobs, so it never listens beyond this computer
  if (!DEMO_ENV && !["127.0.0.1", "localhost", "::1"].includes(HOST)) {
    console.error(`GODMIX only runs on this computer (GODMIX_HOST=${HOST} is refused). Only the online demo (--demo) may listen elsewhere.`);
    process.exit(1);
  }
  const url = `http://localhost:${PORT}${DEMO_ENV ? "/" : "/app"}`;
  const openBrowser = () => {
    const [cmd, a] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
    spawn(cmd, a, { detached: true, stdio: "ignore" }).unref();
  };
  const server = createServer();
  server.on("error", e => {
    if (e.code === "EADDRINUSE" && OPEN) { console.log("GODMIX is already running, opening it"); openBrowser(); setTimeout(() => process.exit(0), 500); }
    else if (e.code === "EADDRINUSE") { console.error(`Port ${PORT} is in use. Is GODMIX already running? Try: node app/server.js ${PORT + 1}`); process.exit(1); }
    else { console.error(e.message); process.exit(1); }
  });
  server.listen(PORT, HOST, () => {
    const n = albumList().length;
    console.log(`GODMIX ${VERSION}${DEMO_ENV ? " (online demo: the demo album only, read-only)" : ""}: ${url}`);
    if (!n) console.log("No album data yet. Build it with: python app/build_data.py   (see README.md)");
    if (DEMO_ENV && !fs.existsSync(path.join(PUBLIC, "audio"))) console.log("No MP3 copies for the demo yet, so it streams the FLACs. Make them with: python app/build_public.py");
    if (OPEN) openBrowser();
  });
}
