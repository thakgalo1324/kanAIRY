// Kanairy gateway. One public port, ONE shared app key, and up to 10 people.
//   phone --(signed requests)--> gateway --> that person's own server + private MT5 copy
// Each person signs in with a name and PIN, trades their own broker account, and never sees anyone else's.
// Settings live outside this folder (ProgramData\Kanairy), so replacing the vps folder never changes your keys.
// No dependencies. Needs Node 18 or newer.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const HOME = process.env.KANAIRY_HOME || (WIN ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Kanairy') : path.join(os.homedir(), '.kanairy'));
const GW_FILE = path.join(HOME, 'gateway.json'), USERS_FILE = path.join(HOME, 'users.json');
fs.mkdirSync(path.join(HOME, 'users'), { recursive: true });
fs.mkdirSync(path.join(HOME, 'mt5'), { recursive: true });

const rnd = n => crypto.randomBytes(n).toString('hex');
const readJson = f => {
  for (const p of [f, f + '.bak']) { try { const o = JSON.parse(fs.readFileSync(p, 'utf8')); if (o && typeof o === 'object') return o; } catch { /* try the backup */ } }
  return null;
};
// Write to a temp file first, so killing the server mid-write can never wipe the accounts.
const writeJson = (f, o) => {
  const t = f + '.tmp';
  fs.writeFileSync(t, JSON.stringify(o, null, 2), { mode: 0o600 });
  try { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak'); } catch { /* ignore */ }
  fs.renameSync(t, f);
};
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// ---------- shared settings: the one app key and the one EA key ----------
function findMt5Dir() {
  if (!WIN) return process.env.KANAIRY_MT5_SOURCE || '';
  const roots = new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean));
  for (const r of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(r); } catch { continue; }
    for (const d of dirs) if (/meta\s*trader|mt5/i.test(d) && fs.existsSync(path.join(r, d, 'terminal64.exe'))) return path.join(r, d);
  }
  return '';
}
let gw = readJson(GW_FILE);
if (!gw) {
  const legacy = readJson(path.join(DIR, 'config.json')); // keep the key you already put in the app
  gw = { appKey: legacy?.appKey || rnd(16), eaToken: legacy?.eaToken || rnd(12), appPort: legacy?.appPort || 8766, allowLive: !!legacy?.allowLive,
    mt5Source: legacy?.mt5Path ? path.dirname(legacy.mt5Path) : '', maxUsers: 10, workerBase: 9100 };
  writeJson(GW_FILE, gw);
  log(legacy ? 'Kept your existing app key and EA key.' : 'Created your app key and EA key. They stay the same from now on.');
}
let changed = false;
for (const [k, v] of Object.entries({ maxUsers: 10, workerBase: 9100, eaPort: 80 })) if (gw[k] === undefined) { gw[k] = v; changed = true; }
if (!gw.mt5Source || !fs.existsSync(path.join(gw.mt5Source, 'terminal64.exe'))) { const f = findMt5Dir(); if (f) { gw.mt5Source = f; changed = true; } }
if (changed) writeJson(GW_FILE, gw);

// Optional keys file next to this program (kanairy-keys.txt). Fill in a line to choose your own key; leave it empty to keep the current one.
try {
  const kf = path.join(DIR, 'kanairy-keys.txt');
  if (fs.existsSync(kf)) {
    const t = Object.fromEntries(fs.readFileSync(kf, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim().toLowerCase(), l.slice(l.indexOf('=') + 1).trim()]));
    let c = false;
    if (t.eakey && /^[\x21-\x7e]{6,64}$/.test(t.eakey) && t.eakey !== gw.eaToken) { gw.eaToken = t.eakey; c = true; log('EA key set from kanairy-keys.txt'); }
    if (t.appkey && /^[\x21-\x7e]{8,64}$/.test(t.appkey) && t.appkey !== gw.appKey) { gw.appKey = t.appkey; c = true; log('App key set from kanairy-keys.txt'); }
    if (c) writeJson(GW_FILE, gw);
  }
} catch (e) { log('Could not read kanairy-keys.txt: ' + e.message); }

let users = readJson(USERS_FILE) || {};
const saveUsers = () => writeJson(USERS_FILE, users);

// ---------- one worker (the normal Kanairy server) per person ----------
const workers = new Map();
const prep = {}; // name -> 'copying' | 'ready' | 'failed: ...'
const userDir = n => path.join(HOME, 'users', n);
const mt5Dir = n => path.join(HOME, 'mt5', n);
const workerPort = u => gw.workerBase + u.n;
const eaHost = u => '127.0.1.' + u.n;

function writeWorkerCfg(name, u) {
  const dir = userDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'config.json'), cur = readJson(f) || {};
  writeJson(f, { ...cur, appKey: u.workerKey, eaToken: gw.eaToken, appPort: workerPort(u), appHost: '127.0.0.1', eaPort: gw.eaPort, eaHost: eaHost(u),
    mt5Source: gw.mt5Source, mt5Path: path.join(mt5Dir(name), 'terminal64.exe'), mt5DataDir: mt5Dir(name), portable: true, allowLive: !!gw.allowLive, autoLaunch: true, quiet: true });
}

