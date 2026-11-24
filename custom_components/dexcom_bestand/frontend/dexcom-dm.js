// Dexcom-Karte – Data-Matrix-Leser (ECC 200) ohne fremde Bibliotheken
// Liest den GS1-Data-Matrix-Code vom Sensor-Etikett aus einem Foto, auch dort, wo der Browser
// keinen eingebauten Barcode-Leser hat (BarcodeDetector gibt es nur über https in Chrome/Android).
//
// Ablauf: Graubild → Bildpyramide → lokale Schwelle → Lücken schließen → zusammenhängende Flächen →
// fast quadratische Kandidaten → Eckpunkte → Lage/Größe über das Randmuster (L-Linie + Taktspur) →
// Ecken nachführen → Module abtasten → Codewörter (Platzierung nach ISO/IEC 16022) →
// Reed-Solomon-Korrektur → Text (ASCII, C40, Text, X12, EDIFACT, Base256, FNC1/GS1).
//
// Exporte: dmLesenRgba(daten, breite, hoehe, opt), dmLesenGrau(grau, breite, hoehe, opt)
//   → { text, gs1, zeilen, spalten, korrigiert, ecken } oder null
// Für Tests zusätzlich: rsKorrigieren, rsKodieren, dmMatrixLesen, dmTextDekodieren, dmPlatzierung, DM_GROESSEN

// ---------- GF(256) mit Primpolynom 0x12D ----------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x12d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const gdiv = (a, b) => (a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]);
const gpow = (a, n) => (n === 0 ? 1 : a === 0 ? 0 : EXP[(LOG[a] * n) % 255]);

function syndrome(r, nsym) {
  const S = new Array(nsym);
  let alleNull = true;
  for (let j = 0; j < nsym; j++) {
    const a = EXP[j + 1];
    let s = 0;
    for (let i = 0; i < r.length; i++) s = gmul(s, a) ^ r[i];
    S[j] = s;
    if (s) alleNull = false;
  }
  return alleNull ? null : S;
}

// Korrigiert r (Daten + Prüfwörter, erstes Element = höchste Potenz) an Ort und Stelle.
// Rückgabe: Anzahl korrigierter Fehler oder -1, wenn nicht korrigierbar.
export function rsKorrigieren(r, nsym) {
  const n = r.length;
  const S = syndrome(r, nsym);
  if (!S) return 0;
  // Berlekamp-Massey
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let k = 0; k < nsym; k++) {
    let d = S[k];
    for (let i = 1; i <= L; i++) d ^= gmul(C[i] || 0, S[k - i]);
    if (d === 0) {
      m++;
      continue;
    }
    const T = C.slice();
    const f = gdiv(d, b);
    while (C.length < B.length + m) C.push(0);
    for (let i = 0; i < B.length; i++) C[i + m] ^= gmul(f, B[i]);
    if (2 * L <= k) {
      L = k + 1 - L;
      B = T;
      b = d;
      m = 1;
    } else m++;
  }
  while (C.length > 1 && C[C.length - 1] === 0) C.pop();
  if (C.length - 1 !== L || 2 * L > nsym) return -1;
  // Chien-Suche
  const pos = [];
  for (let p = 0; p < n; p++) {
    const xi = EXP[(255 - (p % 255)) % 255];
    let v = 0;
    for (let i = C.length - 1; i >= 0; i--) v = gmul(v, xi) ^ C[i];
    if (v === 0) pos.push(p);
  }
  if (pos.length !== L) return -1;
  // Forney (erste Nullstelle alpha^1)
  const Om = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i++) for (let j = 0; j < C.length && i + j < nsym; j++) Om[i + j] ^= gmul(S[i], C[j]);
  for (const p of pos) {
    const xi = EXP[(255 - (p % 255)) % 255];
    let om = 0;
    for (let i = nsym - 1; i >= 0; i--) om = gmul(om, xi) ^ Om[i];
    let dv = 0;
    for (let i = 1; i < C.length; i += 2) dv ^= gmul(C[i], gpow(xi, i - 1));
    if (dv === 0) return -1;
    r[n - 1 - p] ^= gdiv(om, dv);
  }
  return syndrome(r, nsym) ? -1 : L;
}

export function rsKodieren(daten, nsym) {
  let g = [1];
  for (let i = 1; i <= nsym; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      ng[j] ^= g[j];
      ng[j + 1] ^= gmul(g[j], EXP[i]);
    }
    g = ng;
  }
  const rest = new Array(nsym).fill(0);
  for (const d of daten) {
    const f = d ^ rest[0];
    rest.shift();
    rest.push(0);
    if (f) for (let j = 0; j < nsym; j++) rest[j] ^= gmul(g[j + 1], f);
  }
  return rest;
}

// ---------- Symbolgrößen ----------
// [Zeilen, Spalten, Datenbereich-Zeilen, Datenbereich-Spalten, Datenwörter gesamt, Prüfwörter je Block, Blöcke]
export const DM_GROESSEN = [
  [10, 10, 8, 8, 3, 5, 1],
  [12, 12, 10, 10, 5, 7, 1],
  [14, 14, 12, 12, 8, 10, 1],
  [16, 16, 14, 14, 12, 12, 1],
  [18, 18, 16, 16, 18, 14, 1],
  [20, 20, 18, 18, 22, 18, 1],
  [22, 22, 20, 20, 30, 20, 1],
  [24, 24, 22, 22, 36, 24, 1],
  [26, 26, 24, 24, 44, 28, 1],
  [32, 32, 14, 14, 62, 36, 1],
  [36, 36, 16, 16, 86, 42, 1],
  [40, 40, 18, 18, 114, 48, 1],
  [44, 44, 20, 20, 144, 56, 1],
  [48, 48, 22, 22, 174, 68, 1],
  [52, 52, 24, 24, 204, 42, 2],
  [64, 64, 14, 14, 280, 56, 2],
  [8, 18, 6, 16, 5, 7, 1],
  [8, 32, 6, 14, 10, 11, 1],
  [12, 26, 10, 24, 16, 14, 1],
  [12, 36, 10, 16, 22, 18, 1],
  [16, 36, 14, 16, 32, 24, 1],
  [16, 48, 14, 22, 49, 28, 1],
];

