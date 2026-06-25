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
// Handles playlists whose segment URLs mix absolute CDN URLs with relative
// origin URLs: relative segments are rebuilt from the absolute CDN template by
// their index. Each segment is fetched with retries; failures are reported,
// not fatal. Segments are concatenated and remuxed to MP4 with ffmpeg.
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
let file = null;
let socksOverride = null;
let allowWarp = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--no-warp") allowWarp = false;
  else if (a === "--socks") socksOverride = argv[++i];
  else if (!a.startsWith("--")) file = a;
}
if (!file) {
  console.error("Usage: node fix_m3u8.mjs <file.m3u8> [--socks host:port] [--no-warp]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse playlist
// ---------------------------------------------------------------------------
const content = readFileSync(file, "utf8");
const rawSegs = content
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
if (rawSegs.length === 0) {
  console.error("No segment URLs found in the playlist.");
  process.exit(1);
}

const firstAbsolute = rawSegs.find((u) => /^https?:\/\//i.test(u));
if (!firstAbsolute) {
  console.error("Could not find any absolute URL in the m3u8 to derive a base from.");
  process.exit(1);
}
const base = firstAbsolute.match(/^(https?:\/\/[^/]+)/i)[1];
const baseHost = new URL(base).hostname;

const SEG_RE = /seg-(\d+)(-v\d+-a\d+\.ts)$/i;
let template = null;
const tmatch = firstAbsolute.match(SEG_RE);
if (tmatch) {
  template = {
    prefix: firstAbsolute.slice(0, tmatch.index) + "seg-",
    suffix: tmatch[2],
  };
}
const segIndex = (u) => (u.match(SEG_RE) || [])[1] || null;

const segments = rawSegs.map((u) => {
  const idx = segIndex(u);
  const candidates = [];
  if (/^https?:\/\//i.test(u)) candidates.push(u);
  else {
    if (template && idx) candidates.push(template.prefix + idx + template.suffix);
    candidates.push(base + (u.startsWith("/") ? u : "/" + u));
  }
  if (template && idx) {
    const t = template.prefix + idx + template.suffix;
    if (!candidates.includes(t)) candidates.push(t);
  }
  return { idx, candidates };
});

const relCount = rawSegs.filter((u) => !/^https?:\/\//i.test(u)).length;

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

function fetchBuffer(url, redirectsLeft = 5, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https");
    const mod = isHttps ? https : http;
    const opts = { headers: { "User-Agent": UA, Accept: "*/*" }, timeout: timeoutMs };
    if (isHttps && httpsAgent) opts.agent = httpsAgent;
    const req = mod.get(url, opts, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error("too many redirects"));
        return resolve(fetchBuffer(new URL(headers.location, url).toString(), redirectsLeft - 1, timeoutMs));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
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
        const buf = await fetchBuffer(url);
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
      process.stdout.write(`\r  downloaded ${done}/${items.length} segments   `);
    return spawnWorker();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, spawnWorker));
  process.stdout.write("\n");
  return results;
}

// ---------------------------------------------------------------------------
// Connectivity probe + WARP tunnel bring-up
// ---------------------------------------------------------------------------
async function canReachDirect() {
  try {
    await fetchBuffer(segments[0].candidates[0]);
    return true;
  } catch {
    return false;
  }
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
const outName = path.basename(file).replace(/\.m3u8$/i, "");
const finalOut = /\.mp4$/i.test(outName) ? outName : outName + ".mp4";
const tmpDir = path.join(os.tmpdir(), `m3u8dl_${path.basename(file)}_${process.pid}`);

let warpChild = null;
const cleanup = () => {
  try { if (warpChild) warpChild.kill(); } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
};

(async () => {
  console.log(`Playlist: ${file}`);
  console.log(`Segments: ${segments.length}  (relative rebuilt from template: ${relCount})`);
  console.log(`Base URL: ${base}`);

  // Decide how to reach the CDN.
  if (socksOverride) {
    const [h, p] = socksOverride.split(":");
    proxyObj = { host: h, port: Number(p) };
    httpsAgent = makeAgent(30000);
    console.log(`Using SOCKS proxy ${socksOverride}`);
  } else {
    const a = await dns.resolve4(baseHost).catch(() => []);
    const aaaa = await dns.resolve6(baseHost).catch(() => []);
    console.log(`Host ${baseHost}: IPv4=${a.length ? a.join(",") : "none"}  IPv6=${aaaa.length ? aaaa.join(",") : "none"}`);
    process.stdout.write("Checking direct connectivity... ");
    const direct = await canReachDirect();
    console.log(direct ? "OK" : "unreachable");
    if (!direct) {
      if (!allowWarp) {
        console.error("\nCDN unreachable directly and --no-warp set. Aborting.");
        process.exit(1);
      }
      console.log("Bringing up IPv6 via userspace Cloudflare WARP (no admin needed):");
      warpChild = await startWarp();
      console.log("  tunnel ready.");
    }
  }

  mkdirSync(tmpDir, { recursive: true });
  console.log("Downloading segments...");
  const failures = [];
  const buffers = await runPool(
    segments,
    async (seg, i) => {
      try {
        return await downloadSegment(seg);
      } catch (e) {
        failures.push({ i, idx: seg.idx, err: e.message });
        return null;
      }
    },
    CONCURRENCY
  );

  const ok = buffers.filter(Boolean).length;
  console.log(`Segments downloaded: ${ok}/${segments.length}`);
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
  if (failures.length) {
    console.warn(`WARNING: ${failures.length} segment(s) failed and will be skipped:`);
    for (const f of failures.slice(0, 8)) console.warn(`  seg #${f.idx ?? f.i} -> ${f.err}`);
    if (failures.length > 8) console.warn(`  ...and ${failures.length - 8} more`);
  }

  const concatTs = path.join(tmpDir, "all.ts");
  const out = createWriteStream(concatTs);
  for (const buf of buffers) if (buf) out.write(buf);
  await new Promise((r) => out.end(r));

  console.log(`Remuxing to ${finalOut} ...`);
  const result = spawnSync(
    "ffmpeg",
    ["-y", "-i", concatTs, "-c", "copy", "-bsf:a", "aac_adtstoasc", finalOut],
    { stdio: "inherit" }
  );

  cleanup();
  if (result.status === 0) {
    console.log(`\nDone! Saved as: ${finalOut}`);
    if (failures.length)
      console.log(`(Note: ${failures.length} segment(s) missing — video may have small gaps.)`);
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
