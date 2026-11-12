// Small helper: set keys in the [Experts] section of MT5's common.ini, keeping its encoding (usually UTF-16).
export function patchSection(buf, section, kv) {
  const utf16 = buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE;
  let text = buf.length ? (utf16 ? buf.toString('utf16le') : buf.toString('utf8')) : '';
  text = text.replace(/^﻿/, '');
  const nl = text.includes('\r\n') || !text ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const head = `[${section}]`.toLowerCase();
  let start = lines.findIndex(l => l.trim().toLowerCase() === head);
  if (start < 0) { lines.push(`[${section}]`); start = lines.length - 1; }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[.*\]\s*$/.test(l));
  if (end < 0) end = lines.length;
  for (const [k, v] of Object.entries(kv)) {
    const re = new RegExp('^\\s*' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=', 'i');
    let hit = false;
    for (let i = start + 1; i < end; i++) if (re.test(lines[i])) { lines[i] = `${k}=${v}`; hit = true; break; }
    if (!hit) { lines.splice(end, 0, `${k}=${v}`); end++; }
  }
  const out = lines.join(nl) + nl;
  return utf16 ? Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(out, 'utf16le')]) : Buffer.from(out, 'utf8');
}