// ---------- Platzierung der Codewörter (ISO/IEC 16022, Anhang F) ----------
const PLATZ = new Map();
export function dmPlatzierung(nrow, ncol) {
  const key = nrow * 1000 + ncol;
  if (PLATZ.has(key)) return PLATZ.get(key);
  const arr = new Int32Array(nrow * ncol);
  const modul = (row, col, chr, bit) => {
    if (row < 0) {
      row += nrow;
      col += 4 - ((nrow + 4) % 8);
    }
    if (col < 0) {
      col += ncol;
      row += 4 - ((ncol + 4) % 8);
    }
    if (row >= 0 && row < nrow && col >= 0 && col < ncol) arr[row * ncol + col] = 10 * chr + bit;
  };
  const utah = (row, col, chr) => {
    modul(row - 2, col - 2, chr, 1);
    modul(row - 2, col - 1, chr, 2);
    modul(row - 1, col - 2, chr, 3);
    modul(row - 1, col - 1, chr, 4);
    modul(row - 1, col, chr, 5);
    modul(row, col - 2, chr, 6);
    modul(row, col - 1, chr, 7);
    modul(row, col, chr, 8);
  };
  const ecke = (chr, liste) => liste.forEach(([r, c], i) => modul(r, c, chr, i + 1));
  let chr = 1;
  let row = 4;
  let col = 0;
  do {
    if (row === nrow && col === 0) ecke(chr++, [[nrow - 1, 0], [nrow - 1, 1], [nrow - 1, 2], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1], [2, ncol - 1], [3, ncol - 1]]);
    if (row === nrow - 2 && col === 0 && ncol % 4) ecke(chr++, [[nrow - 3, 0], [nrow - 2, 0], [nrow - 1, 0], [0, ncol - 4], [0, ncol - 3], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1]]);
    if (row === nrow - 2 && col === 0 && ncol % 8 === 4) ecke(chr++, [[nrow - 3, 0], [nrow - 2, 0], [nrow - 1, 0], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1], [2, ncol - 1], [3, ncol - 1]]);
    if (row === nrow + 4 && col === 2 && !(ncol % 8)) ecke(chr++, [[nrow - 1, 0], [nrow - 1, ncol - 1], [0, ncol - 3], [0, ncol - 2], [0, ncol - 1], [1, ncol - 3], [1, ncol - 2], [1, ncol - 1]]);
    do {
      if (row < nrow && row >= 0 && col >= 0 && col < ncol && !arr[row * ncol + col]) utah(row, col, chr++);
      row -= 2;
      col += 2;
    } while (row >= 0 && col < ncol);
    row += 1;
    col += 3;
    do {
      if (row >= 0 && row < nrow && col < ncol && col >= 0 && !arr[row * ncol + col]) utah(row, col, chr++);
      row += 2;
      col -= 2;
    } while (row < nrow && col >= 0);
    row += 3;
    col += 1;
  } while (row < nrow || col < ncol);
  const res = { arr, anzahl: chr - 1 };
  PLATZ.set(key, res);
  return res;
}

// ---------- Text aus den Datenwörtern ----------
const C40_SHIFT2 = "!\"#$%&'()*+,-./:;<=>?@[\\]^_";
const TEXT_SHIFT3 = "`ABCDEFGHIJKLMNOPQRSTUVWXYZ{|}~\u007f";

