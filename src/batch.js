'use strict';
// Batch download: http://host/pictures/img*.jpg  with the asterisk replaced by numbers or letters.

function letters(n, width) {
  let s = '';
  for (let i = 0; i < width; i++) { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}
function lettersToNum(str) { let n = 0; for (const c of str.toLowerCase()) n = n * 26 + (c.charCodeAt(0) - 97); return n; }

/**
 * @param {{url:string, mode:'numbers'|'letters', from:number|string, to:number|string, width?:number, max?:number}} o
 * @returns {string[]}
 */
function expandBatch(o) {
  const star = o.url.indexOf('*');
  if (star < 0) throw Object.assign(new Error('The address must contain an asterisk (*) wildcard'), { status: 400 });
  const head = o.url.slice(0, star), tail = o.url.slice(star + 1);
  const max = o.max || 10000;
  const out = [];
  if (o.mode === 'letters') {
    const width = Math.max(1, Math.min(6, o.width || String(o.from).length || 1));
    const a = lettersToNum(String(o.from || 'a')), z = lettersToNum(String(o.to || 'z'));
    for (let n = a; n <= z; n++) { out.push(head + letters(n, width) + tail); if (out.length > max) break; }
  } else {
    const a = +o.from, z = +o.to;
    if (!Number.isInteger(a) || !Number.isInteger(z) || a < 0) throw Object.assign(new Error('Enter whole numbers for From / To'), { status: 400 });
    const width = Math.max(1, Math.min(10, o.width || String(z).length));
    for (let n = a; n <= z; n++) { out.push(head + String(n).padStart(width, '0') + tail); if (out.length > max) break; }
  }
  if (out.length > max) throw Object.assign(new Error(`Too many files (limit ${max})`), { status: 400 });
  return out;
}

module.exports = { expandBatch };
