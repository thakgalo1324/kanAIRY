import { h, field, toast, sheet } from './ui.js';
import { B } from './native.js';

export function mountAccount(root, refresh) {
  const body = h('div');
  function render() {
    const info = B.info(), linked = B.link() === 'ok';
    const login = h('input', { type: 'text', inputmode: 'numeric', value: info.login || '', autocomplete: 'off' });
    const server = h('input', { type: 'text', value: info.server || '', autocapitalize: 'off', autocomplete: 'off', placeholder: 'e.g. ICMarketsSC-Demo' });
    const pw = h('input', { type: 'password', autocomplete: 'off', placeholder: info.hasPw ? 'Saved on your server. Type to replace' : '' });
    const sym = h('input', { type: 'text', value: info.symbol || 'XAUUSD', autocapitalize: 'characters' });
    const doSave = async () => {
      if (!login.value.trim() || !server.value.trim()) { toast('Enter your login and server'); return false; }
      const ok = await B.saveLogin(login.value.trim(), server.value.trim(), pw.value, sym.value.trim().toUpperCase() || 'XAUUSD');
      if (ok) { pw.value = ''; refresh(); }
      return ok;
    };
    body.replaceChildren(
      h('h1', {}, 'Account'), h('p', { class: 'lead' }, 'Sign in once. Your server starts MT5 and logs it in for you.'),
      linked ? null : h('div', { class: 'card flat', style: { marginBottom: '16px' } }, h('div', { class: 'small mute' }, 'Connect your server in Setup first.')),
      h('div', { class: 'card' }, field('Login', login), field('Server', server), field('Password', pw, 'Sent signed to your own server and stored encrypted there.'), field('Symbol to trade', sym),
        h('div', { class: 'btns' }, h('button', { class: 'btn solid', onclick: async () => { if (await doSave()) { toast('Saved'); render(); } } }, 'Save login'),
          info.login ? h('button', { class: 'btn ghost', onclick: () => sheet({ title: 'Remove login?', body: 'Your saved login, server and password are deleted from your server.', actions: [{ label: 'Keep' }, { label: 'Remove', solid: true, run: async () => { await B.clearLogin(); refresh(); render(); } }] }) }, 'Remove') : null)),
      h('div', { class: 'card' }, h('h2', {}, 'Start MT5'), h('p', { class: 'mute', style: { marginTop: 0 } }, 'Restarts MT5 on your VPS with this login and attaches the Kanairy EA.'),
        h('div', { class: 'btns', style: { marginTop: '6px' } }, h('button', { class: 'btn solid', onclick: async () => { if (!(await doSave())) return; const r = await B.launch(); toast(r.ok ? 'Starting MT5. Give it a minute.' : (r.error || 'Could not start MT5')); } }, 'Launch MT5'))),
      h('div', { class: 'card flat' }, h('div', { class: 'small mute' }, 'To watch trades live, sign in to the same account in the MT5 app on this phone. Trades appear there as the bot places them. Avoid trading by hand while the bot runs.')));
  }
  render();
  root.append(body);
  return { render };
}
