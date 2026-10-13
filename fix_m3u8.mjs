import { spawnSync, spawn } from "child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  createWriteStream,
  openSync,
} from "fs";
import https from "https";
import http from "http";
import net from "net";
import tls from "tls";
import zlib from "zlib";
import dns from "dns/promises";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// M3U8 -> MP4 downloader with automatic IPv6 fallback (Cloudflare WARP).
//
// Takes a local .m3u8, a .url internet shortcut to one, or a playlist URL.
// Relative segment paths resolve against the playlist's URL; for a local file
// that is the source URL the browser recorded in its Zone.Identifier stream.
// Playlists whose segment URLs mix absolute CDN URLs with relative origin URLs
// work even without it: relative segments are rebuilt from the absolute CDN
// template by their index.
//
// Handles MPEG-TS and fMP4/CMAF playlists, including #EXT-X-MAP init sections
// and #EXT-X-BYTERANGE segments that are slices of a single file. Each segment
// is fetched with retries; failures are reported, not fatal. Segments are
// joined and remuxed to MP4 with ffmpeg. (Remuxing the joined file avoids
// ffmpeg's HLS reader, which shifts audio out of sync when fMP4 segments are
// longer than 10 s.)
//
// Some CDNs (e.g. *.ahcdn.com) are reachable ONLY over IPv6. If this machine
// has no IPv6 route, the tool transparently spins up a userspace Cloudflare
// WARP tunnel (wgcf + wireproxy, no admin / no driver install) and routes the
// download through it. Pass --no-warp to disable, or --socks host:port to use
// an existing proxy.
// ---------------------------------------------------------------------------

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CONCURRENCY = 6;
const MAX_RETRIES = 4;
const SOCKS_PORT = 25344;

// Pinned tool versions (tested working).
const WGCF_URL =
  "https://github.com/ViRb3/wgcf/releases/download/v2.2.31/wgcf_2.2.31_windows_amd64.exe";
const WIREPROXY_URL =
  "https://github.com/windtf/wireproxy/releases/download/v1.1.2/wireproxy_windows_amd64.tar.gz";

const TOOLS_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), "m3u8dl");

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
let input = null;
let socksOverride = null;
let allowWarp = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--no-warp") allowWarp = false;
  else if (a === "--socks") socksOverride = argv[++i];
  else if (!a.startsWith("--")) input = a;
}
if (!input) {
  console.error(
    "Usage: node fix_m3u8.mjs <file.m3u8 | shortcut.url | playlist URL> [--socks host:port] [--no-warp]"
  );
  process.exit(1);
}

// --- input ------------------------------------------------------------------
const isAbsolute = (u) => /^https?:\/\//i.test(u);

let playlistUrl = null; // relative segment paths resolve against this
let localText = null; // contents of a local .m3u8; otherwise fetched from playlistUrl
if (isAbsolute(input)) {
  playlistUrl = input;
} else if (/\.url$/i.test(input)) {
  playlistUrl = (readFileSync(input, "utf8").match(/^URL=(https?:\/\/.+)$/im) || [])[1];
  if (!playlistUrl) {
    console.error(`No http(s) URL found in shortcut: ${input}`);
    process.exit(1);
  }
  playlistUrl = playlistUrl.trim();
} else {
  localText = readFileSync(input, "utf8");
  try {
    const zone = readFileSync(input + ":Zone.Identifier", "utf8");
    playlistUrl = (zone.match(/^HostUrl=(https?:\/\/\S+)/im) || [])[1] || null;
  } catch {}
}

// ---------------------------------------------------------------------------
// Parse playlist
// ---------------------------------------------------------------------------

// Value of `name` in an attribute list such as: URI="init.mp4",BYTERANGE="720@0"
function attr(list, name) {
  const m = list.match(new RegExp(`(?:^|,)\\s*${name}=("[^"]*"|[^,]*)`, "i"));
  return m ? m[1].replace(/^"|"$/g, "") : null;
}