export function dmTextDekodieren(daten) {
  const b = daten;
  let byte = 0;
  let bit = 0;
  const verfuegbar = () => 8 * (b.length - byte) - bit;
  const lies = (n) => {
    let v = 0;
    for (let k = 0; k < n; k++) {
      v = (v << 1) | ((b[byte] >> (7 - bit)) & 1);
      if (++bit === 8) {
        bit = 0;
        byte++;
      }
    }
    return v;
  };
  let out = "";
  let nachspann = "";
  let gs1 = false;
  let hoch = false;
  const fnc1 = () => {
    if (out.length === 0) gs1 = true;
    else out += "\u001d";
  };
  const zeichen = (code) => {
    out += String.fromCharCode(code + (hoch ? 128 : 0));
    hoch = false;
  };
  const dreier = () => {
    const v = (lies(8) << 8) + lies(8) - 1;
    return [Math.floor(v / 1600), Math.floor((v % 1600) / 40), v % 40];
  };
  let modus = "ascii";
  let fertig = false;
  while (!fertig && verfuegbar() >= 8) {
    if (modus === "ascii") {
      const c = lies(8);
      if (c === 0) return null;
      if (c <= 128) zeichen(c - 1);
      else if (c === 129) fertig = true;
      else if (c <= 229) {
        const v = c - 130;
        out += (v < 10 ? "0" : "") + v;
      } else if (c === 230) modus = "c40";
      else if (c === 231) modus = "b256";
      else if (c === 232) fnc1();
      else if (c === 233 || c === 234) {
        // strukturierte Verkettung / Leserprogrammierung: ignorieren
      } else if (c === 235) hoch = true;
      else if (c === 236 || c === 237) {
        out += `[)>\u001e0${c === 236 ? 5 : 6}\u001d`;
        nachspann = "\u001e\u0004" + nachspann;
      } else if (c === 238) modus = "x12";
      else if (c === 239) modus = "text";
      else if (c === 240) modus = "edifact";
      else if (c === 241) {
        if (verfuegbar() < 8) return null;
        const e1 = lies(8);
        if (e1 > 127) {
          if (verfuegbar() < 8) return null;
          lies(8);
          if (e1 > 191) {
            if (verfuegbar() < 8) return null;
            lies(8);
          }
        }
      } else if (c === 254 && verfuegbar() === 0) {
        // manche Kodierer enden mit 254
      } else return null;
    } else if (modus === "c40" || modus === "text") {
      const istText = modus === "text";
      let shift = 0;
      let raus = false;
      while (!raus && verfuegbar() >= 16) {
        if (b[byte] === 254 && bit === 0) {
          lies(8);
          break;
        }
        for (const cv of dreier()) {
          if (shift === 0) {
            if (cv < 3) shift = cv + 1;
            else if (cv === 3) zeichen(32);
            else if (cv < 14) zeichen(48 + cv - 4);
            else if (cv < 40) zeichen((istText ? 97 : 65) + cv - 14);
            else return null;
          } else if (shift === 1) {
            zeichen(cv);
            shift = 0;
          } else if (shift === 2) {
            if (cv < 27) zeichen(C40_SHIFT2.charCodeAt(cv));
            else if (cv === 27) fnc1();
            else if (cv === 30) hoch = true;
            else return null;
            shift = 0;
          } else {
            if (istText) {
              if (cv >= 32) return null;
              zeichen(TEXT_SHIFT3.charCodeAt(cv));
            } else zeichen(cv + 96);
            shift = 0;
          }
        }
        if (verfuegbar() < 16) raus = true;
      }
      modus = "ascii";
    } else if (modus === "x12") {
      while (verfuegbar() >= 16) {
        if (b[byte] === 254 && bit === 0) {
          lies(8);
          break;
        }
        for (const cv of dreier()) {
          if (cv === 0) out += "\r";
          else if (cv === 1) out += "*";
          else if (cv === 2) out += ">";
          else if (cv === 3) out += " ";
          else if (cv < 14) out += String.fromCharCode(cv + 44);
          else if (cv < 40) out += String.fromCharCode(cv + 51);
          else return null;
        }
      }
      modus = "ascii";
    } else if (modus === "edifact") {
      let ende = false;
      while (!ende && verfuegbar() > 16) {
        for (let k = 0; k < 4 && verfuegbar() >= 6; k++) {
          let v = lies(6);
          if (v === 0x1f) {
            if (bit !== 0) lies(8 - bit);
            ende = true;
            break;
          }
          if (!(v & 0x20)) v |= 0x40;
          out += String.fromCharCode(v);
        }
      }
      if (bit !== 0) lies(8 - bit);
      modus = "ascii";
    } else if (modus === "b256") {
      let pos = 1 + byte;
      const unr = (v, p) => {
        const t = v - (((149 * p) % 255) + 1);
        return t >= 0 ? t : t + 256;
      };
      const d1 = unr(lies(8), pos++);
      let anzahl;
      if (d1 === 0) anzahl = Math.floor(verfuegbar() / 8);
      else if (d1 < 250) anzahl = d1;
      else {
        if (verfuegbar() < 8) return null;
        anzahl = 250 * (d1 - 249) + unr(lies(8), pos++);
      }
      for (let k = 0; k < anzahl; k++) {
        if (verfuegbar() < 8) return null;
        out += String.fromCharCode(unr(lies(8), pos++));
      }
      modus = "ascii";
    }
  }
  return { text: out + nachspann, gs1 };
}

// ---------- Modulmatrix → Text ----------
// bits: Uint8Array zeilen*spalten (1 = dunkel), Zeile 0 oben, Spalte 0 links (L-Linie links und unten)
export function dmMatrixLesen(bits, zeilen, spalten) {
  const g = DM_GROESSEN.find((x) => x[0] === zeilen && x[1] === spalten);
  if (!g) return null;
  const [, , drR, drC, nDaten, nEcc, nBl] = g;
  const regR = Math.floor(zeilen / drR);
  const regC = Math.floor(spalten / drC);
  const mr = regR * drR;
  const mc = regC * drC;
  const M = new Uint8Array(mr * mc);
  for (let a = 0; a < regR; a++)
    for (let c = 0; c < regC; c++)
      for (let i = 0; i < drR; i++)
        for (let j = 0; j < drC; j++) M[(a * drR + i) * mc + c * drC + j] = bits[(a * (drR + 2) + 1 + i) * spalten + c * (drC + 2) + 1 + j];
  const gesamt = nDaten + nEcc * nBl;
  const { arr, anzahl } = dmPlatzierung(mr, mc);
  if (anzahl !== gesamt) return null;
  const cw = new Array(gesamt).fill(0);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v > 0 && M[i]) cw[Math.floor(v / 10) - 1] |= 1 << (8 - (v % 10));
  }
  const bloecke = [];
  for (let k = 0; k < nBl; k++) bloecke.push([]);
  for (let i = 0; i < nDaten; i++) bloecke[i % nBl].push(cw[i]);
  for (let i = 0; i < nEcc * nBl; i++) bloecke[i % nBl].push(cw[nDaten + i]);
  let korrigiert = 0;
  for (const bl of bloecke) {
    const k = rsKorrigieren(bl, nEcc);
    if (k < 0) return null;
    korrigiert += k;
  }
  const daten = new Array(nDaten);
  for (let i = 0; i < nDaten; i++) daten[i] = bloecke[i % nBl][Math.floor(i / nBl)];
  const t = dmTextDekodieren(daten);
  if (!t) return null;
  return { text: t.text, gs1: t.gs1, zeilen, spalten, korrigiert };
}

// ---------- Bildverarbeitung ----------
function grauAusRgba(d, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return g;
}

function halbieren(g, w, h) {
  const nw = w >> 1;
  const nh = h >> 1;
  const o = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const a = 2 * y * w;
    const c = a + w;
    for (let x = 0; x < nw; x++) o[y * nw + x] = (g[a + 2 * x] + g[a + 2 * x + 1] + g[c + 2 * x] + g[c + 2 * x + 1] + 2) >> 2;
  }
  return { g: o, w: nw, h: nh };
}

function schwelle(g, w, h, fenster) {
  const W1 = w + 1;
  const I = new Uint32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) {
      s += g[y * w + x];
      I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + s;
    }
  }
  const r = fenster >> 1;
  const b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const mittel = (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
      b[y * w + x] = g[y * w + x] < mittel - Math.max(5, mittel * 0.06) ? 1 : 0;
    }
  }
  return b;
}

