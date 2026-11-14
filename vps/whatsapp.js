// Optional WhatsApp link. Signs in with a pairing code (no QR), then collects posts from a channel into an inbox.
// Needs the unofficial library: run install-whatsapp.bat once. If it is not installed, everything else still works.
// This uses an unofficial method: WhatsApp can log out or ban the linked number. Use a spare number.
import fs from 'node:fs';
import path from 'node:path';

export function createWa({ dir, log }) {
  const authDir = path.join(dir, 'wa-auth'), inboxFile = path.join(dir, 'wa-inbox.json');
  let sock = null, lib = null;
  const st = { state: 'off', code: '', phone: '', error: '', channel: '', channelName: '' };
  let inbox = [];
  try { inbox = JSON.parse(fs.readFileSync(inboxFile, 'utf8')); } catch { /* none yet */ }
  const keep = () => { try { fs.writeFileSync(inboxFile, JSON.stringify(inbox.slice(0, 200))); } catch { /* ignore */ } };
  const textOf = m => { const x = m && m.message; if (!x) return ''; return x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption || x.videoMessage?.caption || ''; };

  async function load() {
    if (lib) return lib;
    try { lib = await import('@whiskeysockets/baileys'); return lib; }
    catch { st.state = 'missing'; st.error = 'The WhatsApp add-on is not installed on the server. Run install-whatsapp.bat once, then try again.'; return null; }
  }

  async function connect(phone) {
    const L = await load(); if (!L) return st;
    const makeWASocket = L.default || L.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = L;
    fs.mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    let version; try { version = (await fetchLatestBaileysVersion()).version; } catch { /* use the default */ }
    try { sock && sock.end && sock.end(); } catch { /* old socket gone */ }
    sock = makeWASocket({ auth: state, version, browser: ['Kanairy', 'Chrome', '1.0'], markOnlineOnConnect: false, syncFullHistory: false });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async u => {
      if (u.connection === 'open') { st.state = 'linked'; st.code = ''; st.error = ''; log('WhatsApp linked'); if (st.channel) follow(st.channel).catch(() => {}); }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) { st.state = 'off'; st.error = 'WhatsApp logged this device out. Link it again.'; try { fs.rmSync(authDir, { recursive: true, force: true }); } catch { /* ignore */ } }
        else { st.state = 'reconnecting'; setTimeout(() => connect().catch(() => {}), 4000); }
      }
    });
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages || []) {
        const jid = m.key?.remoteJid || '', text = textOf(m).trim();
        if (!text || m.key?.fromMe) continue;
        if (!/@newsletter$|@g\.us$/.test(jid)) continue; // only channels and groups, never private chats
        inbox.unshift({ t: Date.now(), from: jid, text: text.slice(0, 1500) }); inbox = inbox.slice(0, 200); keep();
      }
    });
    if (!state.creds.registered && phone) {
      st.state = 'pairing'; st.phone = phone;
      setTimeout(async () => {
        try { const c = await sock.requestPairingCode(phone); st.code = c.replace(/(.{4})/, '$1-'); }
        catch (e) { st.error = 'Could not get a pairing code: ' + (e.message || e); st.state = 'off'; }
      }, 2500);
    } else if (state.creds.registered) st.state = 'connecting';
    return st;
  }

  async function follow(invite) {
    const code = String(invite || '').trim().replace(/^.*channel\//, '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!code) return { ok: false, error: 'Enter the channel link.' };
    st.channel = code;
    if (!sock) return { ok: true, note: 'Saved. It will follow the channel once WhatsApp is linked.' };
    try {
      if (typeof sock.newsletterMetadata === 'function') { const md = await sock.newsletterMetadata('invite', code); st.channelName = md?.name || ''; if (md?.id && typeof sock.newsletterFollow === 'function') await sock.newsletterFollow(md.id).catch(() => {}); if (md?.id && typeof sock.subscribeNewsletterUpdates === 'function') await sock.subscribeNewsletterUpdates(md.id).catch(() => {}); }
      return { ok: true, name: st.channelName };
    } catch (e) { return { ok: false, error: 'Could not open the channel: ' + (e.message || e) }; }
  }

  return {
    async link(phone) { const p = String(phone || '').replace(/[^0-9]/g, ''); if (p.length < 8) return { ok: false, error: 'Enter the number with country code, for example 27821234567.' }; st.error = ''; await connect(p); return { ok: !st.error, ...st }; },
    follow,
    status: () => ({ ...st, count: inbox.length }),
    inbox: () => inbox.slice(0, 50),
    async resume() { if (fs.existsSync(path.join(authDir, 'creds.json'))) await connect().catch(() => {}); },
    async unlink() { try { sock && (await sock.logout()); } catch { /* ignore */ } try { sock = null; fs.rmSync(authDir, { recursive: true, force: true }); } catch { /* ignore */ } st.state = 'off'; st.code = ''; inbox = []; keep(); return { ok: true }; },
  };
}