// "<length>[@<offset>]" -> inclusive { start, end }. Without an offset the
// range starts at `nextOffset`.
function parseByteRange(spec, nextOffset) {
  const [len, off] = spec.split("@");
  const start = off === undefined ? nextOffset : Number(off);
  return { start, end: start + Number(len) - 1 };
}

// -> [{ uri, range, map }] in playback order, where `map` is the #EXT-X-MAP
// init section ({ uri, range }) that applies to the segment, if any.
function parsePlaylist(text) {
  const segs = [];
  const nextOffset = new Map(); // uri -> first byte after its previous range
  let map = null;
  let rangeSpec = null;
  for (const line of text.split(/\r?\n/).map((l) => l.trim())) {
    if (!line) continue;
    const tag = line.match(/^#(EXT-X-MAP|EXT-X-BYTERANGE):(.*)$/i);
    if (tag && tag[1].toUpperCase() === "EXT-X-MAP") {
      const br = attr(tag[2], "BYTERANGE");
      map = { uri: attr(tag[2], "URI"), range: br ? parseByteRange(br, 0) : null };
    } else if (tag) {
      rangeSpec = tag[2].trim();
    }
    if (line.startsWith("#")) continue;
    let range = null;
    if (rangeSpec) {
      range = parseByteRange(rangeSpec, nextOffset.get(line) ?? 0);
      nextOffset.set(line, range.end + 1);
      rangeSpec = null;
    }
    segs.push({ uri: line, range, map });
  }
  return segs;
}

const SEG_RE = /seg-(\d+)(-v\d+-a\d+\.ts)$/i;
const segIndex = (u) => (u.match(SEG_RE) || [])[1] || null;

// Turns segments into download jobs in file order (an init section goes right
// before the first segment that uses it), each with candidate URLs, best first.
function planJobs(segs) {
  const firstAbsolute = segs.map((s) => s.uri).find(isAbsolute);
  const base = firstAbsolute ? firstAbsolute.match(/^(https?:\/\/[^/]+)/i)[1] : null;
  const tmatch = firstAbsolute && firstAbsolute.match(SEG_RE);
  const template = tmatch
    ? { prefix: firstAbsolute.slice(0, tmatch.index) + "seg-", suffix: tmatch[2] }
    : null;

  const candidatesFor = (u) => {
    const idx = segIndex(u);
    const fromTemplate = template && idx ? template.prefix + idx + template.suffix : null;
    const list = [];
    if (isAbsolute(u)) list.push(u);
    else {
      if (playlistUrl) list.push(new URL(u, playlistUrl).href);
      if (fromTemplate) list.push(fromTemplate);
      if (base) list.push(base + (u.startsWith("/") ? u : "/" + u));
    }
    if (fromTemplate) list.push(fromTemplate);
    return [...new Set(list)];
  };

  const jobs = [];
  let lastMapKey = null;
  segs.forEach((s, n) => {
    const mapKey = s.map && `${s.map.uri}|${s.map.range?.start}`;
    if (mapKey && mapKey !== lastMapKey)
      jobs.push({ isInit: true, candidates: candidatesFor(s.map.uri), range: s.map.range });
    lastMapKey = mapKey;
    jobs.push({ num: segIndex(s.uri) ?? n, candidates: candidatesFor(s.uri), range: s.range });
  });
  return { jobs, base };
}

// ---------------------------------------------------------------------------
// SOCKS5 plumbing (used when routing through the WARP tunnel)
// ---------------------------------------------------------------------------

function ipv6ToBytes(addr) {
  addr = addr.split("%")[0];
  const dbl = addr.split("::");
  const grp = (s) => (s ? s.split(":").filter((x) => x !== "").map((h) => parseInt(h, 16)) : []);
  let groups;
  if (dbl.length === 2) {
    const head = grp(dbl[0]);
    const tail = grp(dbl[1]);
    groups = [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
  } else {
    groups = grp(addr);
  }
  const b = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) b.writeUInt16BE(groups[i] || 0, i * 2);
  return b;
}

function socks5Connect(proxyHost, proxyPort, destHost, destPort, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, proxyHost);
    let buf = Buffer.alloc(0);
    let stage = 0;
    const fail = (e) => {
      sock.destroy();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    sock.once("error", fail);
    sock.setTimeout(timeoutMs, () => fail(new Error("SOCKS timeout")));
    sock.once("connect", () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error("SOCKS handshake failed"));
        buf = buf.slice(2);
        stage = 1;
        let addrPart;
        if (net.isIPv6(destHost)) {
          addrPart = Buffer.concat([Buffer.from([0x04]), ipv6ToBytes(destHost)]);
        } else if (net.isIPv4(destHost)) {
          addrPart = Buffer.concat([Buffer.from([0x01]), Buffer.from(destHost.split(".").map(Number))]);
        } else {
          const hb = Buffer.from(destHost, "utf8");
          addrPart = Buffer.concat([Buffer.from([0x03, hb.length]), hb]);
        }
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00]),
          addrPart,
          Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff]),
        ]);
        sock.write(req);
        return;
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        if (buf[1] !== 0x00) return fail(new Error("SOCKS connect rejected (code " + buf[1] + ")"));
        const atyp = buf[3];
        const need = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : 4 + 1 + buf[4] + 2;
        if (buf.length < need) return;
        sock.removeListener("error", fail);
        sock.setTimeout(0);
        sock.removeAllListeners("data");
        resolve(sock);
      }
    });
  });
}

