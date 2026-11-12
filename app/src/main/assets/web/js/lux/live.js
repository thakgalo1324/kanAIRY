import { h, icon, fmt, px, sgn, clock, sheet, toast } from './ui.js';
import { B } from './native.js';

export function mountLive(root, go, setPill) {
  const bigNum = h('span', { class: 'num' }, '0.00');
  const sign = h('small', {}, '');
  const big = h('div', { class: 'big' }, sign, bigNum);
  const bal = h('b', { class: 'num' }, '–'), eqt = h('b', { class: 'num' }, '–');
  const hero = h('div', { class: 'hero' }, big, h('div', { class: 'cap' }, 'Today'),
    h('div', { class: 'duo' }, h('div', {}, bal, h('span', {}, 'Balance')), h('div', {}, eqt, h('span', {}, 'Equity'))));

  // crown: press and hold to start, tap to stop
  const face = h('div', { class: 'face' }, h('div', {}, h('b', {}, 'Start'), h('i', {}, 'Hold')));
  const crown = h('div', { class: 'crown off', role: 'button', tabindex: '0', 'aria-label': 'Start or stop the bot' },
    (() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 184 184');
      s.innerHTML = '<circle class="track" cx="92" cy="92" r="86"/><circle class="prog" cx="92" cy="92" r="86"/>'; return s; })(), face);
  const hint = h('div', { class: 'hint' }, '');
  let holdT = null, S = { run: false }, canStart = false, cuMode = false;
  // With your own imported EA the crown starts and stops MT5 itself: hold to start, tap to stop.
  const startEa = async () => { const r = await B.launch(); toast(r.ok ? 'Starting your EA. Give MT5 a minute.' : (r.error || 'Could not start MT5')); };
  const stop = () => {
    if (!cuMode) { B.run(false); toast('Bot stopped'); return; }
    sheet({ title: 'Stop your EA?', body: 'MT5 is shut down on your server so the EA cannot trade. Open trades stay open and keep their broker stops.',
      actions: [{ label: 'Cancel' }, { label: 'Stop', solid: true, run: () => { B.kill(); toast('Stopping your EA'); } }] });
  };
  const begin = () => { if (S.run) return; if (!canStart) return; crown.classList.add('hold'); holdT = setTimeout(() => { crown.classList.remove('hold'); holdT = null; if (cuMode) startEa(); else { B.run(true); toast('Bot started'); } tick(); }, 760); };
  const cancel = () => { if (holdT) { clearTimeout(holdT); holdT = null; } crown.classList.remove('hold'); };
  crown.addEventListener('pointerdown', e => { e.preventDefault(); if (S.run) { stop(); tick(); } else begin(); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => crown.addEventListener(ev, cancel));
  crown.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); if (S.run) { stop(); tick(); } else if (canStart) { if (cuMode) startEa(); else B.run(true); tick(); } } });

  const steps = h('div', { class: 'card' });
  const trio = h('div', { class: 'trio' });
  const posCard = h('div', { class: 'card' }), feedCard = h('div', { class: 'card' });
  const kill = h('button', { class: 'btn ghost wide', onclick: () => sheet({ title: B.ea().mode === 'custom' ? 'Stop the imported EA?' : 'Close all and stop?', body: B.ea().mode === 'custom' ? 'MT5 is shut down on your VPS so the EA cannot trade. Open trades stay open and keep their broker stops. Close them in the MT5 app if you want them gone.' : 'Every open trade from the bot closes at market and the bot stops.',
    actions: [{ label: 'Cancel' }, { label: 'Close all', solid: true, run: () => { B.kill(); toast('Closing all trades'); } }] }) }, 'Close all and stop');

  root.append(hero, h('div', { class: 'crownwrap' }, crown), hint, steps, trio, posCard, feedCard, h('div', { style: { height: '8px' } }), kill);

  let info = {}, infoAt = 0, feedSig = '';
  const step = (done, title, sub, action, label) => h('div', { class: 'step' + (done ? ' done' : '') },
    h('div', { class: 'tick' }, done ? icon('check', 15) : null), h('div', { class: 'grow' }, h('div', {}, title), h('div', { class: 'small mute' }, sub)),
    !done && action ? h('button', { class: 'btn sm', onclick: action }, label) : null);

  function paintPositions(st) {
    const rows = (st.pos || []).map(p => h('li', { class: 'li' },
      h('div', { class: 'badge ' + (p[1] === 0 ? 'buy' : '') }, icon(p[1] === 0 ? 'up' : 'down', 18)),
      h('div', {}, h('div', { class: 't' }, (p[1] === 0 ? 'Buy ' : 'Sell ') + fmt(p[2])), h('div', { class: 's num' }, 'at ' + px(p[3]))),
      h('div', { class: 'r pnl ' + (p[6] >= 0 ? 'up' : 'down') }, sgn(p[6]))));
    posCard.replaceChildren(h('h2', {}, 'Open trades'), rows.length ? h('ul', { class: 'list' }, rows) : h('div', { class: 'empty' }, st.run ? 'Watching the market. Nothing open yet.' : 'No open trades.'));
  }
  function paintFeed(items) {
    const sig = items.length + ':' + (items[0] ? items[0].t : 0);
    if (sig === feedSig) return;
    const first = feedSig === '';
    feedSig = sig;
    const rows = items.slice(0, 14).map((f, i) => h('li', { class: 'li' + (i === 0 && !first ? ' feedrow' : '') },
      h('div', { class: 'badge ' + (f.side === 'buy' ? 'buy' : '') }, f.k === 'sys' ? '•' : f.k === 'signal' ? '◎' : icon(f.side === 'buy' ? 'up' : 'down', 18)),
      h('div', { class: 'grow' }, h('div', { class: 't' }, f.text), h('div', { class: 's num' }, clock(f.t) + (f.price ? '   ' + px(f.price) : ''))),
      f.k === 'close' ? h('div', { class: 'r pnl ' + (f.profit >= 0 ? 'up' : 'down') }, sgn(f.profit)) : null));
    feedCard.replaceChildren(h('h2', {}, 'Activity'), rows.length ? h('ul', { class: 'list' }, rows) : h('div', { class: 'empty' }, 'Trades appear here the moment they happen.'));
  }

  function tick() {
    const st = B.status();
    if (Date.now() - infoAt > 4000) { info = B.info(); infoAt = Date.now(); }
    const cu = !!(st.ea && st.ea.mode === 'custom'); // an imported .mq5 EA is running by itself
    const linked = st.link === 'ok', acct = !!(info.login && info.hasPw), strat = cu || !!st.strategy, ea = cu ? !!st.mt5Up : !!st.conn;
    cuMode = cu;
    const running = cu ? !!(st.ea && st.ea.running) : !!st.run;
    S = { ...st, run: running };
    canStart = cu ? linked && acct && st.ea.state === 'ok' && !running : linked && strat && ea;
    // hero
    const v = st.dayPnl || 0;
    sign.textContent = v < 0 ? '−' : v > 0 ? '+' : '';
    bigNum.textContent = fmt(Math.abs(v));
    bal.textContent = st.bal ? fmt(st.bal) : '–'; eqt.textContent = st.eq ? fmt(st.eq) : '–';
    // crown
    crown.classList.toggle('run', running);
    crown.classList.toggle('off', !running && !canStart);
    face.firstChild.firstChild.textContent = running ? 'Stop' : 'Start';
    face.firstChild.lastChild.textContent = running ? 'Tap' : 'Hold';
    hint.textContent = cu ? (running ? (st.hint || 'Running your imported EA') : acct ? (st.hint && !running && st.mt5Up === false && st.hint.includes('Launch') ? 'Hold the crown to start your EA' : (st.hint || 'Hold the crown to start your EA')) : 'Add your broker login in Account') : st.run ? (st.err || 'Running on ' + (st.sym || 'chart') + ' ' + (st.tf || '')) : !linked ? (st.link === 'nouser' || st.link === 'badpin' ? 'Sign in on the Setup tab' : 'Connect your server in Setup') : !strat ? 'Load a strategy to begin' : !ea ? (st.hint || 'Waiting for the EA to connect') : 'Hold the crown to start';
    setPill(cu ? (running ? 'live' : 'idle') : st.run ? 'live' : ea ? 'ready' : 'idle', !linked ? ({ unconfigured: 'No server', offline: 'Server offline', badkey: 'Key rejected', nouser: 'Sign in', badpin: 'Wrong PIN', locked: 'Locked' }[st.link] || 'No server') : cu ? (running ? 'Imported EA' : 'EA stopped') : st.run ? 'Running' : ea ? 'EA connected' : 'Waiting for EA');
    // checklist, only until everything is ready
    if (strat && ea) steps.style.display = 'none';
    else {
      steps.style.display = '';
      steps.replaceChildren(h('h2', {}, 'Get ready'),
        step(linked, 'Your server', linked ? 'Signed in as ' + (st.user || B.user()) : ({ nouser: 'Sign in or create your account', badpin: 'Sign in again with your PIN', locked: 'Too many wrong PINs. Wait a few minutes' }[st.link] || 'Add your VPS address and key'), () => go('setup'), 'Open'),
        step(acct, 'Broker account', acct ? info.login + ' on ' + info.server : 'Add your login so your server can start MT5', () => go('account'), 'Add'),
        step(strat, 'Strategy', strat ? st.strategy : 'Import your XML rules', () => go('strategy'), 'Import'),
        step(ea, 'EA connection', ea ? 'Connected' : (st.hint || 'Launch MT5 from the Account tab'), () => go('account'), 'Open'));
    }
    const wr = st.wins + st.losses ? Math.round(st.wins / (st.wins + st.losses) * 100) + '%' : '–';
    trio.replaceChildren(h('div', {}, h('b', { class: 'num' }, String(st.dayTrades || 0)), h('span', {}, 'Orders sent')), h('div', {}, h('b', { class: 'num' }, wr), h('span', {}, 'Win rate')), h('div', {}, h('b', { class: 'num' }, String((st.pos || []).length)), h('span', {}, 'Open now')));
    paintPositions(st);
    paintFeed(B.feed());
  }
  tick();
  return { tick };
}
