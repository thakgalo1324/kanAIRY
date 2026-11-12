import { h, field, toast, toggle, sheet } from './ui.js';
import { B } from './native.js';
import { TEMPLATES, fromXML, toXML, operandText, parseOperand, validate } from '../strategy.js';

const cross = (a, b, dir) => ({ type: 'cross', a: parseOperand(a), b: parseOperand(b), dir });
const cmp = (a, op, b) => ({ type: 'cmp', a: parseOperand(a), op, b: parseOperand(b) });
const STARTER = () => ({ name: 'Gold scalper starter', timeframe: 'M1', risk: { lots: 0.01, slAtr: 1, tpAtr: 1.5, atrPeriod: 14 },
  rules: { enterLong: [cross('ema:5', 'ema:13', 'above'), cmp('rsi:14', '>', '50')], enterShort: [cross('ema:5', 'ema:13', 'below'), cmp('rsi:14', '<', '50')], exitLong: [], exitShort: [] } });

// .mq5 and .set files saved by MetaEditor are usually UTF-16, so read the bytes and look for the byte-order mark.
const decode = buf => {
  const u = new Uint8Array(buf);
  if (u[0] === 0xFF && u[1] === 0xFE) return new TextDecoder('utf-16le').decode(u.subarray(2));
  if (u[0] === 0xFE && u[1] === 0xFF) return new TextDecoder('utf-16be').decode(u.subarray(2));
  return new TextDecoder('utf-8').decode(u);
};
const EA_TFS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4'];

const say = c => c.type === 'cross' ? `${operandText(c.a)} crosses ${c.dir} ${operandText(c.b)}` : `${operandText(c.a)} is ${c.op === '>' ? 'above' : 'below'} ${operandText(c.b)}`;
const SIDES = [['enterLong', 'Buy when'], ['enterShort', 'Sell when'], ['exitLong', 'Close buys when'], ['exitShort', 'Close sells when']];
const GUARDS = [
  ['hub_lot', 'Lot size', '0', 'Leave 0 to use the strategy’s lots'],
  ['hub_max_open', 'Max open trades', '3', 'Across buys and sells'],
  ['hub_burst', 'Orders per signal', '1', 'Fire up to 10 at once (hedging accounts only)'],
  ['hub_cooldown', 'Cooldown (seconds)', '0', 'Pause between entries'],
  ['hub_max_day', 'Max orders a day', '200', ''],
  ['hub_daily_loss', 'Daily loss stop', '0', 'Stops the bot at this loss. 0 means off'],
  ['hub_max_spread', 'Max spread (points)', '0', 'Skip entries when the spread is wider. 0 means off'],
  ['hub_lot_per_1k', 'Lots per 1,000 equity', '0', 'Compounding. Lot size grows with your balance. 0 means off'],
  ['hub_lot_cap', 'Biggest single order (lots)', '0.1', 'Ceiling for compounding'],
  ['hub_max_total_lots', 'Total lots open at once', '0', 'Hard ceiling on all open trades together. 0 means off'],
];

