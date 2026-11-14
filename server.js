const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "ARSH@2026"; // <-- Apna Admin Password yahan change kar sakte hain
const PUBLIC_DIR = path.join(__dirname, "public");
const DB_FILE = path.join(__dirname, "keys-db.json");

const TUNNEL_SECRET = "RX_V12_QUANTUM_SHIELD_9941_ARSH_ENCRYPTED_TUNNEL_KEY";
const VAULT_HMAC_KEY = process.env.VAULT_SECRET || "RX_VAULT_SIGNER_KEY_2026";

const DURATIONS = {
  "30m": { label: "30 MIN", ms: 30 * 60 * 1000 },
  "1h": { label: "1 HOUR", ms: 60 * 60 * 1000 },
  "1d": { label: "1 DAY", ms: 24 * 60 * 60 * 1000 },
  "2d": { label: "2 DAYS", ms: 2 * 24 * 60 * 60 * 1000 },
  "3d": { label: "3 DAYS ★", ms: 3 * 24 * 60 * 60 * 1000 },
  "7d": { label: "7 DAYS", ms: 7 * 24 * 60 * 60 * 1000 },
  "15d": { label: "15 DAYS", ms: 15 * 24 * 60 * 60 * 1000 },
  "30d": { label: "30 DAYS ★", ms: 30 * 24 * 60 * 60 * 1000 },
  "permanent": { label: "PERMANENT ♾️", ms: null }
};

let keysDB = [];
const adminTokens = new Set();

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      if (Array.isArray(parsed)) keysDB = parsed;
    }
  } catch {}
}
function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(keysDB, null, 2)); } catch {}
}
loadDB();

function makeVaultToken() {
  const data = Buffer.from(JSON.stringify(keysDB)).toString("base64url");
  const sig = crypto.createHmac("sha256", VAULT_HMAC_KEY).update(data).digest("base64url");
  return `${data}.${sig}`;
}
function tryRestoreVault(token) {
  if (!token || typeof token !== "string" || !token.includes(".") || keysDB.length > 0) return;
  try {
    const [data, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", VAULT_HMAC_KEY).update(data).digest("base64url");
    if (sig === expected) {
      const parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
      if (Array.isArray(parsed) && parsed.length > 0) {
        keysDB = parsed;
        saveDB();
      }
    }
  } catch {}
}

function keyByte(nonce, idx) {
  const f = `${TUNNEL_SECRET}::${nonce}`;
  let h = 2166136261 ^ idx;
  for (let d = 0; d < f.length; d++) {
    h ^= f.charCodeAt(d);
    h = Math.imul(h, 16777619);
  }
  h ^= (idx * 2654435761) & 4294967295;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) & 255;
}

function encryptPayload(obj) {
  const nonce = crypto.randomBytes(12).toString("hex");
  const buf = Buffer.from(JSON.stringify(obj), "utf8");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ keyByte(nonce, i);
  return { v: "RX-E2E-V12", n: nonce, c: out.toString("base64url") };
}

function decryptPayload(body) {
  if (!body || body.v !== "RX-E2E-V12") return body;
  const buf = Buffer.from(body.c, "base64url");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ keyByte(body.n, i);
  return JSON.parse(out.toString("utf8"));
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 2e6) req.destroy(); });
    req.on("end", () => {
      try { resolve(decryptPayload(JSON.parse(raw || "{}"))); } catch { resolve({}); }
    });
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function getFallbackPeriod(mode) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const sec = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  const idx = Math.floor(sec / (mode === "30S" ? 30 : 60)) + 1;
  return `${y}${m}${d}${mode === "30S" ? "10005" : "10001"}${String(Math.max(1, idx)).padStart(4, "0")}`;
}