// wert 1: Dilatation (dunkel ausdehnen), wert 0: Erosion
function morph(b, w, h, r, wert) {
  const t = new Uint8Array(w * h);
  const o = new Uint8Array(w * h);
  const leer = wert ? 0 : 1;
  for (let y = 0; y < h; y++) {
    const z = y * w;
    for (let x = 0; x < w; x++) {
      let v = leer;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) {
          if (!wert) {
            v = 0;
            break;
          }
          continue;
        }
        if (b[z + xx] === wert) {
          v = wert;
          break;
        }
      }
      t[z + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = leer;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) {
          if (!wert) {
            v = 0;
            break;
          }
          continue;
        }
        if (t[yy * w + x] === wert) {
          v = wert;
          break;
        }
      }
      o[y * w + x] = v;
    }
  }
  return o;
}

function komponenten(b, w, h) {
  const lab = new Int32Array(w * h);
  const eltern = [0];
  const finde = (x) => {
    while (eltern[x] !== x) {
      eltern[x] = eltern[eltern[x]];
      x = eltern[x];
    }
    return x;
  };
  const vereine = (a, c) => {
    a = finde(a);
    c = finde(c);
    if (a !== c) {
      if (a < c) eltern[c] = a;
      else eltern[a] = c;
    }
  };
  let naechste = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!b[i]) continue;
      const l = x > 0 ? lab[i - 1] : 0;
      const o = y > 0 ? lab[i - w] : 0;
      const ol = y > 0 && x > 0 ? lab[i - w - 1] : 0;
      const or = y > 0 && x < w - 1 ? lab[i - w + 1] : 0;
      let m = 0;
      for (const v of [l, o, ol, or]) if (v && (!m || v < m)) m = v;
      if (!m) {
        eltern.push(naechste);
        lab[i] = naechste++;
      } else {
        lab[i] = m;
        if (l && l !== m) vereine(m, l);
        if (o && o !== m) vereine(m, o);
        if (ol && ol !== m) vereine(m, ol);
        if (or && or !== m) vereine(m, or);
      }
    }
  }
  const n = naechste;
  const anz = new Int32Array(n);
  const x0 = new Int32Array(n).fill(1e9);
  const x1 = new Int32Array(n).fill(-1);
  const y0 = new Int32Array(n).fill(1e9);
  const y1 = new Int32Array(n).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!lab[i]) continue;
      const r = finde(lab[i]);
      lab[i] = r;
      anz[r]++;
      if (x < x0[r]) x0[r] = x;
      if (x > x1[r]) x1[r] = x;
      if (y < y0[r]) y0[r] = y;
      if (y > y1[r]) y1[r] = y;
    }
  }
  return { lab, anz, x0, x1, y0, y1, n };
}

function huelle(punkte) {
  const p = punkte.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const kreuz = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const unten = [];
  for (const q of p) {
    while (unten.length >= 2 && kreuz(unten[unten.length - 2], unten[unten.length - 1], q) <= 0) unten.pop();
    unten.push(q);
  }
  const oben = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (oben.length >= 2 && kreuz(oben[oben.length - 2], oben[oben.length - 1], q) <= 0) oben.pop();
    oben.push(q);
  }
  oben.pop();
  unten.pop();
  return unten.concat(oben);
}

function flaeche(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

// kleinstes umschließendes Rechteck (Drehschieblehre über die Hüllkanten)
function minRechteck(h) {
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i];
    const b = h[(i + 1) % h.length];
    let ux = b[0] - a[0];
    let uy = b[1] - a[1];
    const len = Math.hypot(ux, uy);
    if (len < 1e-9) continue;
    ux /= len;
    uy /= len;
    let minU = 1e18;
    let maxU = -1e18;
    let minV = 1e18;
    let maxV = -1e18;
    for (const q of h) {
      const u = q[0] * ux + q[1] * uy;
      const v = -q[0] * uy + q[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const f = (maxU - minU) * (maxV - minV);
    if (!best || f < best.f) best = { f, ux, uy, minU, maxU, minV, maxV };
  }
  if (!best) return null;
  const { ux, uy, minU, maxU, minV, maxV } = best;
  const pkt = (u, v) => [u * ux - v * uy, u * uy + v * ux];
  return { f: best.f, ecken: [pkt(minU, minV), pkt(maxU, minV), pkt(maxU, maxV), pkt(minU, maxV)], a: maxU - minU, b: maxV - minV };
}

function kandidatenSuchen(e, faktor, radius, liste) {
  const { g, w, h } = e;
  const fenster = Math.max(15, Math.round(Math.max(w, h) / 24)) | 1;
  let b = schwelle(g, w, h, fenster);
  if (radius > 0) b = morph(morph(b, w, h, radius, 1), w, h, radius, 0);
  const k = komponenten(b, w, h);
  for (let r = 1; r < k.n; r++) {
    const n = k.anz[r];
    if (n < 60) continue;
    const bw = k.x1[r] - k.x0[r] + 1;
    const bh = k.y1[r] - k.y0[r] + 1;
    if (bw < 8 || bh < 8 || bw > 0.9 * w || bh > 0.9 * h) continue;
    if (n / (bw * bh) < 0.28) continue;
    const pkt = [];
    for (let y = k.y0[r]; y <= k.y1[r]; y++) {
      let xl = -1;
      let xr = -1;
      const z = y * w;
      for (let x = k.x0[r]; x <= k.x1[r]; x++) {
        if (k.lab[z + x] === r) {
          if (xl < 0) xl = x;
          xr = x;
        }
      }
      if (xl >= 0) pkt.push([xl, y], [xl, y + 1], [xr + 1, y], [xr + 1, y + 1]);
    }
    const hu = huelle(pkt);
    if (hu.length < 4) continue;
    const hf = Math.abs(flaeche(hu));
    if (n / hf < 0.5) continue;
    const re = minRechteck(hu);
    if (!re) continue;
    const kurz = Math.min(re.a, re.b);
    const lang = Math.max(re.a, re.b);
    if (kurz < 8 || lang / kurz > 4.2 || hf / re.f < 0.74) continue;
    const cx = (re.ecken[0][0] + re.ecken[2][0]) / 2;
    const cy = (re.ecken[0][1] + re.ecken[2][1]) / 2;
    // Ecken des Vierecks: Hüllpunkt, der in Richtung der Rechteckecke am weitesten außen liegt
    let quad = re.ecken.map(([ex, ey]) => {
      const dx = ex - cx;
      const dy = ey - cy;
      let bp = null;
      let bv = -1e18;
      for (const q of hu) {
        const v = (q[0] - cx) * dx + (q[1] - cy) * dy;
        if (v > bv) {
          bv = v;
          bp = q;
        }
      }
      return { x: bp[0] * faktor, y: bp[1] * faktor };
    });
    if (flaeche(quad.map((q) => [q.x, q.y])) < 0) quad = [quad[0], quad[3], quad[2], quad[1]];
    liste.push({ quad, cx: cx * faktor, cy: cy * faktor, groesse: lang * faktor, quadratisch: lang / kurz < 1.35 });
  }
}

// ---------- Abtasten ----------
function abbildung(p) {
  // p: [TL, TR, BR, BL]; (u,v) ∈ [0,1]²: (0,0)→TL, (1,0)→TR, (1,1)→BR, (0,1)→BL
  const [p0, p1, p2, p3] = p;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0;
  let hh = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const dx1 = p1.x - p2.x;
    const dx2 = p3.x - p2.x;
    const dy1 = p1.y - p2.y;
    const dy2 = p3.y - p2.y;
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-12) return null;
    g = (sx * dy2 - dx2 * sy) / den;
    hh = (dx1 * sy - sx * dy1) / den;
  }
  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + hh * p3.x;
  const c = p0.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + hh * p3.y;
  const f = p0.y;
  return (u, v) => {
    const z = g * u + hh * v + 1;
    return [(a * u + b * v + c) / z, (d * u + e * v + f) / z];
  };
}