class SocksHttpsAgent extends https.Agent {
  constructor(proxy, opts = {}) {
    const { connectTimeout = 30000, ...rest } = opts;
    super(rest);
    this.proxy = proxy;
    this.connectTimeout = connectTimeout;
  }
  createConnection(options, cb) {
    let settled = false;
    const done = (err, sock) => {
      if (settled) return;
      settled = true;
      cb(err, sock);
    };
    socks5Connect(
      this.proxy.host,
      this.proxy.port,
      options.host,
      Number(options.port) || 443,
      this.connectTimeout
    )
      .then((raw) => {
        const tlsSock = tls.connect({
          socket: raw,
          servername: options.host,
          ALPNProtocols: ["http/1.1"],
        });
        const t = setTimeout(() => {
          tlsSock.destroy();
          done(new Error("TLS handshake timeout"));
        }, this.connectTimeout);
        tlsSock.once("error", (e) => { clearTimeout(t); done(e); });
        tlsSock.once("secureConnect", () => { clearTimeout(t); done(null, tlsSock); });
      })
      .catch(done);
  }
}

let httpsAgent; // set once proxy decided
let proxyObj = null;
const makeAgent = (connectTimeout) =>
  new SocksHttpsAgent(proxyObj, { keepAlive: true, maxSockets: CONCURRENCY, connectTimeout });

// `range` ({ start, end }, inclusive) fetches just that slice of the file.
function fetchBuffer(url, redirectsLeft = 5, timeoutMs = 30000, range = null) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https");
    const mod = isHttps ? https : http;
    const reqHeaders = { "User-Agent": UA, Accept: "*/*" };
    if (range) reqHeaders.Range = `bytes=${range.start}-${range.end}`;
    const opts = { headers: reqHeaders, timeout: timeoutMs };
    if (isHttps && httpsAgent) opts.agent = httpsAgent;
    const req = mod.get(url, opts, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error("too many redirects"));
        return resolve(
          fetchBuffer(new URL(headers.location, url).toString(), redirectsLeft - 1, timeoutMs, range)
        );
      }
      if (statusCode !== 200 && !(range && statusCode === 206)) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const want = range && range.end - range.start + 1;
        if (range && buf.length !== want)
          return reject(
            new Error(statusCode === 206 ? `got ${buf.length} of ${want} bytes` : "server ignored the byte range")
          );
        resolve(buf);
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function downloadSegment(seg) {
  let lastErr;
  for (const url of seg.candidates) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const buf = await fetchBuffer(url, 5, 30000, seg.range);
        if (buf.length === 0) throw new Error("empty body");
        return buf;
      } catch (e) {
        lastErr = e;
        if (/HTTP 40[34]/.test(e.message)) break;
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }
  throw lastErr;
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function spawnWorker() {
    const i = next++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    done++;
    if (done % 10 === 0 || done === items.length)
      process.stdout.write(`\r  downloaded ${done}/${items.length}   `);
    return spawnWorker();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, spawnWorker));
  process.stdout.write("\n");
  return results;
}