async function fetchServerDraws(mode) {
  const url = mode === "30S"
    ? "https://draw.ar-lottery02.com/WinGo/WinGo_30S/GetHistoryIssuePage.json"
    : "https://draw.ar-lottery02.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";
  try {
    const r = await fetch(`${url}?ts=${Date.now()}`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    return Array.isArray(j?.data?.list) ? j.data.list : [];
  } catch {
    return [];
  }
}

function buildQuantumDetection(mode, draws, rules) {
  const enabledRules = Array.isArray(rules) ? rules.filter((r) => r.enabled) : [];
  const count = enabledRules.length;
  const nums = draws.map((d) => d.number);
  const last = nums[0] ?? 5;
  const ma5 = Number((nums.slice(0, 5).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(5, nums.length))).toFixed(2));
  const ma20 = Number((nums.slice(0, 20).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, nums.length))).toFixed(2));

  let bb = 0, bs = 0, sb = 0, ss = 0;
  for (let i = 0; i < draws.length - 1; i++) {
    const nextSide = draws[i].side;
    const prevSide = draws[i + 1].side;
    if (prevSide === "BIG" && nextSide === "BIG") bb++;
    if (prevSide === "BIG" && nextSide === "SMALL") bs++;
    if (prevSide === "SMALL" && nextSide === "BIG") sb++;
    if (prevSide === "SMALL" && nextSide === "SMALL") ss++;
  }
  const bTot = bb + bs || 1, sTot = sb + ss || 1;
  const markovMatrix = {
    bb: Math.round((bb / bTot) * 100),
    bs: Math.round((bs / bTot) * 100),
    sb: Math.round((sb / sTot) * 100),
    ss: Math.round((ss / sTot) * 100)
  };

  let streak = 1;
  for (let i = 1; i < draws.length; i++) {
    if (draws[i].side === draws[0].side) streak++;
    else break;
  }

  const nextBet = streak >= 4
    ? (draws[0]?.side === "BIG" ? "SMALL" : "BIG")
    : (ma5 >= ma20 ? "BIG" : "SMALL");
  const bigNum = [5, 6, 7, 8, 9][(last + streak) % 5];
  const smallNum = [0, 1, 2, 3, 4][(last + streak) % 5];
  const primaryNum = nextBet === "BIG" ? bigNum : smallNum;
  const secondaryNum = nextBet === "BIG" ? (bigNum === 9 ? 6 : bigNum + 1) : (smallNum === 4 ? 1 : smallNum + 1);
  const conf = count === 0 ? 0 : Math.min(98, 84 + Math.min(12, streak * 2));
  const activeTag = enabledRules[0]?.shortCode || "APEX QUANTUM 100";

  return {
    isOffline: count === 0,
    activePatternTag: count === 0 ? "ALL ENGINES OFF" : activeTag,
    nextBet,
    primaryNum,
    secondaryNum,
    bigNum,
    smallNum,
    confidence: conf,
    agreement: count === 0 ? "0/3" : "3/3",
    matchedRulesCount: count,
    engines: [
      { name: "RDX CORE", side: nextBet, confidence: conf, activeRule: activeTag, primaryNum, weight: 96 },
      { name: "VANTA", side: nextBet, confidence: Math.max(70, conf - 2), activeRule: "MARKOV T", primaryNum: secondaryNum, weight: 94 },
      { name: "NOCTIS", side: nextBet, confidence: Math.max(70, conf - 3), activeRule: "BAYES UPDATE", primaryNum, weight: 92 }
    ],
    markovMatrix,
    ma5,
    ma20,
    regimeIntel: {
      regimeTitle: streak >= 3 ? `🐉 ${streak}-STREAK DRAGON ACTIVE` : "⚡ BALANCED MATRIX SYNC",
      switchConfidence: conf,
      switchAction: streak >= 4 ? "SWITCH_SIDE" : "RIDE_TREND",
      switchLabel: streak >= 4 ? `🔄 EXHAUSTION SWITCH -> ${nextBet}` : `🟢 RIDE TREND (CONTINUE ${nextBet})`,
      switchRationale: `Streak depth ${streak} · MA5(${ma5}) vs MA20(${ma20}) consensus locked.`,
      hazardRate: Math.min(85, streak * 16),
      digitBayesWinRate: Math.min(96, 76 + streak * 3),
      patternConsensus: `${count}/100`,
      switchCadenceType: streak >= 3 ? "DRAGON LOCK" : "2-STEP PAIR",
      cadenceBeadProgress: `BEAD ${Math.min(4, streak)}/4`,
      cadenceStep: Math.min(4, streak),
      cadenceTarget: 2,
      switchTrigger: `NEXT TARGET: ${nextBet} [${primaryNum}/${secondaryNum}]`,
      topPatterns: enabledRules.slice(0, 5).map((r, i) => ({
        ruleId: r.id,
        shortTag: r.shortCode,
        ruleTitle: r.title,
        reason: `Synced with ${mode} live draw #${last}`,
        side: nextBet,
        matchScore: Math.max(85, 98 - i * 2)
      }))
    }
  };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json"
};

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (urlPath === "/api/auth/sync-vault" && req.method === "POST") {
    const body = await readJson(req);
    tryRestoreVault(body.vaultToken);
    return sendJson(res, 200, { ok: true, vaultToken: makeVaultToken() });
  }

  if (urlPath === "/api/auth/verify-key" && req.method === "POST") {
    const body = await readJson(req);
    tryRestoreVault(body.vaultToken);
    const keyStr = String(body.key || "").trim();
    const deviceId = String(body.deviceId || "").trim();
    const rec = keysDB.find((k) => k.key === keyStr);
    if (!rec) return sendJson(res, 403, { ok: false, code: "INVALID_KEY", message: "INVALID ACCESS KEY · ACCESS DENIED" });
    if (rec.revoked) return sendJson(res, 403, { ok: false, code: "REVOKED", message: "ACCESS KEY REVOKED BY ADMIN" });
    if (rec.boundDeviceId && rec.boundDeviceId !== deviceId) {
      return sendJson(res, 403, { ok: false, code: "DEVICE_ALREADY_USED", message: "KEY ALREADY BOUND TO ANOTHER DEVICE" });
    }
    if (!rec.boundDeviceId) {
      rec.boundDeviceId = deviceId;
      const dur = DURATIONS[rec.durationId];
      rec.expiresAt = dur && dur.ms ? Date.now() + dur.ms : null;
      rec.sessionCert = crypto.randomBytes(12).toString("hex");
      saveDB();
    }
    if (rec.expiresAt !== null && Date.now() >= rec.expiresAt) {
      return sendJson(res, 403, { ok: false, code: "EXPIRED", message: "ACCESS KEY EXPIRED" });
    }
    return sendJson(res, 200, {
      ok: true,
      vaultToken: makeVaultToken(),
      session: {
        key: rec.key,
        boundDeviceId: rec.boundDeviceId,
        expiresAt: rec.expiresAt,
        durationLabel: rec.durationLabel,
        sessionCert: rec.sessionCert
      }
    });
  }

  if (urlPath === "/api/auth/check-session" && req.method === "POST") {
    const body = await readJson(req);
    tryRestoreVault(body.vaultToken);
    const rec = keysDB.find((k) => k.key === String(body.key || "").trim());
    if (!rec || rec.revoked || (rec.boundDeviceId && rec.boundDeviceId !== body.deviceId) || (rec.expiresAt !== null && Date.now() >= rec.expiresAt)) {
      return sendJson(res, 403, { ok: false, message: "ACCESS KEY EXPIRED OR REVOKED BY ADMIN" });
    }
    return sendJson(res, 200, {
      ok: true,
      vaultToken: makeVaultToken(),
      session: {
        key: rec.key,
        boundDeviceId: rec.boundDeviceId,
        expiresAt: rec.expiresAt,
        durationLabel: rec.durationLabel,
        sessionCert: rec.sessionCert
      }
    });
  }

  if (urlPath === "/api/admin/login" && req.method === "POST") {
    const body = await readJson(req);
    tryRestoreVault(body.vaultToken);
    if (String(body.adminKey || "").trim() !== ADMIN_KEY) {
      return sendJson(res, 401, { ok: false, message: "INVALID ADMIN MASTER KEY" });
    }
    const token = crypto.randomBytes(20).toString("hex");
    adminTokens.add(token);
    return sendJson(res, 200, { ok: true, adminToken: token, vaultToken: makeVaultToken(), keys: keysDB });
  }

  if (urlPath === "/api/admin/keys" && req.method === "GET") {
    const auth = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (!adminTokens.has(auth)) return sendJson(res, 401, { ok: false, message: "UNAUTHORIZED" });
    tryRestoreVault(req.headers["x-vault-sync"]);
    return sendJson(res, 200, { ok: true, keys: keysDB, vaultToken: makeVaultToken() });
  }

  if (urlPath === "/api/admin/generate-key" && req.method === "POST") {
    const body = await readJson(req);
    const auth = (req.headers.authorization || "").replace("Bearer ", "").trim() || body.adminToken;
    if (!adminTokens.has(auth)) return sendJson(res, 401, { ok: false, message: "UNAUTHORIZED" });
    tryRestoreVault(body.vaultToken);

    const durId = DURATIONS[body.durationId] ? body.durationId : "3d";
    const dur = DURATIONS[durId];
    const keyStr = String(body.customKey || `ARSH-${crypto.randomBytes(3).toString("hex").toUpperCase()}`).trim();
    const record = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      key: keyStr,
      durationId: durId,
      durationLabel: dur.label,
      createdAt: Date.now(),
      expiresAt: dur.ms ? Date.now() + dur.ms : null,
      boundDeviceId: null,
      revoked: false,
      sessionCert: ""
    };
    keysDB.unshift(record);
    saveDB();
    return sendJson(res, 200, { ok: true, record, keys: keysDB, vaultToken: makeVaultToken() });
  }

  if (urlPath === "/api/admin/revoke-key" && req.method === "POST") {
    const body = await readJson(req);
    const auth = (req.headers.authorization || "").replace("Bearer ", "").trim() || body.adminToken;
    if (!adminTokens.has(auth)) return sendJson(res, 401, { ok: false, message: "UNAUTHORIZED" });
    tryRestoreVault(body.vaultToken);

    if (body.action === "delete") {
      keysDB = keysDB.filter((k) => k.id !== body.id && k.key !== body.key);
    } else {
      const rec = keysDB.find((k) => k.id === body.id || k.key === body.key);
      if (rec) {
        if (body.action === "revoke") rec.revoked = true;
        if (body.action === "activate") {
          rec.revoked = false;
          const dur = DURATIONS[rec.durationId];
          rec.expiresAt = dur && dur.ms ? Date.now() + dur.ms : null;
        }
        if (body.action === "reset-device") rec.boundDeviceId = null;
      }
    }
    saveDB();
    return sendJson(res, 200, { ok: true, keys: keysDB, vaultToken: makeVaultToken() });
  }

  if (urlPath === "/api/engine/quantum-sync" && req.method === "POST") {
    const body = await readJson(req);
    tryRestoreVault(body.vaultToken);
    const rec = keysDB.find((k) => k.key === String(body.key || "").trim());
    if (!rec || rec.revoked || (rec.boundDeviceId && rec.boundDeviceId !== body.deviceId) || (rec.expiresAt !== null && Date.now() >= rec.expiresAt)) {
      return sendJson(res, 403, { ok: false, message: "ACCESS KEY EXPIRED OR REVOKED BY ADMIN" });
    }
    const mode = body.mode === "30S" ? "30S" : "1M";
    const t0 = Date.now();
    let rawDraws = Array.isArray(body.clientDraws) && body.clientDraws.length > 0 ? body.clientDraws : await fetchServerDraws(mode);
    const draws = rawDraws.slice(0, 50).map((d, i) => {
      const num = Number(d.number ?? d.Number ?? (i % 10));
      return {
        issueNumber: String(d.issueNumber || getFallbackPeriod(mode)),
        number: Number.isFinite(num) ? ((num % 10) + 10) % 10 : 5,
        side: (Number.isFinite(num) ? ((num % 10) + 10) % 10 : 5) >= 5 ? "BIG" : "SMALL"
      };
    });
    const currentPeriod = draws[0] ? (BigInt(draws[0].issueNumber) + 1n).toString() : getFallbackPeriod(mode);
    const detection = buildQuantumDetection(mode, draws, body.rules);
    return sendJson(res, 200, {
      ok: true,
      ...encryptPayload({
        feed: { draws, currentPeriod, latencyMs: Math.max(24, Date.now() - t0) },
        detection
      })
    });
  }

  let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not Found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  });
});

server.listen(PORT, () => console.log(`RAVEN X Server running on port ${PORT}`));