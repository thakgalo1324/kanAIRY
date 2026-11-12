// Kanairy doctor: checks every link between your phone, this server and MT5, and fixes what it can.
//   node doctor.js          check only
//   node doctor.js --fix    check and repair (run as Administrator)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { patchSection } from './mt5ini.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIX = process.argv.includes('--fix');
const WIN = process.platform === 'win32';
const run = (cmd, args) => new Promise(ok => execFile(cmd, args, { windowsHide: true, maxBuffer: 8e6 }, (e, out, err) => ok({ e, out: String(out || ''), err: String(err || '') })));
const lines = [];
const say = (tag, msg) => { const l = (tag + '    ').slice(0, 5) + ' ' + msg; lines.push(l); console.log(l); };
const ok = m => say('OK', m), bad = m => say('FAIL', m), fixed = m => say('FIXED', m), info = m => say('INFO', m);
let problems = 0, needRelaunch = false;
const fail = m => { problems++; bad(m); };

let cfg;
try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')); }
catch { console.log('FAIL  config.json is missing. The doctor checks the single-account layout. With multiple accounts, settings live in ProgramData\Kanairy and each person has their own folder under users.'); process.exit(1); }

if (!cfg.eaPort || Number(cfg.eaPort) === 8765) {
  // MetaTrader's WebRequest only reaches the standard web ports, so the EA bridge must be on port 80.
  if (FIX) { cfg.eaPort = 80; fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify(cfg, null, 2)); console.log('FIXED config.json now uses port 80 for the EA bridge (MT5 cannot use other ports). Restart Kanairy server.'); }
  else { console.log('FAIL  config.json still uses EA port 8765, which MT5 cannot reach. Run fix-everything.bat, then restart Kanairy server.'); }
}
const eaUrl = 'http://127.0.0.1' + (Number(cfg.eaPort) === 80 ? '' : ':' + cfg.eaPort);

console.log('\nKanairy doctor' + (FIX ? ' (repair mode)' : ' (check only, add --fix to repair)') + '\n');

// 1. MT5 and the EA files
const exe = cfg.mt5Path && fs.existsSync(cfg.mt5Path) ? cfg.mt5Path : '';
if (!exe) fail('MT5 not found at mt5Path in config.json. Open MT5 once, then start the server again so it finds it.'); else ok('MT5 found: ' + exe);
const dataDir = cfg.mt5DataDir && fs.existsSync(cfg.mt5DataDir) ? cfg.mt5DataDir : '';
if (!dataDir) fail('MT5 data folder not found. Open MT5 once, close it, then start the server again.'); else ok('MT5 data folder found');
if (dataDir) {
  const ex5 = path.join(dataDir, 'MQL5', 'Experts', 'KanairyEA.ex5'), mq5 = path.join(dataDir, 'MQL5', 'Experts', 'KanairyEA.mq5');
  const src = path.join(DIR, '..', 'mt5', 'KanairyEA.mq5');
  const stale = fs.existsSync(src) && fs.existsSync(mq5) && fs.readFileSync(src, 'utf8') !== fs.readFileSync(mq5, 'utf8');
  if (!fs.existsSync(ex5)) fail('EA is not compiled. Start the server (it compiles it), or in MT5 press F4, open KanairyEA and press F7.');
  else if (stale) fail('EA in MT5 is an older version than the one in this folder. Start the server; it recompiles it.');
  else ok('EA is installed and compiled');
}

// 2. MT5 running?
let mt5Up = false;
if (WIN) {
  const r = await run('tasklist', ['/FI', 'IMAGENAME eq terminal64.exe', '/NH']);
  mt5Up = /terminal64\.exe/i.test(r.out);
  info(mt5Up ? 'MT5 is running' : 'MT5 is not running (the server starts it for you once your login is saved in the app)');
}

// 3. token in the set file matches config.json
if (dataDir) {
  const f = path.join(dataDir, 'MQL5', 'Presets', 'kanairy.set');
  const want = `InpToken=${cfg.eaToken}\r\nInpPort=${cfg.eaPort}\r\nInpAllowLive=${cfg.allowLive ? 'true' : 'false'}\r\n`;
  let have = ''; try { have = fs.readFileSync(f, 'utf8'); } catch { /* none */ }
  if (have.includes('InpToken=' + cfg.eaToken) && have.includes('InpPort=' + cfg.eaPort)) ok('EA settings file has the current token');
  else if (FIX) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, want); fixed('Rewrote the EA settings file with the current token'); needRelaunch = true; }
  else fail('EA settings file has an old or missing token (the usual reason the EA says "wrong token"). Run fix-everything.bat.');
}

// 4. WebRequest permission in MT5's own settings
if (dataDir) {
  const f = path.join(dataDir, 'config', 'common.ini');
  let txt = ''; try { const b = fs.readFileSync(f); txt = (b[0] === 0xFF ? b.toString('utf16le') : b.toString('utf8')); } catch { /* none */ }
  const url = eaUrl;
  if (txt.includes(url) && /WebRequest\s*=\s*1/i.test(txt)) ok('MT5 allows the EA to call the server (WebRequest)');
  else if (FIX) {
    if (mt5Up) { await run('taskkill', ['/IM', 'terminal64.exe', '/F']); await new Promise(r => setTimeout(r, 2500)); mt5Up = false; info('Closed MT5 so its settings can be saved'); }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    let cur = Buffer.alloc(0); try { cur = fs.readFileSync(f); } catch { /* none */ }
    fs.writeFileSync(f, patchSection(cur, 'Experts', { Enabled: 1, AllowLiveTrading: 1, WebRequest: 1, WebRequestUrl: url }));
    fixed('Added ' + url + ' to the WebRequest allow-list'); needRelaunch = true;
  } else fail('MT5 does not yet allow ' + url + ' for WebRequest. Run fix-everything.bat.');
}