// ---------------------------------------------------------------------------
// Connectivity probe + WARP tunnel bring-up
// ---------------------------------------------------------------------------
const directHosts = new Set();

// Makes sure `url`'s host can be reached: runs `probe` directly, and if that
// fails brings up the WARP tunnel, which all later requests then go through.
// Returns the probe's result if it succeeded directly, otherwise null.
async function ensureReachable(url, probe) {
  const host = new URL(url).hostname;
  if (proxyObj || directHosts.has(host)) return null;
  const a = await dns.resolve4(host).catch(() => []);
  const aaaa = await dns.resolve6(host).catch(() => []);
  console.log(`Host ${host}: IPv4=${a.length ? a.join(",") : "none"}  IPv6=${aaaa.length ? aaaa.join(",") : "none"}`);
  process.stdout.write("Checking direct connectivity... ");
  try {
    const result = await probe();
    console.log("OK");
    directHosts.add(host);
    return result;
  } catch {
    console.log("unreachable");
  }
  if (!allowWarp) fail("\nCDN unreachable directly and --no-warp set. Aborting.");
  console.log("Bringing up IPv6 via userspace Cloudflare WARP (no admin needed):");
  warpChild = await startWarp();
  console.log("  tunnel ready.");
  return null;
}

function dlToFile(url, dest) {
  return fetchBuffer(url).then((buf) => writeFileSync(dest, buf));
}