function hol(G, w, h, x, y) {
  let fx = x - 0.5;
  let fy = y - 0.5;
  if (fx < 0) fx = 0;
  if (fy < 0) fy = 0;
  if (fx > w - 1.001) fx = w - 1.001;
  if (fy > h - 1.001) fy = h - 1.001;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const ax = fx - x0;
  const ay = fy - y0;
  const i = y0 * w + x0;
  return (G[i] * (1 - ax) + G[i + 1] * ax) * (1 - ay) + (G[i + w] * (1 - ax) + G[i + w + 1] * ax) * ay;
}

function modulWert(G, w, h, abb, zeilen, spalten, r, c, schnell) {
  if (schnell) {
    const q = abb((c + 0.5) / spalten, (r + 0.5) / zeilen);
    return hol(G, w, h, q[0], q[1]);
  }
  const d = 0.22;
  let s = 0;
  const u = (c + 0.5) / spalten;
  const v = (r + 0.5) / zeilen;
  const du = d / spalten;
  const dv = d / zeilen;
  let p = abb(u, v);
  s += 2 * hol(G, w, h, p[0], p[1]);
  p = abb(u - du, v);
  s += hol(G, w, h, p[0], p[1]);
  p = abb(u + du, v);
  s += hol(G, w, h, p[0], p[1]);
  p = abb(u, v - dv);
  s += hol(G, w, h, p[0], p[1]);
  p = abb(u, v + dv);
  s += hol(G, w, h, p[0], p[1]);
  return s / 6;
}

// Randmuster: links und unten durchgehend dunkel, oben und rechts abwechselnd (oben links dunkel, unten rechts dunkel),
// außen eine helle Ruhezone
const RAND_CACHE = new Map();
function randListe(zeilen, spalten, mitRuhezone, teil) {
  const key = `${zeilen}x${spalten}${mitRuhezone ? "r" : ""}${teil ? "t" : ""}`;
  if (RAND_CACHE.has(key)) return RAND_CACHE.get(key);
  const l = [];
  const cMax = teil ? Math.ceil(spalten * 0.6) : spalten;
  const rMin = teil ? Math.floor(zeilen * 0.4) : 1;
  for (let c = 0; c < cMax; c++) l.push([0, c, c % 2 === 0 ? 1 : 0]);
  for (let r = Math.max(1, rMin); r < zeilen; r++) l.push([r, spalten - 1, (zeilen - 1 - r) % 2 === 0 ? 1 : 0]);
  for (let r = 0; r < zeilen; r++) l.push([r, 0, 1]);
  for (let c = 1; c < spalten - 1; c++) l.push([zeilen - 1, c, 1]);
  if (mitRuhezone) {
    for (let c = 0; c < spalten; c++) {
      l.push([-1, c, 0]);
      l.push([zeilen, c, 0]);
    }
    for (let r = 0; r < zeilen; r++) {
      l.push([r, -1, 0]);
      l.push([r, spalten, 0]);
    }
  }
  RAND_CACHE.set(key, l);
  return l;
}

function randWertung(G, w, h, ecken, zeilen, spalten, mitRuhezone, teil, schnell) {
  const abb = abbildung(ecken);
  if (!abb) return null;
  const liste = randListe(zeilen, spalten, mitRuhezone, teil);
  let sD = 0;
  let nD = 0;
  let sL = 0;
  let nL = 0;
  let sTd = 0;
  let nTd = 0;
  const werte = [];
  for (const [r, c, dunkel] of liste) {
    const v = modulWert(G, w, h, abb, zeilen, spalten, r, c, schnell);
    werte.push(v);
    if (dunkel) {
      sD += v;
      nD++;
      if (r === 0 || c === spalten - 1) {
        sTd += v;
        nTd++;
      }
    } else {
      sL += v;
      nL++;
    }
  }
  const dunkel = sD / nD;
  const hell = sL / nL;
  const takt = nTd ? sTd / nTd : dunkel;
  const T = (dunkel + hell) / 2;
  let treffer = 0;
  let i = 0;
  let summe = 0;
  for (const [, , d] of liste) {
    const v = werte[i++];
    if ((v < T) === !!d) treffer++;
    summe += d ? T - v : v - T;
  }
  return { kontrast: Math.min(hell - dunkel, hell - takt), treffer: treffer / werte.length, summe, dunkel, hell };
}

