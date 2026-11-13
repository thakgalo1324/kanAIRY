// Headless strategy runner. The Kanairy service loads this page invisibly and asks it
// whether the active Strategy lab rules fire on the candles read from the MT5 screen.
import { signalAt, validate } from './strategy.js';
import { compute } from './indicators.js';

window.__eval = (csJson, stratJson) => {
  try {
    const cs = JSON.parse(csJson), s = JSON.parse(stratJson);
    const errs = validate(s); if (errs.length) return JSON.stringify({ error: errs[0] });
    const i = cs.length - 1;
    const sig = signalAt(s, cs, i);
    const atr = compute({ id: 'atr', params: { period: s.risk.atrPeriod || 14 } }, cs).series[0].values[i];
    return JSON.stringify({ ...sig, atr: atr === atr ? atr : null, lots: s.risk.lots, slAtr: s.risk.slAtr || null, tpAtr: s.risk.tpAtr || null, trail: s.risk.trail || null, name: s.name });
  } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
};
window.__engineReady = true;