// Private MT5 copy for this person (program files only, no accounts, no charts).
function prepareMt5(name) {
  const dest = mt5Dir(name);
  if (fs.existsSync(path.join(dest, 'terminal64.exe'))) { prep[name] = 'ready'; return; }
  const src = gw.mt5Source;
  if (!src || !fs.existsSync(path.join(src, 'terminal64.exe'))) { prep[name] = 'failed: MetaTrader 5 was not found on the server. Install it once, then restart Kanairy.'; return; }
  prep[name] = 'copying';
  log(`[${name}] copying MT5 for this account…`);
  const done = ok => {
    prep[name] = ok && fs.existsSync(path.join(dest, 'terminal64.exe')) ? 'ready' : 'failed: Could not copy MT5. Check the free disk space and restart.';
    log(`[${name}] MT5 copy ${prep[name]}`);
  };
  if (WIN) {
    const c = spawn('robocopy', [src, dest, '/E', '/XD', 'MQL5', 'Logs', 'Tester', 'bases', 'Profiles', 'config', 'Config', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' });
    c.on('exit', code => done(code !== null && code < 8)); c.on('error', () => done(false));
  } else fs.cp(src, dest, { recursive: true, filter: s => !/(^|[\\/])(MQL5|Logs|bases|Profiles|config)$/.test(s) }, e => done(!e));
}

function startWorker(name) {
  const u = users[name]; if (!u || workers.has(name)) return;
  writeWorkerCfg(name, u);
  const child = spawn(process.execPath, [path.join(DIR, 'server.js')], { cwd: DIR, env: { ...process.env, KANAIRY_HOME: userDir(name) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const w = { child, stopping: false }; workers.set(name, w);
  const pipe = s => { let buf = ''; s.on('data', d => { buf += d; const ls = buf.split(/\r?\n/); buf = ls.pop(); ls.forEach(l => l.trim() && console.log(`  [${name}] ${l.replace(/^\d+:\d+:\d+ [AP]M /, '')}`)); }); };
  pipe(child.stdout); pipe(child.stderr);
  child.on('exit', code => { workers.delete(name); if (!w.stopping && users[name]) { log(`[${name}] engine stopped (${code}). Restarting.`); setTimeout(() => startWorker(name), 3000); } });
}

const psq = x => String(x).replace(/'/g, "''");
function killUserMt5(name, cb) {
  if (!WIN) return cb && cb();
  const exe = path.join(mt5Dir(name), 'terminal64.exe');
  execFile('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -ieq '${psq(exe)}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], () => cb && cb());
}

// ---------- auth ----------
const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
const readBody = (req, max = 3e6) => new Promise((ok, no) => { let n = 0; const ch = []; req.on('data', c => { n += c.length; if (n > max) { no(new Error('too large')); req.destroy(); } else ch.push(c); }); req.on('end', () => ok(Buffer.concat(ch).toString('utf8'))); req.on('error', no); });
const hmac = (key, ts, nonce, method, url, body) => crypto.createHmac('sha256', key).update(`${ts}\n${nonce}\n${method}\n${url}\n${body}`).digest('hex');
const seen = new Map();
function verify(req, body, key) {
  const ts = Number(req.headers['x-ts']), nonce = String(req.headers['x-nonce'] || ''), sig = String(req.headers['x-sig'] || '');
  if (!ts || !nonce || !sig || Math.abs(Date.now() - ts) > 60000) return false;
  const a = Buffer.from(hmac(key, ts, nonce, req.method, req.url, body)), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  if (seen.has(sig)) return false;
  seen.set(sig, ts);
  for (const [k, v] of seen) if (Date.now() - v > 130000) seen.delete(k);
  return true;
}
const fails = new Map(); // name -> { n, until }
const locked = () => false; // never lock anyone out
function failed() { /* a wrong PIN just gets a plain 401, no lockout */ }

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,19}$/;
function allocN() { const used = new Set(Object.values(users).map(u => u.n)); for (let i = 1; i <= 240; i++) if (!used.has(i)) return i; return 0; }

function register(name, userKey) {
  name = String(name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) return { ok: false, error: 'Pick a name with 2 to 20 letters, numbers, - or _.' };
  if (!/^[0-9a-f]{64}$/.test(String(userKey || ''))) return { ok: false, error: 'Bad key.' };
  if (users[name]) return { ok: false, error: 'That name is taken. Use Sign in, or pick another name.' };
  if (Object.keys(users).length >= gw.maxUsers) return { ok: false, error: `This server is full (${gw.maxUsers} accounts).` };
  const n = allocN(); if (!n) return { ok: false, error: 'No free slots.' };
  users[name] = { n, key: userKey, workerKey: rnd(16), created: Date.now() }; saveUsers();
  log(`New account: ${name} (${Object.keys(users).length}/${gw.maxUsers})`);
  prepareMt5(name); startWorker(name);
  return { ok: true, name };
}

function removeUser(name) {
  const w = workers.get(name); if (w) { w.stopping = true; try { w.child.kill(); } catch { /* gone */ } workers.delete(name); }
  killUserMt5(name, () => setTimeout(() => {
    fs.rm(userDir(name), { recursive: true, force: true }, () => {});
    fs.rm(mt5Dir(name), { recursive: true, force: true, maxRetries: 3 }, () => {});
  }, 1500));
  delete users[name]; delete prep[name]; saveUsers(); log(`Account removed: ${name}`);
}

// ---------- forward to the person's own server ----------
function forward(name, req, body) {
  const u = users[name];
  return new Promise(res => {
    const ts = Date.now(), nonce = rnd(6);
    const r = http.request({ host: '127.0.0.1', port: workerPort(u), method: req.method, path: req.url, timeout: 90000,
      headers: { 'X-Ts': String(ts), 'X-Nonce': nonce, 'X-Sig': hmac(u.workerKey, ts, nonce, req.method, req.url, body), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    resp => { const ch = []; resp.on('data', c => ch.push(c)); resp.on('end', () => res({ status: resp.statusCode, text: Buffer.concat(ch).toString('utf8') })); });
    r.on('timeout', () => r.destroy());
    r.on('error', () => res({ status: 503, text: JSON.stringify({ error: 'Your engine is starting. Try again in a few seconds.' }) }));
    r.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const body = await readBody(req);
    const name = String(req.headers['x-user'] || '').trim().toLowerCase();
    if (!name) { // shared-key calls: check the server, create an account
      if (!verify(req, body, gw.appKey)) return send(res, 401, { error: 'unauthorized' });
      if (req.url === '/api/hello') return send(res, 200, { ok: true, users: Object.keys(users).length, max: gw.maxUsers });
      if (req.url === '/api/register') { const j = JSON.parse(body || '{}'); return send(res, 200, register(j.name, j.userKey)); }
      return send(res, 401, { error: 'sign in first' });
    }
    const u = users[name];
    if (!u) return send(res, 401, { error: 'unauthorized' });
    if (locked(name)) return send(res, 429, { error: 'Too many wrong PINs. Try again in a few minutes.' });
    if (!verify(req, body, u.key)) { failed(name); return send(res, 401, { error: 'unauthorized' }); }
    fails.delete(name);
    if (req.url === '/api/me') return send(res, 200, { ok: true, name, prep: prep[name] || 'ready' });
    if (req.url === '/api/account/delete') { removeUser(name); return send(res, 200, { ok: true }); }
    const p = prep[name] || 'ready';
    if (req.url === '/api/launch' && p !== 'ready') return send(res, 200, { ok: false, error: p === 'copying' ? 'Setting up your private MT5. Give it a few minutes, then try again.' : p.replace(/^failed: /, '') });
    const r = await forward(name, req, body);
    if (req.url === '/api/status' && r.status === 200) {
      try {
        const st = JSON.parse(r.text); st.user = name; st.prep = p;
        if (p === 'copying') st.hint = 'Setting up your private MT5 on the server. This takes a few minutes the first time.';
        else if (p !== 'ready') st.hint = p.replace(/^failed: /, '');
        return send(res, 200, st);
      } catch { /* fall through */ }
    }
    res.writeHead(r.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(r.text) }); res.end(r.text);
  } catch (e) { send(res, 400, { error: String(e.message || e) }); }
});
server.on('error', e => { console.log(e.code === 'EADDRINUSE' ? `\n  Port ${gw.appPort} is already in use. Close any old "Kanairy server" window, then start again.\n` : 'Gateway error: ' + e.message); process.exit(1); });

async function banner() {
  let ip = '';
  try { ip = (await (await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(4000) })).text()).trim(); } catch { /* offline */ }
  console.log('\n  Kanairy is running.');
  console.log(`  Phone address:  http://${ip || '<your VPS public IP>'}:${gw.appPort}`);
  console.log(`  App key:        ${gw.appKey}   (the same for everyone, and it never changes)`);
  console.log(`  Accounts:       ${Object.keys(users).length} of ${gw.maxUsers}`);
  console.log(`  Settings are kept in ${HOME}`);
  console.log(`\n  Also open TCP port ${gw.appPort} in your VPS provider's firewall (security group).\n`);
}

server.listen(gw.appPort, '0.0.0.0', () => {
  log(`Gateway on port ${gw.appPort}`);
  for (const name of Object.keys(users)) { prepareMt5(name); startWorker(name); }
  banner();
});
process.on('SIGINT', () => { for (const w of workers.values()) { w.stopping = true; try { w.child.kill(); } catch { /* gone */ } } process.exit(0); });
