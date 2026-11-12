// Candle history for the Strategy lab backtester.
import { api } from './api.js';
import { S, emit } from './state.js';

export async function loadInstruments() {
  const { instruments } = await api.pubInstruments();
  S.instruments = instruments; emit('instruments');
}
export async function candles(symbol, tf, limit = 500) { return (await api.pubCandles(symbol, tf, limit)).candles; }
