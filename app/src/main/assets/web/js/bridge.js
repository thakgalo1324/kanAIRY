// Bridge to the native Kanairy service. In a normal browser it falls back to harmless stubs.
const N = window.Android || null;
// One-time secret: only this page can fetch it, so frames loaded later (the assistant) cannot drive the robot.
const T = N ? N.token() : '';
const store = k => { try { return localStorage.getItem('kanairy.native.' + k); } catch { return null; } };
const put = (k, v) => { try { localStorage.setItem('kanairy.native.' + k, v); } catch { /* ignore */ } };

export const native = !!N;
export const A = {
  status: () => { try { return JSON.parse(N ? N.status(T) : '{"svc":false,"log":[]}'); } catch { return { svc: false, log: [] }; } },
  events: () => { try { return JSON.parse(N ? N.events(T) : '[]'); } catch { return []; } },
  setAuto: on => N && N.setAuto(T, !!on),
  act: name => N && N.act(T, name),
  getCfg: (k, d) => (N ? N.getCfg(T, k, String(d)) : (store(k) ?? String(d))),
  setCfg: (k, v) => { if (N) N.setCfg(T, k, String(v)); else put(k, String(v)); },
  getFlag: (k, d) => (N ? N.getFlag(T, k, !!d) : (store(k) == null ? !!d : store(k) === '1')),
  setFlag: (k, v) => { if (N) N.setFlag(T, k, !!v); else put(k, v ? '1' : '0'); },
  getStrategy: () => (N ? N.getStrategy(T) : store('strategy') || ''),
  setStrategy: json => { if (N) N.setStrategy(T, json); else put('strategy', json); },
  saveFile: (name, text) => (N ? N.saveFile(T, name, text) : false),
};

// Async HTTP through the phone (WebView pages cannot call other sites directly).
const pending = new Map(); let seq = 0;
window.__http = (id, status, body) => { const p = pending.get(id); if (!p) return; pending.delete(id); p({ status, body }); };
export function httpGet(url) {
  if (!N) return fetch(url).then(async r => ({ status: r.status, body: await r.text() })).catch(() => ({ status: 0, body: '' }));
  return new Promise(res => {
    const id = ++seq; pending.set(id, res);
    setTimeout(() => { if (pending.delete(id)) res({ status: 0, body: '' }); }, 30000);
    N.http(T, id, url);
  });
}
