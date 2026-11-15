import { h, field, toast, toggle, sheet } from './ui.js';
import { B, native } from './native.js';

const NOTE = { ok: 'Connected to your server', unconfigured: 'Not connected yet', offline: 'Cannot reach the server. Check the address, that the server is running, and that port 8766 is open', badkey: 'Reached the server, but it rejected the app key',
  nouser: 'Server found. Now sign in or create your account below', badpin: 'Signed out. Sign in again with your name and PIN', locked: 'Too many wrong PINs. Try again in a few minutes' };

export function mountSetup(root, applyTheme, getTheme) {
  const body = h('div');
  let busy = false;
  function render() {
    const v = B.vps(), link = B.link(), me = B.user(), hello = B.hello();
    const url = h('input', { type: 'text', value: v.url || '', autocapitalize: 'off', autocomplete: 'off', placeholder: 'http://123.45.67.89:8766' });
    const key = h('input', { type: 'password', autocomplete: 'off', placeholder: v.hasKey ? 'Saved. Type to replace' : 'App key from the server window' });
    const note = h('div', { class: 'small mute', style: { marginTop: '12px' } }, NOTE[link] || '');
    const connect = () => {
      if (!url.value.trim()) { toast('Enter your server address'); return; }
      if (!v.hasKey && !key.value.trim()) { toast('Enter the app key'); return; }
      B.saveVps(url.value, key.value); key.value = '';
      note.textContent = 'Connecting';
      B.pollNow(); setTimeout(() => { B.pollNow(); setTimeout(() => { note.textContent = NOTE[B.link()] || ''; toast(B.link() === 'ok' || B.link() === 'nouser' ? 'Connected' : (NOTE[B.link()] || '')); render(); }, 1500); }, 600);
    };

    // ---- account: a name and a PIN. Everyone uses the same app key, and each person trades their own broker account ----
    const name = h('input', { type: 'text', autocapitalize: 'off', autocomplete: 'off', placeholder: 'Your name, for example thabo' });
    const pin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'A PIN of 4 or more digits' });
    const go = async create => {
      if (busy) return;
      const n = name.value.trim().toLowerCase(), p = pin.value;
      if (!/^[a-z0-9][a-z0-9_-]{1,19}$/.test(n)) { toast('Name: 2 to 20 letters, numbers, - or _'); return; }
      if (p.length < 4) { toast('PIN must be at least 4 characters'); return; }
      busy = true; toast(create ? 'Creating your account' : 'Signing in');
      const r = await (create ? B.createAccount(n, p) : B.signIn(n, p));
      busy = false;
      toast(r.ok ? (create ? 'Account created. Add your broker login next' : 'Signed in') : (r.error || 'Failed'));
      if (r.ok && create) setTimeout(() => window.__go && window.__go('account'), 700);
      render();
    };
    const acct = !v.hasKey || link === 'unconfigured' || link === 'badkey' || link === 'offline' && !me ? null
      : me ? h('div', { class: 'card' }, h('h2', {}, 'Your account'),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', {}, me), h('div', { class: 'small mute' }, link === 'ok' ? 'Signed in on this phone' : (NOTE[link] || ''))),
          h('button', { class: 'btn ghost sm', onclick: () => { B.signOut(); toast('Signed out'); render(); } }, 'Sign out')),
        h('div', { class: 'small faint', style: { margin: '12px 0' } }, 'Your broker login, strategy and EA belong to this account only.'),
        h('button', { class: 'btn ghost sm', onclick: () => sheet({ title: 'Delete your account?', body: 'This removes your login, strategy, imported EAs and your private MT5 from the server. Open trades stay open at your broker.',
          actions: [{ label: 'Cancel' }, { label: 'Delete', solid: true, run: async () => { const r = await B.deleteAccount(); toast(r.ok ? 'Account deleted' : r.error); render(); } }] }) }, 'Delete account'))
        : h('div', { class: 'card' }, h('h2', {}, 'Your account'),
          h('p', { class: 'small mute', style: { margin: '-6px 0 14px' } }, 'Each person has their own name and PIN, their own broker account and their own MT5 on the server.' + (hello ? ` ${hello.users} of ${hello.max} accounts used.` : '')),
          field('Name', name), field('PIN', pin, 'You need the same name and PIN to sign in on another phone.'),
          h('div', { class: 'btns', style: { marginTop: '6px' } }, h('button', { class: 'btn solid', onclick: () => go(false) }, 'Sign in'), h('button', { class: 'btn ghost', onclick: () => go(true) }, 'Create account')));

    // ---- signals: paste a post from your channel; Ask first (you tap Execute) or Auto (the server places it) ----
    const sgBox = h('div', { class: 'card' });
    const sgText = h('textarea', { rows: 5, autocapitalize: 'off', autocomplete: 'off', placeholder: 'Paste a signal, for example:\nGOLD BUY 3927 3928\nTP 3935\nTP 3945\nTP 3960\nSL 3920', style: { width: '100%', boxSizing: 'border-box' } });
    let sgTimer = 0;
    const STAT = { pending: 'Waiting for you', queued: 'Waiting for the price', done: 'Sent', skipped: 'Skipped' };
    const paintSg = async () => {
      const st = await B.signals(), box = [h('h2', {}, 'Signals')];
      const setMode = async m => { const r = await B.signalMode({ mode: m }); toast(r.ok ? (m === 'off' ? 'Signals off' : m === 'ask' ? 'Ask first' : 'Auto-execute on') : 'Could not change'); paintSg(); };
      const chip = (m, label) => h('button', { class: 'btn ' + (st.mode === m ? 'solid' : 'ghost') + ' sm', onclick: () => m === 'auto' && st.mode !== 'auto'
        ? sheet({ title: 'Turn on Auto-execute?', body: 'Every clear signal will be traded without asking you, using your lot size and limits. Use this on a demo account first.', actions: [{ label: 'Cancel' }, { label: 'Turn on', solid: true, run: () => setMode('auto') }] })
        : setMode(m) }, label);
      box.push(h('p', { class: 'small mute', style: { margin: '-6px 0 12px' } }, 'Paste a post from your channel, or press Share on it in WhatsApp and pick Kanairy. The server reads the entry, stop loss and take profits, and places one order per take profit. Posts without a stop loss are never traded. Start the bot on the Live screen for orders to go out.'));
      box.push(h('div', { class: 'btns', style: { marginBottom: '12px' } }, chip('off', 'Off'), chip('ask', 'Ask first'), chip('auto', 'Auto')));
      box.push(field('Signal', sgText));
      box.push(h('div', { class: 'btns', style: { marginTop: '6px' } }, h('button', { class: 'btn solid', onclick: async () => {
        if (!sgText.value.trim()) { toast('Paste a signal first'); return; }
        const r = await B.sendSignal(sgText.value); if (r.ok) { sgText.value = ''; toast(st.mode === 'auto' ? 'Added. It will trade when price is in the zone' : 'Added. Tap Execute to trade it'); } else toast(r.error || 'Not a clear signal');
        paintSg(); } }, 'Add signal')));
      const list = st.list || [];
      box.push(h('div', { class: 'small faint', style: { margin: '14px 0 6px' } }, list.length ? 'Recent signals' : 'No signals yet.'));
      list.slice(0, 6).forEach(e => {
        const g = e.sig, zone = g.lo === g.hi ? g.lo : g.lo + '-' + g.hi;
        box.push(h('div', { class: 'rule' },
          h('div', {}, h('b', {}, g.side.toUpperCase() + ' gold ' + zone), '  SL ' + g.sl + '  TP ' + g.tps.join(' / ')),
          h('div', { class: 'small mute' }, (STAT[e.status] || e.status) + (e.note ? '. ' + e.note : '')),
          e.status === 'pending' ? h('div', { class: 'btns', style: { marginTop: '8px' } },
            h('button', { class: 'btn solid sm', onclick: async () => { await B.signalAct(e.id, 'approve'); toast('Approved'); paintSg(); } }, 'Execute'),
            h('button', { class: 'btn ghost sm', onclick: async () => { await B.signalAct(e.id, 'skip'); paintSg(); } }, 'Skip')) : null,
          e.status === 'queued' ? h('div', { class: 'btns', style: { marginTop: '8px' } }, h('button', { class: 'btn ghost sm', onclick: async () => { await B.signalAct(e.id, 'skip'); paintSg(); } }, 'Cancel')) : null));
      });
      sgBox.replaceChildren(...box);
      clearTimeout(sgTimer); sgTimer = setTimeout(() => { if (sgBox.isConnected && document.activeElement !== sgText) paintSg(); else if (sgBox.isConnected) sgTimer = setTimeout(paintSg, 5000); }, 5000);
    };
    window.__refreshSignals = paintSg;
    if (me && link === 'ok') paintSg();

    body.replaceChildren(...[
      h('h1', {}, 'Setup'), h('p', { class: 'lead' }, 'Connect the app to the Kanairy server on your VPS.'),
      h('div', { class: 'card' }, h('h2', {}, 'Your server'), field('Address', url, 'Your VPS public IP and port, as printed by the server'), field('App key', key, 'The same key for everyone. It is printed in the server window and never changes. Stored encrypted on this phone.'),
        h('div', { class: 'btns', style: { marginTop: '6px' } }, h('button', { class: 'btn solid', onclick: connect }, 'Connect')), note),
      acct,
      me && link === 'ok' ? sgBox : null,
      h('div', { class: 'card' }, h('h2', {}, 'On the VPS'),
        ...['Install Node.js and MetaTrader 5, then copy the vps folder. Run start-kanairy.bat.', 'Open TCP port 8766 in the VPS firewall.', 'Enter the address and app key above. The key never changes, even after updates.', 'Create an account for each person. The server sets up a private MT5 for each one.'].map((t, i) => h('div', { class: 'rule' }, h('b', {}, (i + 1) + '.  '), t)),
        h('div', { class: 'small faint', style: { marginTop: '10px' } }, 'Full steps are in README-VPS.md.')),
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', {}, 'Light appearance'), h('div', { class: 'small mute' }, 'Black on white')), toggle(getTheme() === 'light', on => applyTheme(on ? 'light' : 'dark'), 'Light appearance'))),
      h('div', { class: 'card flat' }, h('div', { class: 'small mute', style: { marginBottom: '12px' } }, 'The earlier Kanairy that reads the MT5 Android screen is still here.'), h('a', { class: 'btn ghost sm', href: 'classic.html' }, 'Open classic mode')),
      !native ? h('div', { class: 'small faint', style: { textAlign: 'center' } }, 'Preview mode. Install the Android app to trade.') : null].filter(Boolean));
  }
  render();
  root.append(body);
  return { render };
}