export function mountStrategy(root, refresh) {
  let strat = null;
  try { strat = JSON.parse(B.getStrategy() || 'null'); } catch { strat = null; }
  const body = h('div');
  const save = async s => { if (!B.linkOk()) return; strat = s; render(); await B.setStrategy(JSON.stringify(s)); refresh(); };
  const file = h('input', { type: 'file', accept: '.xml,text/xml,application/xml', class: 'sr', onchange: async e => {
    const f = e.target.files[0]; if (!f) return;
    try { await save(fromXML(await f.text())); toast('Loaded ' + strat.name); } catch (er) { toast(er.message); } e.target.value = ''; } });

  // ---- imported EA card: updates on its own while the compile runs on the server ----
  let eaTf = 'M1';
  const eaCard = h('div', { class: 'card' });
  const b64 = buf => { const u = new Uint8Array(buf); let o = ''; for (let i = 0; i < u.length; i += 0x8000) o += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(o); };
  const eaFile = h('input', { type: 'file', accept: '.mq5,.ex5', class: 'sr', onchange: async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const ex5 = /\.ex5$/i.test(f.name);
    if (!ex5 && !/\.mq5$/i.test(f.name)) { toast('Pick a .mq5 or .ex5 file'); return; }
    if (f.size > (ex5 ? 2e6 : 1.5e6)) { toast('That file is too large'); return; }
    toast('Sending to your server');
    const buf = await f.arrayBuffer();
    const r = ex5 ? await B.importEx5(f.name, b64(buf)) : await B.importEa(f.name, decode(buf));
    toast(r.ok ? (ex5 ? 'Added to your server' : 'Compiling on your server') : (r.error || 'Import failed')); paintEa(); } });
  const setFile = h('input', { type: 'file', accept: '.set', class: 'sr', onchange: async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const r = await B.importPreset(decode(await f.arrayBuffer()));
    toast(r.ok ? 'Settings saved. Tap Run to apply them' : (r.error || 'Could not save settings')); paintEa(); } });
  const runEa = () => sheet({ title: 'Run this EA on your VPS?', body: 'The EA trades by itself. Your guard rails and the live-account lock below do not apply to it, and the Live crown does not control it. Use a demo account first.',
    actions: [{ label: 'Cancel' }, { label: 'Run it', solid: true, run: async () => {
      const m = await B.setEaMode('custom', eaTf); if (!m.ok) { toast(m.error || 'Could not switch'); return; }
      const r = await B.launch(); toast(r.ok ? 'Starting MT5 with your EA. Give it a minute.' : (r.error || 'Could not start MT5')); paintEa(); } }] });
  const backToXml = async () => { const m = await B.setEaMode('kanairy'); if (!m.ok) { toast(m.error || 'Could not switch'); return; } const r = await B.launch(); toast(r.ok ? 'Back to your XML strategy. Restarting MT5.' : (r.error || 'Could not start MT5')); paintEa(); };
  function paintEa() {
    const ea = B.ea(), custom = ea.mode === 'custom', busy = ea.state === 'compiling';
    const stateText = { none: 'No EA imported yet.', compiling: 'Compiling on your server…', ok: ea.name + ' is compiled and ready.', failed: ea.name ? ea.name + ' did not compile.' : 'Import failed.' }[ea.state] || '';
    eaCard.replaceChildren(h('h2', {}, 'Import an EA (.mq5 or .ex5)'),
      h('p', { class: 'mute small', style: { margin: '-6px 0 14px' } }, 'Pick a .mq5 source file (your server compiles it) or a compiled .ex5. It runs inside MT5 on your server. EAs that need a DLL will not work, because DLLs stay off. Only run EAs you trust and are licensed to use.'),
      h('div', { class: 'chips' }, h('button', { class: 'chip on', onclick: () => !busy && eaFile.click() }, 'Import EA file'),
        ea.name && ea.state === 'ok' ? h('button', { class: 'chip', onclick: () => setFile.click() }, ea.hasPreset ? 'Replace .set settings' : 'Add .set settings') : null), eaFile, setFile,
      h('div', { class: 'rule', style: { marginTop: '12px' } }, h('b', {}, stateText), ea.log ? h('div', { class: 'small mute', style: { whiteSpace: 'pre-wrap', marginTop: '6px' } }, ea.log) : null),
      ea.state === 'ok' ? h('div', { style: { marginTop: '12px' } }, h('div', { class: 'faint small', style: { marginBottom: '6px' } }, 'Chart timeframe'),
        h('div', { class: 'chips' }, EA_TFS.map(t => h('button', { class: 'chip' + (eaTf === t ? ' on' : ''), onclick: () => { eaTf = t; paintEa(); } }, t)))) : null,
      custom ? h('div', { class: 'rule', style: { marginTop: '12px' } }, h('b', {}, 'Running: '), 'your imported EA is in charge. Kanairy’s guard rails and the crown do not control it.') : null,
      h('div', { class: 'btns' },
        ea.state === 'ok' && !custom ? h('button', { class: 'btn solid', onclick: runEa }, 'Run it on my VPS') : null,
        ea.state === 'ok' && custom ? h('button', { class: 'btn solid', onclick: runEa }, 'Restart with new settings') : null,
        custom ? h('button', { class: 'btn ghost', onclick: backToXml }, 'Back to my XML strategy') : null));
  }
  let eaSig = '';
  setInterval(() => { if (!root.classList.contains('on')) return; const sig = JSON.stringify(B.ea()); if (sig !== eaSig) { eaSig = sig; paintEa(); } }, 2000);

  function render() {
    paintEa();
    const kids = [h('h1', {}, 'Strategy'), h('p', { class: 'lead' }, 'Your rules, in XML. The bot trades exactly what you load here.')];
    // current
    const cur = h('div', { class: 'card' });
    if (strat) {
      cur.append(h('div', { class: 'faint small' }, 'Loaded'), h('h2', { style: { fontStyle: 'italic', fontSize: '26px', margin: '4px 0 4px' } }, strat.name),
        h('div', { class: 'small mute num', style: { marginBottom: '14px' } }, `${strat.timeframe || 'M1'}   ${strat.risk.lots} lots   stop ${strat.risk.slAtr ?? 'auto'} ATR   target ${strat.risk.tpAtr ?? 'none'} ATR`));
      SIDES.forEach(([k, label]) => { if (strat.rules[k].length) cur.append(h('div', { class: 'rule' }, h('b', {}, label + ' '), strat.rules[k].map(say).join(', and ')));});
    } else cur.append(h('h2', {}, 'Nothing loaded'), h('p', { class: 'mute', style: { margin: 0 } }, 'Import an XML file, pick a starter, or paste XML below.'));
    kids.push(cur);

    // load
    const ta = h('textarea', { spellcheck: 'false', 'aria-label': 'Strategy XML', placeholder: '<strategy name="My scalper"> ...' });
    if (strat) ta.value = toXML(strat);
    const load = h('div', { class: 'card' }, h('h2', {}, 'Load rules'),
      h('div', { class: 'chips' }, h('button', { class: 'chip on', onclick: () => file.click() }, 'Import XML file'), h('button', { class: 'chip', onclick: () => save(STARTER()) }, 'Gold scalper starter'),
        Object.entries(TEMPLATES).map(([, f]) => h('button', { class: 'chip', onclick: () => save(f()) }, f().name))), file, ta,
      h('div', { class: 'btns' }, h('button', { class: 'btn solid', onclick: async () => { try { const x = fromXML(ta.value); await save(x); toast('Strategy saved'); } catch (e) { toast(e.message); } } }, 'Save strategy'),
        h('a', { class: 'btn ghost', href: 'classic.html#strategies' }, 'Test in the lab')));
    kids.push(load, eaCard);

    // guard rails
    const g = h('div', { class: 'card' }, h('h2', {}, 'Guard rails'), h('p', { class: 'mute small', style: { margin: '-6px 0 16px' } }, 'The bot checks these before every order. Each order also carries a stop loss held by your broker.'));
    const grid = h('div', { class: 'grid2' });
    GUARDS.forEach(([k, label, d, hint]) => {
      const i = h('input', { type: 'text', inputmode: 'decimal', value: String(B.getCfg(k, d)) });
      i.onchange = () => { const v = i.value.trim().replace(',', '.'); if (v !== '' && !isNaN(+v) && +v >= 0) B.setCfg(k, v); else { i.value = B.getCfg(k, d); toast('Enter a number'); } };
      grid.append(field(label, i, hint));
    });
    g.append(grid);
    kids.push(g);
    body.replaceChildren(...kids);
  }
  render();
  root.append(body);
  return { render: () => { try { strat = JSON.parse(B.getStrategy() || 'null'); } catch { strat = null; } render(); } };
}