const abst = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Wie sehr sehen die Seiten TL–BL und BL–BR wie die durchgehende L-Linie aus? (innen dunkel und gleichmäßig, außen hell)
function lageWertung(G, w, h, TL, BL, BR) {
  const mx = (TL.x + BR.x) / 2;
  const my = (TL.y + BR.y) / 2;
  const innen = [];
  let sA = 0;
  let nA = 0;
  for (const [A, B, quer] of [[TL, BL, abst(BL, BR)], [BL, BR, abst(TL, BL)]]) {
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return -1;
    let nx = -dy / len;
    let ny = dx / len;
    if (nx * ((A.x + B.x) / 2 - mx) + ny * ((A.y + B.y) / 2 - my) < 0) {
      nx = -nx;
      ny = -ny;
    }
    for (let k = 1; k < 24; k++) {
      const t = 0.04 + (0.92 * k) / 24;
      const x = A.x + dx * t;
      const y = A.y + dy * t;
      const i1 = hol(G, w, h, x - nx * quer * 0.012, y - ny * quer * 0.012);
      const i2 = hol(G, w, h, x - nx * quer * 0.022, y - ny * quer * 0.022);
      innen.push(Math.min(i1, i2));
      sA += hol(G, w, h, x + nx * quer * 0.035, y + ny * quer * 0.035);
      nA++;
    }
  }
  const mi = innen.reduce((x, y) => x + y, 0) / innen.length;
  const sd = Math.sqrt(innen.reduce((x, y) => x + (y - mi) * (y - mi), 0) / innen.length);
  const ma = sA / nA;
  return (ma - mi - sd) / Math.max(20, ma);
}

// Taktspuren oben/rechts und die Ruhezone dahinter; Schwelle T fest
const TAKT_CACHE = new Map();
function taktListe(zeilen, spalten) {
  const key = zeilen * 1000 + spalten;
  if (TAKT_CACHE.has(key)) return TAKT_CACHE.get(key);
  const l = [];
  for (let c = 0; c < spalten; c++) l.push([0, c, c % 2 === 0 ? 1 : 0]);
  for (let r = 1; r < zeilen; r++) l.push([r, spalten - 1, (zeilen - 1 - r) % 2 === 0 ? 1 : 0]);
  for (let c = -1; c <= spalten; c++) l.push([-1, c, 0]);
  for (let r = 0; r <= zeilen; r++) l.push([r, spalten, 0]);
  TAKT_CACHE.set(key, l);
  return l;
}

// Wertung: Kontrast zwischen hellen und dunklen Taktmodulen (bei falscher Größe ~0), Abzug, wenn die Ruhezone nicht hell ist
function taktWertung(G, w, h, ecken, zeilen, spalten, T, spanne) {
  const abb = abbildung(ecken);
  if (!abb) return -1e9;
  let sD = 0;
  let nD = 0;
  let sL = 0;
  let nL = 0;
  let strafe = 0;
  let nR = 0;
  let treffer = 0;
  for (const [r, c, d] of taktListe(zeilen, spalten)) {
    const q = abb((c + 0.5) / spalten, (r + 0.5) / zeilen);
    const v = hol(G, w, h, q[0], q[1]);
    if (r < 0 || c >= spalten) {
      if (v < T) strafe += T - v;
      nR++;
    } else {
      if ((v < T) === !!d) treffer++;
      if (d) {
        sD += v;
        nD++;
      } else {
        sL += v;
        nL++;
      }
    }
  }
  const q = treffer / (nD + nL);
  return ((sL / nL - sD / nD - strafe / nR) / spanne) * q * q;
}

// Ecke oben rechts (zwischen den Taktspuren) bei festen L-Ecken per Rastersuche bestimmen
function trSuchen(G, w, h, L, starts, zeilen, spalten, modul) {
  const { TL, BL, BR } = L;
  const e1 = { x: (BR.x - BL.x) / abst(BR, BL), y: (BR.y - BL.y) / abst(BR, BL) };
  const e2 = { x: (TL.x - BL.x) / abst(TL, BL), y: (TL.y - BL.y) / abst(TL, BL) };
  // Schwelle aus L-Linie (dunkel) und Ruhezone außen davor (hell)
  const abb0 = abbildung([TL, starts[starts.length - 1], BR, BL]);
  if (!abb0) return null;
  let sD = 0;
  let nD = 0;
  let sL = 0;
  let nL = 0;
  for (let r = 0; r < zeilen; r++) {
    sD += modulWert(G, w, h, abb0, zeilen, spalten, r, 0, true);
    sL += modulWert(G, w, h, abb0, zeilen, spalten, r, -1, true);
    nD++;
    nL++;
  }
  for (let c = 0; c < spalten; c++) {
    sD += modulWert(G, w, h, abb0, zeilen, spalten, zeilen - 1, c, true);
    sL += modulWert(G, w, h, abb0, zeilen, spalten, zeilen, c, true);
    nD++;
    nL++;
  }
  const dunkel = sD / nD;
  const hell = sL / nL;
  if (hell - dunkel < 8) return null;
  const T = (dunkel + hell) / 2;
  let best = null;
  const probier = (P) => {
    const v = taktWertung(G, w, h, [TL, P, BR, BL], zeilen, spalten, T, hell - dunkel);
    if (!best || v > best.v) best = { v, P };
  };
  const seite = Math.max(abst(BR, BL), abst(TL, BL));
  const R = Math.min(3 * modul, 0.1 * seite + modul);
  const grob = R / 3;
  for (const st of starts)
    for (let i = -3; i <= 3; i++)
      for (let j = -3; j <= 3; j++) probier({ x: st.x + (i * e1.x + j * e2.x) * grob, y: st.y + (i * e1.y + j * e2.y) * grob });
  for (const schritt of [grob / 2.5, grob / 6]) {
    const m = best.P;
    for (let i = -2; i <= 2; i++)
      for (let j = -2; j <= 2; j++) if (i || j) probier({ x: m.x + (i * e1.x + j * e2.x) * schritt, y: m.y + (i * e1.y + j * e2.y) * schritt });
  }
  return { TR: best.P, wert: best.v };
}