// 5. Windows firewall for the phone port
if (WIN) {
  const r = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in']);
  const blocks = r.out.split(/\r?\n\r?\n/);
  const has = blocks.some(b => new RegExp('LocalPort:\\s*' + cfg.appPort + '\\b').test(b) && /Action:\s*Allow/i.test(b) && /Enabled:\s*Yes/i.test(b));
  if (has) ok('Windows firewall allows port ' + cfg.appPort);
  else if (FIX) {
    const a = await run('netsh', ['advfirewall', 'firewall', 'add', 'rule', 'name=Kanairy-' + cfg.appPort, 'dir=in', 'action=allow', 'protocol=TCP', 'localport=' + cfg.appPort, 'profile=any']);
    if (a.e) fail('Could not open the Windows firewall. Run fix-everything.bat as Administrator.'); else fixed('Opened port ' + cfg.appPort + ' in the Windows firewall');
  } else fail('Windows firewall has no rule for port ' + cfg.appPort + '. Run fix-everything.bat.');
}

// 6. the server itself
const get = async (url, opts = {}, ms = 4000) => { try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) }); } catch { return null; } };
const local = await get(`http://127.0.0.1:${cfg.appPort}/api/status`);
if (local && local.status === 401) ok('Kanairy server is running on port ' + cfg.appPort);
else fail('Kanairy server is NOT running. Double-click start-kanairy.bat and keep its window open.');
const ping = await get(`${eaUrl}/ping`, { method: 'POST', headers: { 'X-Token': cfg.eaToken } });
if (ping && ping.status === 200) ok('EA bridge answers with the current token on port ' + cfg.eaPort + '. (This only proves the server side. The next check proves MT5 itself.)'); else if (local) fail('EA bridge on port ' + cfg.eaPort + ' did not answer. Another program may be using port ' + cfg.eaPort + ' (IIS?), or the server is an old version. Restart the server and read its first lines.');

// 6b. the real proof: is the EA inside MT5 talking to the server right now?
if (local) {
  const ts = Date.now(), nonce = crypto.randomBytes(6).toString('hex'), pth = '/api/status';
  const sig = crypto.createHmac('sha256', cfg.appKey).update(`${ts}\n${nonce}\nGET\n${pth}\n`).digest('hex');
  const r = await get(`http://127.0.0.1:${cfg.appPort}${pth}`, { headers: { 'X-Ts': String(ts), 'X-Nonce': nonce, 'X-Sig': sig } });
  let st = null; try { st = r && r.ok ? await r.json() : null; } catch { /* ignore */ }
  if (st && st.conn) ok('MT5\'s EA is connected and syncing right now');
  else if (st) { const m = 'MT5\'s EA is NOT connected. ' + (st.hint || ''); if (mt5Up || !WIN) fail(m); else info(m); }
}

// 7. reachable from outside (tests the AWS security group)
let ip = '';
const ipr = await get('https://api.ipify.org', {}, 5000);
if (ipr) ip = (await ipr.text()).trim();
if (ip) {
  const pub = await get(`http://${ip}:${cfg.appPort}/api/status`, {}, 6000);
  if (pub && pub.status === 401) ok(`Port ${cfg.appPort} is reachable from the internet at http://${ip}:${cfg.appPort}`);
  else if (local) fail(`Port ${cfg.appPort} is NOT reachable from the internet. In AWS: EC2 > your instance > Security tab > open its security group > Edit inbound rules > add Custom TCP ${cfg.appPort}, source 0.0.0.0/0, Save rules. Check the group shown on the instance is the one you edit.`);
  info('Phone address: http://' + ip + ':' + cfg.appPort + '   (it changes if you stop and start the instance; attach an Elastic IP to keep it)');
} else info('Could not look up the public IP (no internet from this machine?)');

// 8. clock (the phone signs every request with the time; more than 60 s off is rejected)
const t = await get('https://api.ipify.org', { method: 'HEAD' }, 5000);
const dh = t && t.headers.get('date');
if (dh) {
  const skew = Math.abs(Date.now() - new Date(dh).getTime()) / 1000;
  if (skew < 30) ok('Server clock is correct'); else fail(`Server clock is off by ${Math.round(skew)} seconds, so the phone is rejected. Settings > Time & language > Date & time > Sync now.`);
}

console.log('\n' + (problems ? problems + ' problem(s) left.' : 'All checks passed.'));
if (needRelaunch) console.log('MT5 settings changed. If Kanairy server is running it restarts MT5 by itself within a minute. Otherwise tap Launch MT5 in the app.');
try { fs.mkdirSync(path.join(DIR, 'data'), { recursive: true }); fs.writeFileSync(path.join(DIR, 'data', 'doctor-report.txt'), lines.join('\r\n') + '\r\n'); } catch { /* ignore */ }
