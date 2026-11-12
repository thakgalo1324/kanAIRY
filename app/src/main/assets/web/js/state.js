// App state, persistence and a tiny event bus.
import { store } from './util.js';

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => { bus.addEventListener(name, e => fn(e.detail)); };

export const S = {
  instruments: [],
  symbol: store.get('symbol', 'EURUSD'),
  settings: { theme: 'light', colorblind: false, ...store.get('settings', {}) },
};
export const inst = sym => S.instruments.find(i => i.symbol === sym);
export function persist() { store.set('symbol', S.symbol); store.set('settings', S.settings); }

export const TFS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN'];
export const TF_SEC = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400, W1: 604800, MN: 2592000 };