function hypothesen(G, w, h, quad) {
  const lagen = [];
  for (let k = 0; k < 4; k++) {
    const BL = quad[k];
    const A0 = quad[(k + 1) % 4];
    const B0 = quad[(k + 3) % 4];
    const G0 = quad[(k + 2) % 4];
    // eine falsche Ecke (Fläche mit Hintergrund verschmolzen oder abgeschnitten) per Parallelogramm ersetzen
    let beste = null;
    for (const [A, B] of [[A0, B0], [{ x: BL.x + G0.x - B0.x, y: BL.y + G0.y - B0.y }, B0], [A0, { x: BL.x + G0.x - A0.x, y: BL.y + G0.y - A0.y }]]) {
      const lw = lageWertung(G, w, h, A, BL, B);
      if (!beste || lw > beste.lw + 0.02) beste = { A, B, lw };
    }
    const { A, B, lw } = beste;
    lagen.push({ TL: A, BL, BR: B, TR: G0, lw, gesp: false });
    lagen.push({ TL: B, BL, BR: A, TR: G0, lw, gesp: true });
  }
  lagen.sort((a, b) => b.lw - a.lw || (a.gesp ? 1 : 0) - (b.gesp ? 1 : 0));
  const erg = [];
  for (const L of lagen.slice(0, 4)) {
    const unten = abst(L.BL, L.BR);
    const links = abst(L.TL, L.BL);
    const TR2 = { x: L.TL.x + L.BR.x - L.BL.x, y: L.TL.y + L.BR.y - L.BL.y };
    for (const [zeilen, spalten] of DM_GROESSEN) {
      const verh = unten / links / (spalten / zeilen);
      if (verh < 0.7 || verh > 1.43) continue;
      const modul = Math.min(unten / spalten, links / zeilen);
      if (modul < 1.6) continue;
      const starts = abst(L.TR, TR2) > 0.5 * modul ? [L.TR, TR2] : [TR2];
      const r = trSuchen(G, w, h, L, starts, zeilen, spalten, modul);
      if (!r) continue;
      erg.push({ ecken: [L.TL, r.TR, L.BR, L.BL], zeilen, spalten, modul, wert: r.wert, lw: L.lw, gesp: L.gesp });
    }
  }
  erg.sort((a, b) => b.wert - a.wert);
  return erg;
}

function eckenVerfeinern(G, w, h, hyp) {
  let ecken = hyp.ecken.map((p) => ({ x: p.x, y: p.y }));
  let schnell = true;
  const wert = (e) => {
    const r = randWertung(G, w, h, e, hyp.zeilen, hyp.spalten, true, false, schnell);
    return r ? r.summe : -1e18;
  };
  let bester = wert(ecken);
  const richtungen = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (const schritt of [0.4, 0.2, 0.1]) {
    if (schritt === 0.1) {
      schnell = false;
      bester = wert(ecken);
    }
    const s = schritt * hyp.modul;
    for (let runde = 0; runde < 8; runde++) {
      let besser = false;
      for (let i = 0; i < 4; i++) {
        for (const [dx, dy] of richtungen) {
          const versuch = ecken.slice();
          versuch[i] = { x: ecken[i].x + dx * s, y: ecken[i].y + dy * s };
          const v = wert(versuch);
          if (v > bester + 1e-6) {
            bester = v;
            ecken = versuch;
            besser = true;
          }
        }
      }
      if (!besser) break;
    }
  }
  return ecken;
}

function otsu(werte) {
  const hist = new Array(256).fill(0);
  for (const v of werte) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  const n = werte.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const zw = wB * wF * (mB - mF) * (mB - mF);
    if (zw > best) {
      best = zw;
      t = i + 0.5;
    }
  }
  return t;
}

// lineare Ebene v = a + b*r + c*s per kleinste Quadrate
function ebene(punkte) {
  let n = 0;
  let sr = 0;
  let sc = 0;
  let sv = 0;
  let srr = 0;
  let scc = 0;
  let src = 0;
  let srv = 0;
  let scv = 0;
  for (const [r, c, v] of punkte) {
    n++;
    sr += r;
    sc += c;
    sv += v;
    srr += r * r;
    scc += c * c;
    src += r * c;
    srv += r * v;
    scv += c * v;
  }
  const A = [
    [n, sr, sc],
    [sr, srr, src],
    [sc, src, scc],
  ];
  const B = [sv, srv, scv];
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-9) return () => sv / Math.max(1, n);
  const loese = (k) => det(A.map((row, i) => row.map((x, j) => (j === k ? B[i] : x)))) / D;
  const a = loese(0);
  const b = loese(1);
  const c = loese(2);
  return (r, s) => a + b * r + c * s;
}

function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

// Unschärfe herausrechnen: jedes Modul trägt mit Gauß-Gewichten zu den Nachbarn bei;
// Werte werden iterativ entfaltet (Nachbarn = aktuelle Schätzung, außerhalb des Symbols hell)
function entfalten(werte, zeilen, spalten, D, L, sigma) {
  const phi = (x) => 0.5 * (1 + erf(x / (sigma * Math.SQRT2)));
  const w1 = [phi(0.5) - phi(-0.5), phi(1.5) - phi(0.5), phi(2.5) - phi(1.5)];
  const nb = [];
  let summe = 0;
  for (let dr = -2; dr <= 2; dr++)
    for (let dc = -2; dc <= 2; dc++) {
      const gw = w1[Math.abs(dr)] * w1[Math.abs(dc)];
      summe += gw;
      if (dr || dc) nb.push([dr, dc, gw]);
    }
  const w0 = (w1[0] * w1[0]) / summe;
  for (const e of nb) e[2] /= summe;
  const n = zeilen * spalten;
  const rel = new Float32Array(n);
  const x = new Float32Array(n);
  for (let r = 0; r < zeilen; r++)
    for (let c = 0; c < spalten; c++) {
      const i = r * spalten + c;
      const d = D(r, c);
      const l = L(r, c);
      rel[i] = (werte[i] - d) / Math.max(4, l - d);
      x[i] = rel[i] > 0.5 ? 1 : 0;
    }
  for (let it = 0; it < 6; it++) {
    let geaendert = 0;
    for (let r = 0; r < zeilen; r++)
      for (let c = 0; c < spalten; c++) {
        let s = 0;
        for (const [dr, dc, gw] of nb) {
          const rr = r + dr;
          const cc = c + dc;
          s += gw * (rr < 0 || rr >= zeilen || cc < 0 || cc >= spalten ? 1 : x[rr * spalten + cc]);
        }
        const i = r * spalten + c;
        const neu = (rel[i] - s) / w0 > 0.5 ? 1 : 0;
        if (neu !== x[i]) {
          x[i] = neu;
          geaendert++;
        }
      }
    if (!geaendert) break;
  }
  const bits = new Uint8Array(n);
  for (let i = 0; i < n; i++) bits[i] = x[i] ? 0 : 1;
  return bits;
}