function isPortOpen(host, port, timeout = 1000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

// Extract a single file (by name suffix) from a .tar.gz buffer — no external
// `tar` dependency (Windows `spawn` won't resolve it without a shell).
function extractFromTarGz(gzBuf, nameSuffix, dest) {
  const tar = zlib.gunzipSync(gzBuf);
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.slice(off, off + 512);
    const name = header.slice(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (name === "") break; // end-of-archive zero block
    const size = parseInt(header.slice(124, 136).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0;
    const dataStart = off + 512;
    if (name.endsWith(nameSuffix)) {
      writeFileSync(dest, tar.slice(dataStart, dataStart + size));
      return true;
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return false;
}

// Probe a neutral always-200 endpoint through the tunnel — this confirms the
// tunnel passes data without depending on the (possibly rate-limited) CDN link.
const READY_PROBE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
async function waitForProxy(proxy, overallMs = 90000) {
  proxyObj = proxy;
  httpsAgent = makeAgent(8000); // short connect timeout while the tunnel warms up
  const start = Date.now();
  while (Date.now() - start < overallMs) {
    try {
      await fetchBuffer(READY_PROBE_URL, 5, 8000);
      httpsAgent = makeAgent(30000); // switch to production timeouts for the real download
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw new Error("tunnel did not become ready in time");
}

async function startWarp() {
  const WGCF = path.join(TOOLS_DIR, "wgcf.exe");
  const WIREPROXY = path.join(TOOLS_DIR, "wireproxy.exe");
  const PROFILE = path.join(TOOLS_DIR, "wgcf-profile.conf");
  const ACCOUNT = path.join(TOOLS_DIR, "wgcf-account.toml");
  const WP_CONF = path.join(TOOLS_DIR, "wireproxy.conf");

  let child = null;
  if (await isPortOpen("127.0.0.1", SOCKS_PORT)) {
    console.log(`  reusing tunnel already running on 127.0.0.1:${SOCKS_PORT}`);
  } else {
    mkdirSync(TOOLS_DIR, { recursive: true });
    httpsAgent = undefined; // tool downloads go direct (GitHub is IPv4)

    if (!existsSync(WGCF)) {
      console.log("  fetching wgcf...");
      await dlToFile(WGCF_URL, WGCF);
    }
    if (!existsSync(WIREPROXY)) {
      console.log("  fetching wireproxy...");
      const tgzBuf = await fetchBuffer(WIREPROXY_URL);
      if (!extractFromTarGz(tgzBuf, "wireproxy.exe", WIREPROXY))
        throw new Error("wireproxy.exe not found in archive");
    }
    if (!existsSync(ACCOUNT)) {
      console.log("  registering Cloudflare WARP account...");
      const r = spawnSync(WGCF, ["register", "--accept-tos"], { cwd: TOOLS_DIR, stdio: "ignore" });
      if (r.status !== 0) throw new Error("wgcf register failed");
    }
    if (!existsSync(PROFILE)) {
      const r = spawnSync(WGCF, ["generate"], { cwd: TOOLS_DIR, stdio: "ignore" });
      if (r.status !== 0) throw new Error("wgcf generate failed");
    }
    writeFileSync(
      WP_CONF,
      `WGConfig = ${PROFILE}\n\n[Socks5]\nBindAddress = 127.0.0.1:${SOCKS_PORT}\n`
    );

    console.log("  starting userspace WARP tunnel...");
    const logPath = path.join(TOOLS_DIR, "wireproxy.log");
    const logFd = openSync(logPath, "w");
    child = spawn(WIREPROXY, ["-c", WP_CONF], {
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      cwd: TOOLS_DIR,
    });
    let exitedEarly = false;
    child.on("exit", (code) => { exitedEarly = code; });
    // Give it a moment; if it dies immediately, surface the log.
    await new Promise((r) => setTimeout(r, 500));
    if (exitedEarly !== false) {
      let log = "";
      try { log = readFileSync(logPath, "utf8").trim().split("\n").slice(-5).join("\n"); } catch {}
      throw new Error(`wireproxy exited immediately (code ${exitedEarly}).\n${log}`);
    }
  }
  await waitForProxy({ host: "127.0.0.1", port: SOCKS_PORT });
  return child;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// The MP4 is named after the playlist and saved next to the input file (or in
// the current directory when given a URL).
function urlFileName(u) {
  let name = new URL(u).pathname.split("/").pop() || "video";
  try { name = decodeURIComponent(name); } catch {}
  return name.replace(/[<>:"/\\|?*]/g, "_");
}
const stem = (localText === null ? urlFileName(playlistUrl) : path.basename(input)).replace(/\.m3u8$/i, "");
const outDir = isAbsolute(input) ? process.cwd() : path.dirname(path.resolve(input));
const finalOut = path.join(outDir, /\.mp4$/i.test(stem) ? stem : stem + ".mp4");
const tmpDir = path.join(os.tmpdir(), `m3u8dl_${stem}_${process.pid}`);

let warpChild = null;
const cleanup = () => {
  try { if (warpChild) warpChild.kill(); } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
};
const fail = (...lines) => {
  for (const line of lines) console.error(line);
  cleanup();
  process.exit(1);
};

(async () => {
  console.log(`Playlist: ${localText === null ? playlistUrl : input}`);
  if (localText !== null && playlistUrl) console.log(`Source:   ${playlistUrl}`);

  if (socksOverride) {
    const [h, p] = socksOverride.split(":");
    proxyObj = { host: h, port: Number(p) };
    httpsAgent = makeAgent(30000);
    console.log(`Using SOCKS proxy ${socksOverride}`);
  }

  let text = localText;
  if (text === null) {
    const buf =
      (await ensureReachable(playlistUrl, () => fetchBuffer(playlistUrl))) ||
      (await fetchBuffer(playlistUrl));
    text = buf.toString("utf8");
    if (!/^\s*#EXTM3U/.test(text)) fail(`\nNot an M3U8 playlist: ${playlistUrl}`);
  }

  if (/^#EXT-X-STREAM-INF/im.test(text)) {
    const variants = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    fail(
      "\nThis is a master playlist (a list of quality variants), not a video playlist.",
      "Convert one of its variants instead:",
      ...variants.map((v) => "  " + (playlistUrl ? new URL(v, playlistUrl).href : v))
    );
  }

  const segs = parsePlaylist(text);
  if (segs.length === 0) fail("No segment URLs found in the playlist.");
  const { jobs, base } = planJobs(segs);
  const relCount = segs.filter((s) => !isAbsolute(s.uri)).length;
  if (relCount && !base && !playlistUrl)
    fail(
      "\nThe playlist's segment paths are relative, and the URL it came from is unknown.",
      "Right-click an internet shortcut (.url) to the playlist instead, or run:",
      '  node fix_m3u8.mjs "<playlist URL>"'
    );
  const isFmp4 = jobs.some((j) => j.isInit);
  const ranged = segs.some((s) => s.range) ? ", byte ranges" : "";
  console.log(`Segments: ${segs.length}  (${isFmp4 ? "fMP4" : "MPEG-TS"}${ranged}; relative paths: ${relCount})`);
  if (base) console.log(`Base URL: ${base}`);

  // Decide how to reach the segment host.
  const first = jobs[0];
  await ensureReachable(first.candidates[0], () =>
    fetchBuffer(first.candidates[0], 5, 30000, first.range)
  );

  mkdirSync(tmpDir, { recursive: true });
  console.log("Downloading segments...");
  const failures = [];
  const buffers = await runPool(
    jobs,
    async (job) => {
      try {
        return await downloadSegment(job);
      } catch (e) {
        failures.push({ job, err: e.message });
        return null;
      }
    },
    CONCURRENCY
  );

  const segFailures = failures.filter((f) => !f.job.isInit);
  const ok = segs.length - segFailures.length;
  console.log(`Segments downloaded: ${ok}/${segs.length}`);
  if (ok === 0) {
    console.error("\nAll segments failed to download.");
    if (failures[0] && /HTTP 40[13]/.test(failures[0].err)) {
      console.error("The signed link was rejected (HTTP 403/401). These URLs are");
      console.error("time- and access-limited (note end=<timestamp> and limit=N in the URL):");
      console.error("  - it may have expired, or");
      console.error("  - the access/IP limit was exhausted (e.g. fetched from too many IPs).");
      console.error("Re-grab a fresh .m3u8 from the site and download it promptly.");
    } else {
      console.error("The signed URLs may have expired (check end=<timestamp> in the URL).");
    }
    if (failures[0]) console.error(`First error: ${failures[0].err}`);
    cleanup();
    process.exit(1);
  }
  const initFailure = failures.find((f) => f.job.isInit);
  if (initFailure) fail(`\nCould not download the fMP4 init section: ${initFailure.err}`);
  if (segFailures.length) {
    console.warn(`WARNING: ${segFailures.length} segment(s) failed and will be skipped:`);
    for (const f of segFailures.slice(0, 8)) console.warn(`  seg #${f.job.num} -> ${f.err}`);
    if (segFailures.length > 8) console.warn(`  ...and ${segFailures.length - 8} more`);
  }

  const joined = path.join(tmpDir, isFmp4 ? "all.mp4" : "all.ts");
  const out = createWriteStream(joined);
  for (const buf of buffers) if (buf) out.write(buf);
  await new Promise((r) => out.end(r));

  console.log(`Remuxing to ${finalOut} ...`);
  const remuxArgs = isFmp4 ? ["-movflags", "+faststart"] : ["-bsf:a", "aac_adtstoasc"];
  const result = spawnSync("ffmpeg", ["-y", "-i", joined, "-c", "copy", ...remuxArgs, finalOut], {
    stdio: "inherit",
  });

  cleanup();
  if (result.status === 0) {
    console.log(`\nDone! Saved as: ${finalOut}`);
    if (segFailures.length)
      console.log(`(Note: ${segFailures.length} segment(s) missing — video may have small gaps.)`);
  } else {
    console.error("\nffmpeg failed. See output above.");
    process.exit(1);
  }
})().catch((e) => {
  console.error("Error:", e.message || e);
  cleanup();
  process.exit(1);
});

process.on("SIGINT", () => { cleanup(); process.exit(130); });