function symbolLesen(G, w, h, ecken, zeilen, spalten) {
  const abb = abbildung(ecken);
  if (!abb) return null;
  const n = zeilen * spalten;
  const werte = new Float32Array(n);
  for (let r = 0; r < zeilen; r++) for (let c = 0; c < spalten; c++) werte[r * spalten + c] = modulWert(G, w, h, abb, zeilen, spalten, r, c);
  const dunkelPkt = [];
  const hellPkt = [];
  for (const [r, c, d] of randListe(zeilen, spalten, false)) (d ? dunkelPkt : hellPkt).push([r, c, werte[r * spalten + c]]);
  const D = ebene(dunkelPkt);
  const L = ebene(hellPkt);
  const tGlobal = otsu(Array.from(werte));
  // lokales Mittel über 7×7 Module
  const lokal = new Float32Array(n);
  for (let r = 0; r < zeilen; r++)
    for (let c = 0; c < spalten; c++) {
      let s = 0;
      let k = 0;
      for (let rr = Math.max(0, r - 3); rr <= Math.min(zeilen - 1, r + 3); rr++)
        for (let cc = Math.max(0, c - 3); cc <= Math.min(spalten - 1, c + 3); cc++) {
          s += werte[rr * spalten + cc];
          k++;
        }
      lokal[r * spalten + c] = s / k;
    }
  const verfahren = [
    (r, c) => (D(r, c) + L(r, c)) / 2,
    () => tGlobal,
    (r, c) => ((D(r, c) + L(r, c)) / 2 + lokal[r * spalten + c]) / 2,
    (r, c) => (D(r, c) + L(r, c)) / 2 - 0.1 * (L(r, c) - D(r, c)),
    (r, c) => (D(r, c) + L(r, c)) / 2 + 0.1 * (L(r, c) - D(r, c)),
  ];
  const bits = new Uint8Array(n);
  for (const T of verfahren) {
    for (let r = 0; r < zeilen; r++) for (let c = 0; c < spalten; c++) bits[r * spalten + c] = werte[r * spalten + c] < T(r, c) ? 1 : 0;
    const res = dmMatrixLesen(bits, zeilen, spalten);
    if (res) return res;
  }
  // unscharfes Foto: Entfaltung mit geschätzter Unschärfe
  for (const sigma of [0.35, 0.5, 0.65, 0.8]) {
    const res = dmMatrixLesen(entfalten(werte, zeilen, spalten, D, L, sigma), zeilen, spalten);
    if (res) {
      res.entfaltet = sigma;
      return res;
    }
  }
  return null;
}

function kandidatLesen(G, w, h, kand, frist) {
  const hyps = hypothesen(G, w, h, kand.quad).slice(0, 8);
  for (const hyp of hyps) {
    if (Date.now() > frist) return null;
    if (hyp.wert < 0.08) break;
    const ecken = eckenVerfeinern(G, w, h, hyp);
    const wr = randWertung(G, w, h, ecken, hyp.zeilen, hyp.spalten, true, false, false);
    if (!wr || wr.treffer < 0.75) continue;
    const res = symbolLesen(G, w, h, ecken, hyp.zeilen, hyp.spalten);
    if (res) {
      res.ecken = ecken.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
      return res;
    }
  }
  return null;
}

export function dmLesenGrau(G, w, h, opt = {}) {
  const frist = Date.now() + (opt.zeitMax || 4000);
  const ebenen = [{ g: G, w, h, f: 1 }];
  while (Math.max(ebenen[ebenen.length - 1].w, ebenen[ebenen.length - 1].h) > 240) {
    const e = ebenen[ebenen.length - 1];
    const n = halbieren(e.g, e.w, e.h);
    ebenen.push({ ...n, f: e.f * 2 });
  }
  const kand = [];
  for (const e of ebenen) {
    const m = Math.max(e.w, e.h);
    if (m > 1300 || m < 120) continue;
    for (const radius of [1, 2]) kandidatenSuchen(e, e.f, radius, kand);
  }
  // doppelte Kandidaten zusammenfassen, Wertung über das Randmuster
  const bewertet = [];
  for (const k of kand) {
    if (bewertet.some((b) => Math.hypot(b.cx - k.cx, b.cy - k.cy) < 0.15 * Math.max(b.groesse, k.groesse) && Math.abs(b.groesse - k.groesse) < 0.25 * Math.max(b.groesse, k.groesse))) continue;
    let lw = -1;
    for (let j = 0; j < 4; j++) lw = Math.max(lw, lageWertung(G, w, h, k.quad[(j + 1) % 4], k.quad[j], k.quad[(j + 3) % 4]));
    if (lw < 0.08) continue;
    k.wertung = lw + (k.quadratisch ? 0.05 : 0);
    bewertet.push(k);
  }
  bewertet.sort((a, b) => b.wertung - a.wertung);
  if (opt.debug) opt.debug.kandidaten = bewertet;
  for (const k of bewertet) {
    if (Date.now() > frist) break;
    const res = kandidatLesen(G, w, h, k, frist);
    if (res) return res;
  }
  return null;
}

// nur für Tests
export const _dmIntern = { hypothesen, eckenVerfeinern, symbolLesen, randWertung, kandidatLesen, lageWertung, trSuchen };

export function dmLesenRgba(daten, w, h, opt = {}) {
  return dmLesenGrau(grauAusRgba(daten, w, h), w, h, opt);
}
