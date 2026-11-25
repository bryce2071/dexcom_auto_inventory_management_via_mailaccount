/*
 * Dexcom-Karte (custom:dexcom-karte) – Bestand, Sensoren, Lieferungen und Reklamationen.
 * Daten und Logik: Integration „Dexcom Sensorbestand“ (Dienste dexcom_bestand.*); läuft auch noch mit
 * der früheren Pyscript-Fassung (Dienste pyscript.dexcom_*). Enthält zusätzlich das Element
 * „dexcom-panel“ für den Eintrag in der Seitenleiste.
 *
 * - Oben: aktueller Sensor (Modell, Tag x von 10, Restzeit, Ende), Kacheln Bestand / Lieferung /
 *   Reklamationen / Folgerezept, Hinweise
 * - Sensoren: jeder gesetzte Sensor mit LOT und Laufzeit; antippen = Details, Reklamieren, Ersatz erhalten,
 *   Bearbeiten, Löschen. „Neuer Sensor“ öffnet die Kamera: der GS1-Data-Matrix-Code auf dem Etikett wird
 *   im Gerät gelesen (BarcodeDetector über https, sonst eigener Leser dexcom-dm.js) und füllt GTIN, REF/PN,
 *   LOT, Herstell- und Verfallsdatum, ggf. SN; das Foto wird in HA gespeichert (Dienst „foto“) und nach
 *   7 Tagen gelöscht
 * - Lieferungen: nächste (angekündigt/überfällig), Quartalspakete, Ersatz, Webshop, DHL-Verlauf;
 *   Art, Anzahl, Modell und Zustellung korrigieren, Lieferung von Hand eintragen
 * - Reklamationen: Support-Fälle aus den Mails und Reklamationen aus der Karte mit Ersatz-Status
 * - Daten über den Dienst „liste“; lädt neu, wenn sich sensor.dexcom_bestand (Attribut version) ändert
 *
 * Konfiguration (alles optional außer type):
 *   type: custom:dexcom-karte
 *   titel: ""
 *   tab: sensoren | lieferungen | reklamationen
 */
const DXK_VERSION = "1.2.4";
const WT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const NB = " ";
const TABS = [
  ["sensoren", "Sensoren"],
  ["lieferungen", "Lieferungen"],
  ["reklamationen", "Reklamationen"],
];
const STANDARD = { titel: "", tab: "sensoren", sensor: "sensor.dexcom_bestand" };
export const ART_NAME = {
  quartal: "Quartalslieferung",
  ersatz: "Ersatzsensor",
  shop: "Webshop",
  unbekannt: "Sendung (Inhalt unklar)",
  sonstige: "Sonstige Lieferung",
};
export const LIEF_STATUS = {
  bestellt: "bestellt",
  versendet: "versendet",
  unterwegs: "unterwegs",
  heute: "kommt heute",
  verzoegert: "verspätet",
  abholbereit: "abholbereit",
  zurueck: "zurück an Dexcom",
  zugestellt: "zugestellt",
  offen: "offen",
};
export const FALL_STATUS = {
  offen: "noch keine Antwort",
  zugesagt: "Ersatz zugesagt",
  unterwegs: "Ersatz unterwegs",
  erhalten: "Ersatz erhalten",
  abgelehnt: "kein Ersatz",
  erledigt: "abgeschlossen",
};
const FALL_KURZ = { offen: "ohne Antwort", zugesagt: "zugesagt", unterwegs: "Ersatz unterwegs", erhalten: "Ersatz erhalten", abgelehnt: "abgelehnt", erledigt: "erledigt" };
const GRUENDE = ["Sensorfehler", "Signalverlust", "Aufwärmen fehlgeschlagen", "Ungenaue Werte", "Pflaster gelöst", "Applikator defekt"];
const MELDEN = [
  ["wechsel", "Sensorwechsel fällig", "kurz vor Ablauf des aktuellen Sensors"],
  ["neu_erkannt", "Neuer Sensor erkannt", "mit Erinnerung ans Etikett-Foto"],
  ["lieferung", "Lieferung überfällig / Bestand knapp", "9–21 Uhr, höchstens alle 3 Tage"],
  ["ersatz", "Ersatz fehlt", "nach einer Reklamation ohne Ersatzpaket"],
  ["rezept", "Folgerezept fällig", "vor dem Termin aus der Dexcom-Mail"],
  ["transmitter", "Transmitter wechseln (G6)", "vor dem letzten Sensorstart mit dem alten und wenn keiner mehr da ist"],
];
const GRUENDE_TX = ["Transmitterfehler", "Koppeln nicht möglich", "Signalverlust", "Batterie vorzeitig leer", "Beschädigt"];
const MODELL_GTIN = { "00386270000927": "G6" };
// Transmitter-Verpackungen (GTIN) – REF/PN beginnt bei Transmittern mit „STT-“, bei Sensoren mit „STS-“
const TX_GTIN = { "00386270003072": "G6" };
const GS = "\u001d";
// GS1-Datenbezeichner auf Dexcom-Etiketten: feste Länge bzw. variabel (bis max. Zeichen)
const GS1_FEST = { "01": 14, "02": 14, "11": 6, "17": 6 };
const GS1_VAR = { "10": 20, "21": 20, "240": 30, "241": 30, "710": 20, "711": 20, "712": 20, "713": 20, "714": 20, "715": 20 };
const TEL_KUNDE = "08007246447";
const TEL_TECHNIK = "08007246449";

// ---------- reine Hilfsfunktionen (ohne DOM, in Node testbar) ----------

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// Datum/Uhrzeit eines ISO-Werts in der Zeitzone von Home Assistant
export function teile(iso, tz) {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const p = {};
    const f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz || undefined, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
    });
    for (const x of f.formatToParts(d)) p[x.type] = x.value;
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
    return { j: p.year, m: p.month, t: p.day, h: p.hour === "24" ? "00" : p.hour, min: p.minute, wd: wd < 0 ? d.getDay() : wd };
  } catch (e) {
    return { j: String(d.getFullYear()), m: pad(d.getMonth() + 1), t: pad(d.getDate()), h: pad(d.getHours()), min: pad(d.getMinutes()), wd: d.getDay() };
  }
}

export function heuteIn(tz, date = new Date()) {
  const p = teile(date, tz);
  return p ? `${p.j}-${p.m}-${p.t}` : "";
}

function tagIso(p) {
  return `${p.j}-${p.m}-${p.t}`;
}

function plusTage(isoTag, n) {
  const [j, m, t] = isoTag.split("-").map(Number);
  const d = new Date(Date.UTC(j, m - 1, t + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// „01.03.2026“ – auch für reine Datumswerte „2026-03-01“
export function datumText(iso, tz, mitJahr = true) {
  if (!iso) return "–";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [j, m, t] = iso.split("-");
    return mitJahr ? `${t}.${m}.${j}` : `${t}.${m}.`;
  }
  const p = teile(iso, tz);
  if (!p) return "–";
  return mitJahr ? `${p.t}.${p.m}.${p.j}` : `${p.t}.${p.m}.`;
}

export function zeitText(iso, tz) {
  const p = teile(iso, tz);
  return p ? `${p.h}:${p.min}` : "";
}

// „heute 20:45“, „morgen 18:45“, „Di 01.12. 20:45“
export function tagZeit(iso, tz, heute, mitZeit = true) {
  const p = teile(iso, tz);
  if (!p) return "–";
  const tag = tagIso(p);
  let s;
  if (tag === heute) s = "heute";
  else if (tag === plusTage(heute, 1)) s = "morgen";
  else if (tag === plusTage(heute, -1)) s = "gestern";
  else s = `${WT[p.wd]} ${p.t}.${p.m}.` + (p.j !== heute.slice(0, 4) ? p.j.slice(2) : "");
  return mitZeit ? `${s} ${p.h}:${p.min}` : s;
}

// Restzeit: „9 T 9 h“, „5 h 20 min“, „12 min“
export function restText(ms) {
  if (!(ms > 0)) return "abgelaufen";
  const min = Math.floor(ms / 60000);
  const t = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  if (t > 0) return `${t}${NB}T ${h}${NB}h`;
  if (h > 0) return `${h}${NB}h ${min % 60}${NB}min`;
  return `${min}${NB}min`;
}

// Stunden als Tage: „6,2 Tage“, „10 Tage“, „1 Tag“, „20 h“
export function tageText(h) {
  if (h === null || h === undefined || Number.isNaN(Number(h))) return "–";
  if (h < 36) return `${Math.round(h)}${NB}h`;
  const t = Math.round(h / 2.4) / 10;
  const s = String(t).replace(".", ",");
  return `${s}${NB}${s === "1" ? "Tag" : "Tage"}`;
}

// Wert für <input type="datetime-local"> in der HA-Zeitzone
export function alsEingabe(iso, tz) {
  const p = teile(iso, tz);
  return p ? `${p.j}-${p.m}-${p.t}T${p.h}:${p.min}` : "";
}

export function jetztEingabe(tz) {
  return alsEingabe(new Date(), tz);
}

function eingabeZuText(v) {
  return String(v || "").trim().replace("T", " ");
}

// GS1-Datum JJMMTT → JJJJ-MM-TT (TT „00“ = Monatsende)
export function gs1Datum(s) {
  if (!/^\d{6}$/.test(s || "")) return "";
  const j = 2000 + Number(s.slice(0, 2));
  const m = Number(s.slice(2, 4));
  let t = Number(s.slice(4, 6));
  if (m < 1 || m > 12 || t > 31) return "";
  if (t === 0) t = new Date(Date.UTC(j, m, 0)).getUTCDate();
  return `${j}-${pad(m)}-${pad(t)}`;
}

function gs1MitTrenner(s) {
  const out = [];
  let i = 0;
  let schutz = 0;
  while (i < s.length && schutz++ < 30) {
    if (s[i] === GS) {
      i++;
      continue;
    }
    let ai = null;
    for (const n of [2, 3]) {
      const k = s.slice(i, i + n);
      if (GS1_FEST[k] || GS1_VAR[k]) {
        ai = k;
        break;
      }
    }
    if (!ai) break;
    i += ai.length;
    if (GS1_FEST[ai]) {
      out.push([ai, s.slice(i, i + GS1_FEST[ai])]);
      i += GS1_FEST[ai];
    } else {
      let e = s.indexOf(GS, i);
      if (e < 0) e = s.length;
      out.push([ai, s.slice(i, e)]);
      i = e;
    }
  }
  return out;
}

// ohne Trennzeichen: Zerlegung suchen, die alles aufbraucht (jeder Bezeichner höchstens einmal)
function gs1Raten(s, i, benutzt, tiefe) {
  if (i >= s.length) return [];
  if (tiefe > 10) return null;
  for (const n of [2, 3]) {
    const ai = s.slice(i, i + n);
    if (benutzt.includes(ai)) continue;
    if (GS1_FEST[ai]) {
      const v = s.slice(i + n, i + n + GS1_FEST[ai]);
      if (v.length !== GS1_FEST[ai] || !/^\d+$/.test(v)) return null;
      const rest = gs1Raten(s, i + n + v.length, benutzt.concat([ai]), tiefe + 1);
      return rest ? [[ai, v]].concat(rest) : null;
    }
    if (GS1_VAR[ai]) {
      const start = i + n;
      const max = Math.min(GS1_VAR[ai], s.length - start);
      for (let len = 1; len <= max; len++) {
        const rest = start + len === s.length ? [] : gs1Raten(s, start + len, benutzt.concat([ai]), tiefe + 1);
        if (rest) return [[ai, s.slice(start, start + len)]].concat(rest);
      }
      return null;
    }
  }
  return null;
}

// Inhalt eines GS1-Codes vom Etikett: „]d2…“, mit GS-Trennzeichen oder als „(01)…(10)…“
export function gs1Parse(roh) {
  const s = String(roh || "").trim().replace(/^\][A-Za-z]\d/, "");
  let paare;
  if (/^\(\d{2,4}\)/.test(s)) {
    paare = [];
    const re = /\((\d{2,4})\)([^(]*)/g;
    let m;
    while ((m = re.exec(s))) paare.push([m[1], m[2].trim()]);
  } else if (s.includes(GS)) {
    paare = gs1MitTrenner(s);
  } else {
    paare = gs1Raten(s, 0, [], 0) || [];
  }
  const e = {};
  for (const [ai, v] of paare) if (!(ai in e)) e[ai] = v;
  return {
    gtin: e["01"] || e["02"] || "",
    ref: e["241"] || e["240"] || "",
    lot: e["10"] || "",
    hergestellt: gs1Datum(e["11"]),
    verwendbar_bis: gs1Datum(e["17"]),
    sn: e["21"] || "",
    roh: e,
  };
}

// Code von einer Transmitter-Verpackung?
export function istTransmitterCode(g) {
  return !!(g && ((g.gtin && TX_GTIN[g.gtin]) || /^STT-/i.test(g.ref || "")));
}

// Code von einem Sensor-Etikett?
export function istSensorCode(g, gelernt) {
  return !!(g && !istTransmitterCode(g) && ((g.gtin && ((gelernt && gelernt[g.gtin]) || MODELL_GTIN[g.gtin])) || /^STS-/i.test(g.ref || "")));
}

// Seriennummer aus einem Code ohne GS1-Daten (oben auf der Transmitter-Packung steht ein Code nur mit der SN)
export function snAusText(t) {
  let s = String(t || "").trim();
  if (s[0] === "]") s = s.slice(3);
  return /^[0-9A-Z]{6}(-[0-9])?$/i.test(s) ? s.toUpperCase() : "";
}

// Seriennummer ohne Endung „-1“ (die CGM-Integration meldet sie ohne)
export function snKern(sn) {
  return String(sn || "").trim().toUpperCase().replace(/-[0-9]$/, "");
}

export function modellAusGtin(gtin, gelernt) {
  if (!gtin) return "";
  return (gelernt && gelernt[gtin]) || MODELL_GTIN[gtin] || "";
}

// Code im Foto lesen: zuerst der eingebaute BarcodeDetector (nur https, Chrome/Android),
// sonst der eigene Data-Matrix-Leser (dexcom-dm.js, wird erst bei Bedarf geladen)
export async function barcodeLesen(bild, opt = {}) {
  let nurSn = null;
  const pruefen = (text, quelle) => {
    const g = gs1Parse(text);
    if (g.lot || g.gtin) return { gs1: g, roh: text, quelle };
    const sn = g.sn || snAusText(text);
    if (sn && !nurSn) nurSn = { gs1: { ...g, sn }, roh: text, quelle, nurSn: true };
    return null;
  };
  if (typeof window !== "undefined" && "BarcodeDetector" in window && !opt.ohneDetector) {
    try {
      const formate = await window.BarcodeDetector.getSupportedFormats();
      const wunsch = ["data_matrix", "qr_code", "aztec", "code_128", "pdf417"].filter((x) => formate.includes(x));
      if (wunsch.length) {
        const codes = await new window.BarcodeDetector({ formats: wunsch }).detect(bild);
        for (const c of codes) {
          const r = pruefen(c.rawValue, "detector");
          if (r) return r;
        }
      }
    } catch (e) {
      // weiter mit dem eigenen Leser
    }
  }
  let res = null;
  try {
    const f = Math.min(1, 2400 / Math.max(bild.width, bild.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bild.width * f));
    c.height = Math.max(1, Math.round(bild.height * f));
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bild, 0, 0, c.width, c.height);
    const daten = ctx.getImageData(0, 0, c.width, c.height);
    const dm = await import(new URL(`./dexcom-dm.js?v=${DXK_VERSION}`, import.meta.url).href);
    await new Promise((r) => setTimeout(r, 30));
    // bei mehreren Codes im Bild weitersuchen, bis einer GS1-Daten hat (Transmitter-Packung: SN-Code oben, UDI unten)
    const vollstaendig = (x) => {
      const g = gs1Parse(x.text);
      return !!(g.lot || g.gtin);
    };
    res = dm.dmLesenRgba(daten.data, c.width, c.height, { zeitMax: opt.zeitMax || 5000, pruefen: vollstaendig });
  } catch (e) {
    if (nurSn && opt.snReicht) return nurSn;
    return { fehler: "leser", roh: [String(e && e.message ? e.message : e)] };
  }
  if (res) {
    const r = pruefen(res.text, "eigen");
    if (r) return r;
  }
  if (nurSn && opt.snReicht) return nurSn;
  if (!res) return { fehler: "nichts" };
  return { fehler: "kein_gs1", roh: [res.text] };
}

export function dhlLink(nr) {
  return "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=" + encodeURIComponent(nr || "");
}

function icon(name) {
  return `<ha-icon icon="${name}"></ha-icon>`;
}

function fehlerText(err) {
  return (err && (err.message || (err.body && err.body.message) || err.code)) || String(err);
}

function sensorById(daten, id) {
  return ((daten && daten.sensoren) || []).find((s) => s.id === id) || null;
}

function transmitterById(daten, id) {
  return (((daten && daten.transmitter) || {}).liste || []).find((x) => x.id === id) || null;
}

// Sensor oder Transmitter (beide reklamierbar)
function objektById(daten, id) {
  return sensorById(daten, id) || transmitterById(daten, id);
}

function txName(x) {
  return "Transmitter " + (x && x.sn ? x.sn : "ohne Nummer");
}

function ganz(x) {
  return String(Math.round(Number(x) || 0));
}

// Status eines Transmitters (G6, Laufzeit ab Aktivierung)
export function transmitterStatus(x) {
  if (!x) return { text: "", cls: "" };
  if (x.status === "laeuft") return { text: x.tag ? `Tag ${x.tag} von ${ganz(x.soll_tage || 90)}` : "läuft", cls: "ok" };
  if (x.status === "abgelaufen") return { text: "abgelaufen", cls: "warn" };
  if (x.status === "vorzeitig") return { text: `nur ${ganz(x.gehalten_tage)} Tage`, cls: "rot" };
  if (x.status === "verbraucht") return { text: `${ganz(x.gehalten_tage)} Tage genutzt`, cls: "" };
  return { text: x.status || "", cls: "" };
}

// Status eines Sensors für Liste und Kopf
export function sensorStatus(s) {
  if (!s) return { text: "", cls: "" };
  if (s.status === "laeuft") return { text: s.tag ? `läuft · Tag ${s.tag}` : "läuft", cls: "ok" };
  if (s.status === "nachlauf") return { text: "Nachlaufzeit", cls: "warn" };
  if (s.status === "abgelaufen") return { text: "abgelaufen", cls: "warn" };
  if (s.status === "vorzeitig") return { text: `nur ${tageText(s.gehalten_h)}`, cls: "rot" };
  if (s.status === "verbraucht") return { text: `${tageText(s.gehalten_h)} gehalten`, cls: "" };
  return { text: s.status || "", cls: "" };
}

export function fallText(f, tz) {
  if (!f) return "";
  let t = FALL_STATUS[f.status] || f.status || "";
  if (f.status === "erhalten" && f.ersatz_erhalten_am) t += " " + datumText(f.ersatz_erhalten_am, tz, false);
  return t;
}

function fallCls(f) {
  if (!f) return "";
  if (f.status === "erhalten" || f.status === "erledigt") return "ok";
  if (f.status === "abgelehnt") return "";
  return f.historisch ? "" : "warn";
}

function lieferungTitel(L, tz) {
  if (L.art === "quartal" && L.zeitraum_von) return `Quartal ${datumText(L.zeitraum_von, tz, false)}–${datumText(L.zeitraum_bis, tz)}`;
  if (L.art === "ersatz") return (!L.anzahl && L.transmitter ? "Ersatz-Transmitter" : "Ersatzsensor") + (L.faelle && L.faelle.length && !String(L.faelle[0]).startsWith("K-") ? ` · Fall ${L.faelle[0]}` : "");
  if (L.art === "shop") return "Webshop" + (L.bestellnr ? ` ${L.bestellnr}` : "");
  return ART_NAME[L.art] || L.art;
}

function lieferungDatum(L) {
  return L.zugestellt_am || L.versendet || L.bestellt || "";
}

// ---------- Karte (HTML) ----------

function heroHtml(m) {
  const d = m.daten;
  const s = d.aktuell;
  if (!s) {
    return `<div class="hero leerhero" data-a="sensor-neu" role="button" tabindex="0">${icon("mdi:needle")}<div><b>Kein aktueller Sensor</b><span>Neuen Sensor mit der Kamera eintragen</span></div></div>`;
  }
  const jetzt = m.jetzt;
  const start = new Date(s.start || s.gesetzt).getTime();
  const ende = new Date(s.ende).getTime();
  const anteil = Math.max(0, Math.min(1, (jetzt - start) / Math.max(1, ende - start)));
  const rest = ende - jetzt;
  const st = sensorStatus(s);
  const soll = s.soll_h ? Math.round(s.soll_h / 24) : 10;
  let zeile1;
  if (s.status === "laeuft") zeile1 = `noch <b>${restText(rest)}</b>`;
  else if (s.status === "nachlauf") zeile1 = `<b>Nachlaufzeit</b> bis ${esc(tagZeit(s.nachlauf_bis, m.tz, m.heute))}`;
  else zeile1 = `<b>abgelaufen</b> seit ${esc(tagZeit(s.ende, m.tz, m.heute))}`;
  const warnBar = s.status === "laeuft" && rest < 24 * 3600000;
  return `<div class="hero" data-a="sensor" data-id="${esc(s.id)}" role="button" tabindex="0">
  <div class="h1">${icon("mdi:needle")}<span class="hm">${esc(s.modell || "?")}</span><span class="hs ${st.cls}">${s.status === "laeuft" && s.tag ? `Tag ${s.tag} von ${soll}` : esc(st.text)}</span><span class="spacer"></span><span class="hz">${zeile1}</span></div>
  <div class="bar${warnBar ? " warn" : ""}${s.status !== "laeuft" ? " aus" : ""}"><span style="width:${(anteil * 100).toFixed(1)}%"></span></div>
  <div class="h2"><span>gesetzt ${esc(tagZeit(s.gesetzt, m.tz, m.heute))}</span><span>endet ${esc(tagZeit(s.ende, m.tz, m.heute))}</span></div>
  ${s.lot ? `<div class="h3">LOT ${esc(s.lot)}${s.verwendbar_bis ? ` · verwendbar bis ${esc(datumText(s.verwendbar_bis, m.tz))}` : ""}</div>` : (s.quelle === "automatisch" ? `<div class="h3 warnt" data-a="foto-sensor" data-id="${esc(s.id)}" role="button" tabindex="0">${icon("mdi:camera-outline")} Etikett-Daten fehlen – jetzt fotografieren</div>` : "")}
</div>`;
}

function kachel(a, ic, label, wert, unter, cls) {
  return `<button class="kachel${cls ? " " + cls : ""}" data-a="${a}"><span class="kl">${icon(ic)}${esc(label)}</span><span class="kw">${wert}</span><span class="ks">${unter || NB}</span></button>`;
}

function kachelnHtml(m) {
  const d = m.daten;
  const b = d.bestand;
  // Bestand
  let bw;
  let bu;
  let bcls = "";
  if (!b) {
    bw = "<b>?</b>";
    bu = "Inventur fehlt";
    bcls = "warn";
  } else {
    bw = `<b>${b.gesamt}</b><span>${b.gesamt === 1 ? "Sensor" : "Sensoren"}</span>`;
    const teileM = Object.entries(b.je_modell || {}).filter(([, n]) => n !== 0).map(([mo, n]) => `${n}× ${mo}`);
    bu = (teileM.length ? teileM.join(", ") + " · " : "") + (d.reicht_bis ? `reicht bis ${tagZeit(d.reicht_bis, m.tz, m.heute, false)}` : "");
    if (b.gesamt <= 1) bcls = "warn";
    if (b.gesamt < 0) bcls = "rot";
  }
  // Lieferung
  let lw = "<b>–</b>";
  let lu = "nichts angekündigt";
  let lcls = "";
  const unterwegs = (d.lieferungen || []).filter((L) => (d.unterwegs || []).includes(L.id));
  if (unterwegs.length) {
    const L = unterwegs[0];
    lw = `<b class="klein-b">${esc(LIEF_STATUS[L.status] || L.status)}</b>`;
    lu = (L.art === "ersatz" ? "Ersatz" : `${L.anzahl}× ${L.modell || ""}`) + (L.erwartet ? ` · erwartet ${datumText(L.erwartet, m.tz, false)}` : "");
    lcls = "gut";
  } else if (d.naechste) {
    const n = d.naechste;
    if (n.status === "ueberfaellig") {
      lw = `<b class="klein-b">überfällig</b>`;
      lu = `sollte bis ${datumText(n.frist, m.tz, false)} da sein`;
      lcls = "rot";
    } else {
      lw = `<b class="klein-b">angekündigt</b>`;
      lu = n.vorbereitung_ab ? `Vorbereitung ab ${datumText(n.vorbereitung_ab, m.tz, false)}` : `Versand ${datumText(n.versand_geplant, m.tz, false)}`;
    }
  }
  // Reklamationen
  const offen = (d.faelle || []).filter((f) => !f.historisch && ["offen", "zugesagt", "unterwegs"].includes(f.status));
  const rw = `<b>${offen.length}</b><span>offen</span>`;
  let ru = "";
  let rcls = "";
  if (offen.length) {
    ru = fallText(offen[0], m.tz);
    rcls = "warn";
  } else {
    const letzte = (d.faelle || [])[0];
    ru = letzte ? `${datumText(letzte.datum, m.tz, false)}: ${FALL_KURZ[letzte.status] || letzte.status}` : "keine";
  }
  // Folgerezept
  const rz = d.folgerezept;
  let zw = "<b>–</b>";
  let zu = "kein Termin bekannt";
  let zcls = "";
  if (rz) {
    zw = `<b class="klein-b">${esc(datumText(rz.bis, m.tz))}</b>`;
    if (rz.verschickt) {
      zu = `verschickt ${datumText(rz.verschickt_am, m.tz, false)} ✓`;
      zcls = "gut";
    } else {
      const tage = Math.round((new Date(rz.bis + "T12:00:00").getTime() - m.jetzt) / 86400000);
      zu = tage >= 0 ? `noch ${tage} Tage` : "Termin vorbei";
      const vor = (d.einstellungen && d.einstellungen.rezept_vorlauf_tage) || 28;
      if (tage <= vor) zcls = "warn";
    }
  }
  // Transmitter (G6)
  const tx = d.transmitter;
  let txk = "";
  if (tx && tx.relevant) {
    const ta = tx.aktuell;
    const tb = tx.bestand;
    const vor = Number((d.einstellungen || {}).transmitter_vorlauf_tage ?? 7);
    const tw = tb ? `<b>${tb.anzahl}</b><span>im Vorrat</span>` : "<b>?</b><span>Vorrat zählen</span>";
    let tu;
    let tcls = "";
    const bisW = ta && ta.status === "laeuft" && tx.wechsel_am ? (new Date(tx.wechsel_am).getTime() - m.jetzt) / 86400000 : null;
    if (ta && ta.status === "laeuft") {
      tu = (ta.sn ? ta.sn + " · " : "") + (tx.wechsel_am ? `Wechsel ${tagZeit(tx.wechsel_am, m.tz, m.heute, false)}` : `bis ${datumText(ta.ende, m.tz, false)}`);
      if (bisW !== null && bisW <= vor) tcls = "warn";
    } else if (ta) {
      tu = `abgelaufen ${datumText(ta.ende, m.tz, false)} – neuen eintragen`;
      tcls = "warn";
    } else {
      tu = "aktueller noch nicht eingetragen";
    }
    if (tb && (tb.anzahl < 0 || (tb.anzahl === 0 && (tcls === "warn" || (bisW !== null && bisW <= 30))))) tcls = tcls === "warn" || tb.anzahl < 0 ? "rot" : "warn";
    txk = kachel("transmitter", "mdi:access-point", "Transmitter", tw, tu, (tcls ? tcls + " " : "") + "tx");
  }
  return `<div class="kacheln${txk ? " mit-tx" : ""}">
${kachel("tab-sensoren", "mdi:package-variant", "Bestand", bw, bu, bcls)}
${kachel("naechste", "mdi:truck-delivery-outline", "Lieferung", lw, lu, lcls)}
${kachel("tab-reklamationen", "mdi:message-alert-outline", "Reklamationen", rw, ru, rcls)}
${kachel("rezept", "mdi:file-document-outline", "Folgerezept", zw, zu, zcls)}
${txk}
</div>`;
}

function hinweiseHtml(m) {
  const w = (m.daten.warnungen || []).filter((x) => x.art !== "foto");
  if (!w.length) return "";
  const ic = { lieferung: "mdi:truck-alert-outline", knapp: "mdi:package-variant-remove", ersatz: "mdi:message-alert-outline", rezept: "mdi:file-document-alert-outline", bestand: "mdi:alert-outline", inventur: "mdi:clipboard-list-outline", sendung: "mdi:package-variant-closed-check", transmitter: "mdi:access-point" };
  return w.map((x) => `<div class="hinweis warn">${icon(ic[x.art] || "mdi:alert-outline")}<span>${esc(x.text)}</span></div>`).join("");
}

function sensorZeile(s, m) {
  const st = sensorStatus(s);
  const f = s.fall_info;
  const p = teile(s.gesetzt, m.tz);
  const titel = [s.modell || "?", s.lot ? `LOT ${s.lot}` : s.quelle === "automatisch" ? "automatisch erkannt" : s.quelle === "verlauf" ? "aus dem Verlauf" : ""].filter(Boolean).join(" · ");
  const chips = [`<span class="badge ${st.cls}">${esc(st.text)}</span>`];
  if (s.reklamation && s.reklamation.am) chips.push(`<span class="badge ${fallCls(f)}">${icon("mdi:message-alert-outline")}reklamiert ${esc(datumText(s.reklamation.am, m.tz, false))}${f ? " · " + esc(fallText(f, m.tz)) : ""}</span>`);
  else if (s.status === "vorzeitig") chips.push(`<span class="badge warn">reklamieren?</span>`);
  if (s.verfall_ueberschritten) chips.push(`<span class="badge rot">Verfall überschritten</span>`);
  if (s.foto && s.foto.id) chips.push(`<span class="badge">${icon("mdi:camera-outline")}Foto</span>`);
  return `<div class="z" data-a="sensor" data-id="${esc(s.id)}" role="button" tabindex="0">
  <div class="zt"><b>${p ? `${p.t}.${p.m}.` : "–"}</b><span>${p ? `${p.h}:${p.min}` : ""}</span></div>
  <div class="zm"><div class="z1"><span class="weg">${esc(titel)}</span></div><div class="z2">${chips.join("")}</div></div>
  <div class="zr">${icon("mdi:chevron-right")}</div>
</div>`;
}

function sensorenHtml(m) {
  const liste = m.daten.sensoren || [];
  const kopf = `<div class="leiste"><button class="knopf" data-a="foto-neu">${icon("mdi:camera")}Neuer Sensor</button><button class="knopf2" data-a="sensor-neu">${icon("mdi:plus")}von Hand</button><span class="klein">Etikett-Foto füllt die Daten aus</span></div>`;
  if (!liste.length) return kopf + `<div class="leer">Noch keine Sensoren eingetragen.</div>`;
  return kopf + liste.map((s) => sensorZeile(s, m)).join("");
}

function naechsteZeile(n, m) {
  const ueber = n.status === "ueberfaellig";
  const was = n.vorbereitung_ab ? `Vorbereitung ab ${datumText(n.vorbereitung_ab, m.tz, false)}` : `Versand geplant ${datumText(n.versand_geplant, m.tz, false)}`;
  return `<div class="z naechste${ueber ? " rot" : ""}" data-a="naechste" role="button" tabindex="0">
  <div class="zt">${icon(ueber ? "mdi:truck-alert-outline" : "mdi:truck-outline")}</div>
  <div class="zm"><div class="z1"><span class="weg">Nächste Lieferung</span><span class="badge ${ueber ? "rot" : ""}">${ueber ? "überfällig" : "angekündigt"}</span></div>
  <div class="z2">${esc(was)} · Zustellung bis ${esc(datumText(n.frist, m.tz, false))}</div></div>
  <div class="zr">${icon("mdi:chevron-right")}</div>
</div>`;
}

function lieferungZeile(L, m) {
  const p = teile(lieferungDatum(L), m.tz);
  const st = LIEF_STATUS[L.status] || L.status;
  let z2 = [];
  if (L.anzahl || (L.art !== "unbekannt" && !L.transmitter)) z2.push(L.modell ? `${L.anzahl}×${NB}${L.modell}` : `${L.anzahl}${NB}${L.anzahl === 1 ? "Sensor" : "Sensoren"}`);
  if (L.transmitter) z2.push(`${L.transmitter}${NB}Transmitter`);
  if (L.status === "zugestellt") z2.push(`zugestellt ${datumText(L.zugestellt_am, m.tz, false)}${L.zugestellt_angenommen ? " (angenommen)" : ""}`);
  else z2.push(st + (L.erwartet ? ` · erwartet ${datumText(L.erwartet, m.tz, false)}` : ""));
  const cls = L.aus ? " aus" : "";
  const badge = L.status !== "zugestellt" ? `<span class="badge gut">${esc(st)}</span>` : L.art === "unbekannt" ? `<span class="badge warn">zuordnen?</span>` : "";
  return `<div class="z${cls}" data-a="lieferung" data-id="${esc(L.id)}" role="button" tabindex="0">
  <div class="zt"><b>${p ? `${p.t}.${p.m}.` : "–"}</b><span>${p ? p.j : ""}</span></div>
  <div class="zm"><div class="z1"><span class="weg">${esc(lieferungTitel(L, m.tz))}</span>${badge}</div><div class="z2">${esc(z2.join(" · "))}${L.aus ? " · ausgeblendet" : ""}</div></div>
  <div class="zr">${L.anzahl ? `<b>+${L.anzahl}</b>` : icon("mdi:chevron-right")}</div>
</div>`;
}

function lieferungenHtml(m) {
  const d = m.daten;
  const kopf = `<div class="leiste"><button class="knopf" data-a="lieferung-neu">${icon("mdi:plus")}Lieferung</button><span class="klein">Kommt sonst automatisch aus den Mails</span></div>`;
  const teile2 = [];
  if (d.naechste) teile2.push(naechsteZeile(d.naechste, m));
  const inv = d.inventur && d.inventur.zeit ? new Date(d.inventur.zeit).getTime() : null;
  let getrennt = false;
  for (const L of d.lieferungen || []) {
    const t = lieferungDatum(L) ? new Date(lieferungDatum(L)).getTime() : null;
    if (inv && t && t <= inv && !getrennt) {
      teile2.push(`<div class="tag-kopf"><span>Vor der Bestandsaufnahme am ${esc(datumText(d.inventur.zeit, m.tz))} – zählt nicht mehr</span></div>`);
      getrennt = true;
    }
    teile2.push(lieferungZeile(L, m));
  }
  const g = d.gmail || {};
  const fuss = `<div class="summe">${g.fehler ? `⚠️ ${esc(g.fehler)} · ` : ""}Mails: ${g.mails || 0} von Dexcom/DHL${g.stand ? `, zuletzt geprüft ${esc(tagZeit(g.stand, m.tz, m.heute))}` : ""}</div>`;
  return kopf + (teile2.length ? teile2.join("") : `<div class="leer">Noch keine Lieferungen erkannt.</div>`) + fuss;
}

function fallZeile(f, m) {
  const p = teile(f.datum, m.tz);
  const s = f.sensor ? sensorById(m.daten, f.sensor) : null;
  const titel = f.quelle === "mail" ? `Fall ${f.id}` + (f.nummern && f.nummern.length > 1 ? ` (+${f.nummern.length - 1})` : "") : "Reklamation" + (f.nummern && f.nummern[0] ? ` · Fall ${f.nummern[0]}` : "");
  const z2 = [fallText(f, m.tz)];
  if (f.antwort === "kulanz") z2.push("Kulanz");
  if (s) z2.push(`Sensor vom ${datumText(s.gesetzt, m.tz, false)}`);
  const tr = f.sensor && !s ? transmitterById(m.daten, f.sensor) : null;
  if (tr) z2.push(txName(tr));
  if (f.historisch) z2.push("vor der Bestandsführung");
  const icn = f.status === "erhalten" ? "mdi:check-circle-outline" : f.status === "erledigt" ? "mdi:check" : f.status === "abgelehnt" ? "mdi:close-circle-outline" : "mdi:clock-outline";
  return `<div class="z" data-a="fall" data-id="${esc(f.id)}" role="button" tabindex="0">
  <div class="zt"><b>${p ? `${p.t}.${p.m}.` : "–"}</b><span>${p ? p.j : ""}</span></div>
  <div class="zm"><div class="z1"><span class="weg">${esc(titel)}</span></div><div class="z2"><span class="badge ${fallCls(f)}">${esc(z2[0])}</span>${esc(z2.slice(1).join(" · "))}</div></div>
  <div class="zr fall-${esc(f.status)}">${icon(icn)}</div>
</div>`;
}

function faelleHtml(m) {
  const liste = m.daten.faelle || [];
  const kopf = `<div class="erkl klein">Reklamieren: Sensor antippen → „Reklamieren“. Support-Fälle aus den Mails (Fall-Referenznummer) werden automatisch zugeordnet, Ersatzpakete per DHL erkannt.</div>`;
  if (!liste.length) return kopf + `<div class="leer">Keine Reklamationen.</div>`;
  const offen = liste.filter((f) => ["offen", "zugesagt", "unterwegs"].includes(f.status) && !f.historisch);
  const rest = liste.filter((f) => !offen.includes(f));
  return kopf + offen.map((f) => fallZeile(f, m)).join("") + (offen.length && rest.length ? `<div class="tag-kopf"><span>Erledigt / früher</span></div>` : "") + rest.map((f) => fallZeile(f, m)).join("");
}

export function karteHtml(m) {
  const d = m.daten;
  const status = m.fehler
    ? `<div class="status fehler">${icon("mdi:alert-circle-outline")}<span>${esc(m.fehler)}</span></div>`
    : m.meldung
      ? `<div class="status ok">${icon("mdi:check")}<span>${esc(m.meldung)}</span></div>`
      : "";
  let inhalt = "";
  if (!d) inhalt = m.fehler ? "" : `<div class="leer">Lade Dexcom-Daten …</div>`;
  else if (m.tab === "lieferungen") inhalt = lieferungenHtml(m);
  else if (m.tab === "reklamationen") inhalt = faelleHtml(m);
  else inhalt = sensorenHtml(m);
  return `<ha-card>
<div class="kopf">
  ${m.cfg.titel ? `<div class="titel">${esc(m.cfg.titel)}</div>` : ""}
  <span class="spacer"></span>
  ${m.laedt ? `<span class="lade" title="Lade …">${icon("mdi:loading")}</span>` : ""}
  <button class="icon" data-a="gmail" title="Jetzt im Postfach nachsehen"${d && !m.gmailLaeuft ? "" : " disabled"}>${icon(m.gmailLaeuft ? "mdi:email-sync-outline" : "mdi:email-search-outline")}</button>
  <button class="icon" data-a="einstellungen" title="Einstellungen"${d ? "" : " disabled"}>${icon("mdi:cog-outline")}</button>
</div>
${status}
${d ? heroHtml(m) + kachelnHtml(m) + hinweiseHtml(m) : ""}
<div class="tabs" role="tablist">${TABS.map(([k, n]) => `<button role="tab" data-a="tab" data-v="${k}" class="${m.tab === k ? "an" : ""}" aria-selected="${m.tab === k}">${n}${k === "reklamationen" && d ? zaehler(d) : ""}</button>`).join("")}</div>
<div class="inhalt">${inhalt}</div>
</ha-card>`;
}

function zaehler(d) {
  const n = (d.faelle || []).filter((f) => !f.historisch && ["offen", "zugesagt", "unterwegs"].includes(f.status)).length;
  return n ? ` <span class="zahl">${n}</span>` : "";
}

// ---------- Dialoge ----------

function dKopf(titel, d) {
  return `<div class="kopf"><h2>${esc(titel)}</h2><button class="icon" data-a="zu" title="Schließen"${d.busy ? " disabled" : ""}>${icon("mdi:close")}</button></div>`;
}

function dFuss(links, rechts) {
  return `<div class="fuss">${links}<span class="spacer"></span>${rechts}</div>`;
}

function knopf(a, text, cls, d, ic, v) {
  return `<button class="btn${cls ? " " + cls : ""}" data-a="${a}"${v !== undefined ? ` data-v="${esc(v)}"` : ""}${d.busy ? " disabled" : ""}>${ic ? icon(ic) : ""}${esc(text)}</button>`;
}

function feld(label, inhalt, neben) {
  return `<div class="zeile"><label>${esc(label)}</label>${inhalt}${neben ? `<div class="neben">${neben}</div>` : ""}</div>`;
}

function eingabe(f, wert, opt = {}) {
  return `<input type="${opt.type || "text"}"${opt.mode ? ` inputmode="${opt.mode}"` : ""} data-f="${f}" value="${esc(wert)}"${opt.ph ? ` placeholder="${esc(opt.ph)}"` : ""} class="${opt.cls || "voll"}" autocomplete="off"${opt.min !== undefined ? ` min="${opt.min}"` : ""}${opt.max !== undefined ? ` max="${opt.max}"` : ""}${opt.step ? ` step="${opt.step}"` : ""}>`;
}

function textfeld(f, wert, ph) {
  return `<textarea data-f="${f}" rows="2" class="voll"${ph ? ` placeholder="${esc(ph)}"` : ""}>${esc(wert)}</textarea>`;
}

function chips(f, werte, aktiv, namen) {
  return `<div class="chips">${werte.map((w) => `<button class="${w === aktiv ? "an" : ""}" data-a="chip" data-f="${f}" data-v="${esc(w)}">${esc((namen && namen[w]) || w)}</button>`).join("")}</div>`;
}

function schalter(f, an, text, klein) {
  return `<label class="schalter"><input type="checkbox" data-f="${f}"${an ? " checked" : ""}><span>${esc(text)}</span>${klein ? `<small>${esc(klein)}</small>` : ""}</label>`;
}

function wert(label, haupt, neben) {
  if (haupt === null || haupt === undefined || haupt === "") return "";
  return `<div class="wert"><span class="wl">${esc(label)}</span><span class="ww">${haupt}${neben ? `<small>${neben}</small>` : ""}</span></div>`;
}

function fehlerZeile(d) {
  return d.fehler ? `<div class="fehler">${esc(d.fehler)}</div>` : "";
}

function sensorAnsicht(d, m) {
  const s = sensorById(m.daten, d.id) || d.e;
  const st = sensorStatus(s);
  const r = s.reklamation;
  const f = s.fall_info;
  const tz = m.tz;
  const quelle = { foto: "Etikett-Foto", hand: "von Hand", automatisch: "automatisch erkannt (CGM-Integration)", verlauf: "aus dem HA-Verlauf nachgetragen" }[s.quelle] || s.quelle;
  let lauf = "";
  if (s.status === "laeuft") lauf = `noch ${restText(new Date(s.ende).getTime() - m.jetzt)}`;
  else if (s.gehalten_h !== null && s.gehalten_h !== undefined) lauf = `${tageText(s.gehalten_h)} von ${tageText(s.soll_h)}`;
  let rek = "";
  if (r && r.am) {
    rek = `<div class="abschnitt">Reklamation</div>
${wert("Reklamiert", esc(datumText(r.am, tz)))}
${wert("Fall", r.fall ? esc(r.fall) : f && f.quelle === "mail" ? esc(f.id) + " <small>(automatisch zugeordnet)</small>" : "")}
${wert("Ausgefallen", r.ausfall_am ? esc(tagZeit(r.ausfall_am, tz, m.heute)) : "")}
${wert("Grund", r.grund ? esc(r.grund) : "")}
${wert("Ersatz", f ? `<span class="badge ${fallCls(f)}">${esc(fallText(f, tz))}</span>` : "", f && f.antwort_datum ? `Dexcom-Antwort ${esc(datumText(f.antwort_datum, tz))}${f.antwort === "kulanz" ? " (Kulanz)" : ""}` : "")}
${wert("Notiz", r.notiz ? esc(r.notiz) : "")}
<div class="aktionen">
${f && ["offen", "zugesagt", "unterwegs"].includes(f.status) ? knopf("rek-ersatz", "Ersatz erhalten", "haupt", d, "mdi:package-variant-closed-check") : ""}
${f && f.status === "erhalten" && r.ersatz_erhalten_am ? knopf("rek-ersatz-offen", "Ersatz doch nicht da", "", d) : ""}
${r.erledigt ? knopf("rek-offen", "Wieder öffnen", "", d) : knopf("rek-erledigt", "Abschließen", "", d, "mdi:check")}
${knopf("rek-aendern", "Ändern", "", d, "mdi:pencil-outline")}
${knopf("rek-entfernen", "Entfernen", "rot", d)}
</div>`;
  } else {
    rek = `<div class="abschnitt">Reklamation</div>
<div class="info klein">${icon("mdi:information-outline")}<span>${s.status === "vorzeitig" ? `Hat nur ${tageText(s.gehalten_h)} gehalten. ` : ""}Bei Dexcom reklamieren (Webportal dexcom.com/DETechSupport oder ${TEL_TECHNIK.replace(/^0800(\d{3})(\d{4})$/, "0800 $1 $2")}), dann hier markieren. Die Fallnummer aus der Bestätigungsmail wird automatisch zugeordnet, das Ersatzpaket per DHL-Mail erkannt.</span></div>
<div class="aktionen">${knopf("reklamieren", "Reklamiert …", "haupt", d, "mdi:message-alert-outline")}</div>`;
  }
  const verlauf = (s.verlauf || []).slice().reverse().map((v) => `<div class="mz"><span class="mn">${esc(v.was)}</span><span>${esc(tagZeit(v.z, tz, m.heute))}</span></div>`).join("");
  return `${dKopf(`${s.modell || "Sensor"} vom ${datumText(s.gesetzt, tz)}`, d)}
<div class="inhalt">
${wert("Status", `<span class="badge ${st.cls}">${esc(st.text)}</span>`, lauf)}
${wert("Gesetzt", esc(tagZeit(s.gesetzt, tz, m.heute)), s.start && s.start !== s.gesetzt ? `Sitzung ab ${esc(tagZeit(s.start, tz, m.heute))}` : "")}
${wert(s.status === "laeuft" ? "Endet" : "Ende (Soll)", esc(tagZeit(s.ende, tz, m.heute)), s.nachlauf_bis ? `Nachlaufzeit bis ${esc(tagZeit(s.nachlauf_bis, tz, m.heute))}` : "")}
${wert("Entfernt", s.entfernt_eff && s.status !== "laeuft" ? esc(tagZeit(s.entfernt_eff, tz, m.heute)) + (s.entfernt_manuell ? "" : " <small>(nächster Sensor)</small>") : "")}
<div class="abschnitt">Etikett</div>
${wert("LOT", s.lot ? `<b>${esc(s.lot)}</b>` : `<span class="klein">fehlt</span>`)}
${wert("REF / PN", esc(s.ref || ""))}
${wert("Verwendbar bis", s.verwendbar_bis ? esc(datumText(s.verwendbar_bis, tz)) + (s.verfall_ueberschritten ? ` <span class="badge rot">überschritten</span>` : "") : "")}
${wert("Hergestellt", s.hergestellt ? esc(datumText(s.hergestellt, tz)) : "")}
${wert("GTIN", esc(s.gtin || ""))}
${wert("Sensor-Code", esc(s.code || ""))}
${s.modell === "G6" && s.transmitter_info ? wert("Transmitter", `<button class="link" data-a="tx-oeffnen" data-v="${esc(s.transmitter_info.id)}">${esc(s.transmitter_info.sn || "ohne Nummer")}</button>`, s.sn && s.sn !== s.transmitter_info.sn && !s.sn_uebernommen ? `am Sensor eingetragen: ${esc(s.sn)}` : "")
    : wert(s.modell === "G6" ? "Transmitter-SN" : "Seriennummer", esc(s.sn || ""), s.sn_uebernommen ? "übernommen" : "")}
${wert("Quelle", esc(quelle))}
${wert("Notiz", s.notiz ? esc(s.notiz) : "")}
${fotoBereich(s, d, m)}
${rek}
${verlauf ? `<details class="verlauf"><summary>Verlauf</summary>${verlauf}</details>` : ""}
${fehlerZeile(d)}
</div>
${dFuss(knopf("loeschen", "Löschen", "rot", d), knopf("bearbeiten", "Bearbeiten", "", d, "mdi:pencil-outline") + knopf("zu", "Schließen", "haupt", d))}`;
}

function fotoLoeschTag(s, m) {
  const tage = Number((m.daten && m.daten.einstellungen && m.daten.einstellungen.foto_tage) || 7);
  const t = new Date(new Date(s.foto.zeit).getTime() + tage * 86400000);
  return datumText(t.toISOString(), m.tz, false);
}

function fotoBereich(s, d, m) {
  if (s.foto && s.foto.id) {
    return `<div class="aktionen">${d.fotoBild ? "" : knopf("foto-ansehen", d.fotoLaedt ? "Lade Foto …" : "Foto ansehen", "", d, "mdi:image-outline")}${knopf("foto-loeschen", "Foto löschen", "rot", d)}</div>
${d.fotoBild ? `<img class="foto" src="${esc(d.fotoBild)}" alt="Etikett-Foto">` : ""}
<div class="klein">Foto wird am ${esc(fotoLoeschTag(s, m))} automatisch gelöscht.</div>`;
  }
  return `<div class="aktionen">${knopf("foto-sensor", s.lot ? "Etikett-Foto aufnehmen" : "Etikett fotografieren", s.lot ? "" : "haupt", d, "mdi:camera")}</div>`;
}

function fotoKopf(d) {
  const f = d.foto;
  if (!f) return `<div class="aktionen">${knopf("foto-nochmal", "Etikett fotografieren", "haupt", d, "mdi:camera")}</div><div class="klein">Liest LOT, REF/PN, Verfall und GTIN aus dem kleinen quadratischen Code auf dem Etikett – nah ran und scharf. Öffnet sich keine Kamera, vorher ein Foto machen und hier auswählen.</div>`;
  const ic = f.status === "ok" ? "mdi:check-circle-outline" : f.status === "lesen" ? "mdi:loading" : "mdi:alert-outline";
  return `<div class="fotozeile"><img class="vorschau" src="${esc(f.url)}" alt="Foto"><div class="fotoinfo"><div class="fotostatus ${esc(f.status)}">${icon(ic)}<span>${esc(f.text)}</span></div>${f.fehler ? `<div class="fehler">${esc(f.fehler)}</div>` : ""}${d.txVorschlag ? knopf("tx-aus-foto", "Als Transmitter eintragen", "haupt", d, "mdi:radio-tower") : ""}${knopf("foto-nochmal", "Neues Foto", "", d, "mdi:camera-retake-outline")}</div></div>`;
}

function txFotoKopf(d) {
  const f = d.foto;
  if (!f) return `<div class="aktionen">${knopf("tx-foto-nochmal", "Verpackung fotografieren", "haupt", d, "mdi:camera")}</div><div class="klein">Liest Seriennummer, LOT und Verfall aus den quadratischen Codes auf der Transmitter-Packung – am besten beide Codes scharf im Bild. Öffnet sich keine Kamera, vorher ein Foto machen und hier auswählen.</div>`;
  const ic = f.status === "ok" ? "mdi:check-circle-outline" : f.status === "lesen" ? "mdi:loading" : "mdi:alert-outline";
  return `<div class="fotozeile"><img class="vorschau" src="${esc(f.url)}" alt="Foto"><div class="fotoinfo"><div class="fotostatus ${esc(f.status)}">${icon(ic)}<span>${esc(f.text)}</span></div>${knopf("tx-foto-nochmal", "Neues Foto", "", d, "mdi:camera-retake-outline")}</div></div>`;
}

function sensorForm(d, m) {
  const f = d.f;
  const neu = !d.id;
  const modelle = (m.daten && m.daten.modelle) || ["G6", "G7", "G7 15 Tage", "ONE+"];
  return `${dKopf(neu ? "Sensor eintragen" : "Sensor bearbeiten", d)}
<div class="inhalt">
${fotoKopf(d)}
${feld("Modell", chips("modell", modelle, f.modell))}
${feld("Gesetzt am", eingabe("gesetzt", f.gesetzt, { type: "datetime-local", cls: "mittel2" }))}
${feld("LOT", eingabe("lot", f.lot, { ph: "z. B. 1234567" }))}
${feld("REF / PN", eingabe("ref", f.ref, { ph: "z. B. 1234-56" }))}
${feld("Verwendbar bis", eingabe("verwendbar_bis", f.verwendbar_bis, { type: "date", cls: "mittel2" }))}
${feld("Hergestellt", eingabe("hergestellt", f.hergestellt, { type: "date", cls: "mittel2" }))}
${feld("Sensor-Code", eingabe("code", f.code, { mode: "numeric", cls: "mittel", ph: "4-stellig" }))}
${feld(f.modell === "G6" ? "Transmitter-SN" : "Seriennummer", eingabe("sn", f.sn, { ph: f.modell === "G6" ? "8XXXXX" : "" }))}
${feld("GTIN", eingabe("gtin", f.gtin, { mode: "numeric" }))}
${neu ? "" : feld("Entfernt am", eingabe("entfernt", f.entfernt, { type: "datetime-local", cls: "mittel2" }), "nur bei Ausfall – sonst gilt der nächste Sensor")}
${feld("Notiz", textfeld("notiz", f.notiz))}
${schalter("aus_bestand", f.aus_bestand, "Aus dem eigenen Bestand genommen", "Aus: zählt nicht gegen den Bestand (z. B. Probe-Sensor)")}
${fehlerZeile(d)}
</div>
${dFuss(knopf("zurueck-ansicht", neu ? "Abbrechen" : "Zurück", "", d), knopf("sensor-speichern", "Speichern", "haupt", d, "mdi:content-save-outline"))}`;
}

function reklamationForm(d, m) {
  const f = d.f;
  const tx = d.art === "transmitter";
  const gruende = tx ? GRUENDE_TX : GRUENDE;
  return `${dKopf(tx ? "Transmitter reklamieren" : "Reklamation", d)}
<div class="inhalt">
${feld("Reklamiert am", eingabe("am", f.am, { type: "date", cls: "mittel2" }))}
${feld("Ausgefallen am", eingabe("ausfall_am", f.ausfall_am, { type: "datetime-local", cls: "mittel2" }), tx ? "Wann der Transmitter nicht mehr ging (beendet ihn)" : "Wann der Sensor nicht mehr ging (setzt auch „entfernt“)")}
${feld("Fallnummer", eingabe("fall", f.fall, { ph: "z. B. 260101-000123 (optional)" }), "Kommt per Mail und wird sonst automatisch zugeordnet")}
${feld("Grund", `<div class="chips">${gruende.map((g) => `<button class="${f.grund === g ? "an" : ""}" data-a="chip" data-f="grund" data-v="${esc(g)}">${esc(g)}</button>`).join("")}</div>`)}
${feld("", eingabe("grund", f.grund, { ph: "oder eigener Grund" }))}
${feld("Notiz", textfeld("notiz", f.notiz))}
${fehlerZeile(d)}
</div>
${dFuss(knopf("zurueck-ansicht", "Zurück", "", d), knopf("rek-speichern", "Speichern", "haupt", d, "mdi:content-save-outline"))}`;
}

function loeschFrage(d, text, zurueck, ja) {
  return `${dKopf("Löschen?", d)}
<div class="inhalt"><p>${esc(text)}</p>${fehlerZeile(d)}</div>
${dFuss(knopf(zurueck, "Abbrechen", "", d), knopf(ja, "Löschen", "rot-voll", d, "mdi:delete-outline"))}`;
}

function txZeile(x, m, an) {
  const st = transmitterStatus(x);
  const f = x.fall_info;
  const chips = [`<span class="badge ${st.cls}">${esc(st.text)}</span>`];
  if (x.reklamation && x.reklamation.am) chips.push(`<span class="badge ${fallCls(f)}">reklamiert${f ? " · " + esc(fallText(f, m.tz)) : ""}</span>`);
  else if (x.status === "vorzeitig") chips.push(`<span class="badge warn">reklamieren?</span>`);
  return `<div class="mz tx${an ? " an" : ""}" data-a="tx-zeigen" data-v="${esc(x.id)}" role="button" tabindex="0"><span class="mn">${esc(x.sn || "ohne Nummer")} · ab ${esc(datumText(x.start, m.tz))}</span><span class="chipzeile">${chips.join("")}</span></div>`;
}

function transmitterAnsicht(d, m) {
  const daten = m.daten || {};
  const tx = daten.transmitter || {};
  const tz = m.tz;
  const x = (d.id && transmitterById(daten, d.id)) || (d.id ? d.e : null);
  const tb = tx.bestand;
  const e = daten.einstellungen || {};
  let oben;
  if (x) {
    const st = transmitterStatus(x);
    const r = x.reklamation;
    const f = x.fall_info;
    const aktuell = tx.aktuell && x.id === tx.aktuell.id;
    const quelle = { hand: "von Hand", automatisch: "automatisch erkannt (CGM-Integration)" }[x.quelle] || x.quelle;
    let lauf = "";
    if (x.status === "laeuft") lauf = `noch ${restText(new Date(x.ende).getTime() - m.jetzt)}`;
    else if (x.gehalten_tage !== null && x.gehalten_tage !== undefined) lauf = `${ganz(x.gehalten_tage)} von ${ganz(x.soll_tage)} Tagen`;
    let rek;
    if (r && r.am) {
      rek = `<div class="abschnitt">Reklamation</div>
${wert("Reklamiert", esc(datumText(r.am, tz)))}
${wert("Fall", r.fall ? esc(r.fall) : f && f.quelle === "mail" ? esc(f.id) + " <small>(automatisch zugeordnet)</small>" : "")}
${wert("Ausgefallen", r.ausfall_am ? esc(tagZeit(r.ausfall_am, tz, m.heute)) : "")}
${wert("Grund", r.grund ? esc(r.grund) : "")}
${wert("Ersatz", f ? `<span class="badge ${fallCls(f)}">${esc(fallText(f, tz))}</span>` : "", f && f.antwort_datum ? `Dexcom-Antwort ${esc(datumText(f.antwort_datum, tz))}` : "")}
${wert("Notiz", r.notiz ? esc(r.notiz) : "")}
<div class="aktionen">
${f && ["offen", "zugesagt", "unterwegs"].includes(f.status) ? knopf("rek-ersatz", "Ersatz erhalten", "haupt", d, "mdi:package-variant-closed-check") : ""}
${f && f.status === "erhalten" && r.ersatz_erhalten_am ? knopf("rek-ersatz-offen", "Ersatz doch nicht da", "", d) : ""}
${r.erledigt ? knopf("rek-offen", "Wieder öffnen", "", d) : knopf("rek-erledigt", "Abschließen", "", d, "mdi:check")}
${knopf("rek-aendern", "Ändern", "", d, "mdi:pencil-outline")}
${knopf("rek-entfernen", "Entfernen", "rot", d)}
</div>`;
    } else {
      rek = `<div class="abschnitt">Reklamation</div>
<div class="info klein">${icon("mdi:information-outline")}<span>${x.status === "vorzeitig" ? `Hat nur ${ganz(x.gehalten_tage)} Tage gehalten. ` : ""}Geht der Transmitter vorzeitig kaputt: bei Dexcom reklamieren (dexcom.com/DETechSupport oder ${TEL_TECHNIK.replace(/^0800(\d{3})(\d{4})$/, "0800 $1 $2")}), dann hier markieren. Die Fallnummer wird automatisch zugeordnet, das Ersatzpaket per DHL erkannt und als Transmitter gezählt.</span></div>
<div class="aktionen">${knopf("reklamieren", "Reklamiert …", "", d, "mdi:message-alert-outline")}</div>`;
    }
    const verlauf = (x.verlauf || []).slice().reverse().map((v) => `<div class="mz"><span class="mn">${esc(v.was)}</span><span>${esc(tagZeit(v.z, tz, m.heute))}</span></div>`).join("");
    oben = `${wert("Status", `<span class="badge ${st.cls}">${esc(st.text)}</span>`, lauf)}
${wert("Seriennummer", x.sn ? `<b>${esc(x.sn)}</b>` : `<span class="klein">nicht eingetragen</span>`)}
${wert("In Betrieb seit", esc(tagZeit(x.start, tz, m.heute)), x.quelle === "automatisch" ? "Ende laut CGM-Integration minus Laufzeit" : "")}
${wert(x.status === "laeuft" ? "Läuft bis" : "Ende (Soll)", esc(tagZeit(x.ende, tz, m.heute)))}
${x.status === "laeuft" ? wert("Neuer Sensor bis", esc(tagZeit(x.start_bis, tz, m.heute)), "danach startet mit ihm keine Sensorsitzung mehr (weniger als eine Sensorlaufzeit übrig)") : ""}
${aktuell && tx.wechsel_am ? wert("Wechseln", `<b>${esc(tagZeit(tx.wechsel_am, tz, m.heute))}</b>`, "voraussichtlich beim Sensorwechsel") : ""}
${wert("Nicht mehr benutzt", x.entfernt_eff && x.status !== "laeuft" ? esc(tagZeit(x.entfernt_eff, tz, m.heute)) + (x.entfernt_manuell ? "" : " <small>(nächster Transmitter)</small>") : "")}
${wert("Sensoren", x.sensoren_n ? String(x.sensoren_n) : "")}
${wert("LOT", esc(x.lot || ""))}
${wert("Verwendbar bis", x.verwendbar_bis ? esc(datumText(x.verwendbar_bis, tz)) : "")}
${!x.lot || !x.sn ? `<div class="h3 warnt" data-a="tx-foto" role="button" tabindex="0">${icon("mdi:camera-outline")} ${x.sn ? "LOT und Verfall fehlen" : "Seriennummer fehlt"} – Verpackung fotografieren</div>` : ""}
${wert("Quelle", esc(quelle))}
${wert("Notiz", x.notiz ? esc(x.notiz) : "")}
${rek}
${verlauf ? `<details class="verlauf"><summary>Verlauf</summary>${verlauf}</details>` : ""}`;
  } else {
    oben = `<div class="info klein">${icon("mdi:information-outline")}<span>Noch kein Transmitter eingetragen. Der G6-Transmitter hält bis zu ${ganz(e.transmitter_tage || 90)} Tage ab der ersten Kopplung; mit weniger als einer Sensorlaufzeit Rest startet kein neuer Sensor mehr. Den laufenden unter „Neuer Transmitter“ eintragen${tx.relevant ? "" : " (nur bei Dexcom G6)"}.</span></div>`;
  }
  const vorrat = `<div class="abschnitt">Vorrat</div>
${tb ? wert("Im Vorrat", `<b>${tb.anzahl}</b> unbenutzt`, `gezählt ${esc(tagZeit(tb.seit, tz, m.heute))}: ${tb.inventur} · seitdem +${tb.geliefert} geliefert, −${tb.verbraucht} in Betrieb genommen`)
    : `<div class="info klein">${icon("mdi:counter")}<span>Vorrat noch nicht gezählt. Einmal zählen, danach rechnet die Karte selbst: jede G6-Quartalslieferung bringt ${ganz(e.transmitter_je_lieferung ?? 1)} mit, jeder neue Transmitter geht ab.</span></div>`}
${tb && tb.aelteste ? wert("Ältester", `aus der Lieferung vom ${esc(datumText(tb.aelteste.versendet, tz))}`, `in Betrieb nehmen bis ${esc(datumText(tb.aelteste.aktivieren_bis, tz))} (Dexcom: innerhalb von 5 Monaten nach Versand)`) : ""}
${d.zaehlen ? `${feld("Unbenutzt", eingabe("anzahl", d.f.anzahl, { type: "number", mode: "numeric", cls: "schmal", min: 0, max: 50 }), "Transmitter, die noch verpackt im Vorrat liegen")}<div class="aktionen">${knopf("tx-zaehlen-speichern", "Übernehmen", "haupt", d, "mdi:check")}${knopf("tx-zaehlen-ab", "Abbrechen", "", d)}</div>`
    : `<div class="aktionen">${knopf("tx-zaehlen", tb ? "Neu zählen …" : "Vorrat zählen …", tb ? "" : "haupt", d, "mdi:counter")}</div>`}`;
  const zeilen = (tx.liste || []).map((y) => txZeile(y, m, x && y.id === x.id)).join("");
  return `${dKopf(x ? txName(x) : "Transmitter", d)}
<div class="inhalt">
${oben}
${vorrat}
<div class="abschnitt">Alle Transmitter</div>
${zeilen || `<div class="klein">Noch keine eingetragen.</div>`}
<div class="aktionen">${knopf("tx-foto-neu", "Neuer Transmitter", "", d, "mdi:camera")}${knopf("tx-neu", "von Hand", "", d, "mdi:plus")}</div>
${fehlerZeile(d)}
</div>
${dFuss(x ? knopf("tx-loeschen", "Löschen", "rot", d) : "", (x ? knopf("tx-bearbeiten", "Bearbeiten", "", d, "mdi:pencil-outline") : "") + knopf("zu", "Schließen", "haupt", d))}`;
}

function transmitterForm(d, m) {
  const f = d.f;
  const neu = !!d.neu || !d.id;
  return `${dKopf(neu ? "Neuer Transmitter" : "Transmitter bearbeiten", d)}
<div class="inhalt">
${txFotoKopf(d)}
${neu && !d.foto ? `<div class="info klein">${icon("mdi:information-outline")}<span>Die Seriennummer steht auf dem Transmitter und seiner Verpackung. Liefert die CGM-Integration das Transmitter-Ende (z. B. YourLoops), wird ein neuer Transmitter auch von selbst eingetragen.</span></div>` : ""}
${feld("Seriennummer", eingabe("sn", f.sn, { ph: "z. B. 8XXXXX" }))}
${feld("In Betrieb seit", eingabe("gestartet", f.gestartet, { type: "datetime-local", cls: "mittel2" }), "erste Kopplung (mit dem ersten Sensor)")}
${feld("LOT", eingabe("lot", f.lot))}
${feld("Verwendbar bis", eingabe("verwendbar_bis", f.verwendbar_bis, { type: "date", cls: "mittel2" }))}
${neu ? "" : feld("Nicht mehr benutzt seit", eingabe("entfernt", f.entfernt, { type: "datetime-local", cls: "mittel2" }), "nur bei Ausfall – sonst gilt der nächste Transmitter")}
${feld("Notiz", textfeld("notiz", f.notiz))}
${schalter("aus_bestand", f.aus_bestand, "Aus dem eigenen Vorrat genommen", "Aus: zählt nicht gegen den Vorrat (z. B. Leihgerät)")}
${fehlerZeile(d)}
</div>
${dFuss(knopf("zurueck-ansicht", neu ? "Abbrechen" : "Zurück", "", d), knopf("tx-speichern", "Speichern", "haupt", d, "mdi:content-save-outline"))}`;
}

function lieferungAnsicht(d, m) {
  const L = ((m.daten && m.daten.lieferungen) || []).find((x) => x.id === d.id) || d.e;
  const tz = m.tz;
  const dhl = (L.dhl || []).slice().reverse().map((x) => `<div class="mz"><span class="mn">${esc(LIEF_STATUS[x.status] || x.status)}${x.fenster ? ` ${esc(x.fenster)} Uhr` : ""}${x.erwartet && x.status !== "zugestellt" ? ` · erwartet ${esc(datumText(x.erwartet, tz, false))}` : ""}</span><span>${esc(tagZeit(x.datum, tz, m.heute))}</span></div>`).join("");
  const faelle = (L.faelle || []).map((id) => (String(id).startsWith("K-") ? "Reklamation aus der Karte" : `Fall ${id}`)).join(", ");
  const unklar = L.art === "unbekannt";
  return `${dKopf(lieferungTitel(L, tz), d)}
<div class="inhalt">
${unklar ? `<div class="frage">${icon("mdi:help-circle-outline")}<span>DHL-Sendung von Dexcom ohne Versand- oder Reklamationsmail. Unter „Korrigieren“ Art und Anzahl eintragen, damit der Bestand stimmt.</span></div>` : ""}
${wert("Status", `<span class="badge ${L.status === "zugestellt" ? "ok" : "gut"}">${esc(LIEF_STATUS[L.status] || L.status)}</span>`, L.zugestellt_angenommen ? "angenommen („kommt heute“ ohne spätere Zustellmeldung)" : "")}
${wert("Art", esc(ART_NAME[L.art] || L.art), L.herkunft === "kundendienst" ? "Versand laut Antwort des Kundenservice (ohne Versandbestätigung)" : L.herkunft === "abgeleitet" ? "ohne Versandmail – als fällige Lieferung erkannt; sonst unter „Korrigieren“ ändern" : "")}
${wert("Inhalt", (L.modell ? `${L.anzahl}× ${esc(L.modell)}` : `${L.anzahl} ${L.anzahl === 1 ? "Sensor" : "Sensoren"} (Modell unbekannt)`) + (L.transmitter ? ` + ${L.transmitter} Transmitter` : ""), L.art === "quartal" && !(L.korrigiert || []).includes("anzahl") ? "Anzahl nach Einstellung – in der Mail steht keine" : "")}
${wert("Zeitraum", L.zeitraum_von ? `${esc(datumText(L.zeitraum_von, tz))} – ${esc(datumText(L.zeitraum_bis, tz))}` : "", L.teil ? (L.letzte ? "vorerst letzte Teillieferung" : "Teillieferung") : "")}
${wert("Bestellt", L.bestellt ? esc(tagZeit(L.bestellt, tz, m.heute)) : "")}
${wert("Versendet", L.versendet ? esc(tagZeit(L.versendet, tz, m.heute)) : "")}
${wert("Zugestellt", L.zugestellt_am ? esc(tagZeit(L.zugestellt_am, tz, m.heute)) : "")}
${wert("Sendung", L.sendungsnr ? `<a href="${esc(dhlLink(L.sendungsnr))}" target="_blank" rel="noreferrer">${esc(L.sendungsnr)}</a>` : "")}
${wert("Zu", faelle ? esc(faelle) : "")}
${wert("Folgerezept", L.folgerezept ? "bis " + esc(datumText(L.folgerezept, tz)) : "")}
${wert("Notiz", L.notiz ? esc(L.notiz) : "")}
${dhl ? `<div class="abschnitt">DHL</div>${dhl}` : ""}
<div class="aktionen">
${L.status !== "zugestellt" ? knopf("lief-zugestellt", "Ist angekommen", "haupt", d, "mdi:package-variant-closed-check") : knopf("lief-nicht", "Nicht angekommen", "", d)}
${L.manuell ? "" : L.aus ? knopf("lief-ein", "Wieder zählen", "", d) : knopf("lief-aus", "Ausblenden", "", d, "mdi:eye-off-outline")}
${!L.manuell && (L.korrigiert || []).length ? knopf("lief-reset", "Korrektur zurücksetzen", "", d) : ""}
</div>
${fehlerZeile(d)}
</div>
${dFuss(L.manuell ? knopf("lief-loeschen", "Löschen", "rot", d) : "", knopf("lief-form", "Korrigieren", "", d, "mdi:pencil-outline") + knopf("zu", "Schließen", "haupt", d))}`;
}

function lieferungForm(d, m) {
  const f = d.f;
  const neu = !d.id;
  const modelle = (m.daten && m.daten.modelle) || ["G6", "G7"];
  const arten = ["quartal", "ersatz", "shop", "sonstige"].concat(neu ? [] : ["unbekannt"]);
  return `${dKopf(neu ? "Lieferung eintragen" : "Lieferung korrigieren", d)}
<div class="inhalt">
${d.hinweis ? `<div class="frage">${icon("mdi:information-outline")}<span>${esc(d.hinweis)}</span></div>` : ""}
${feld("Art", chips("art", arten, f.art, { quartal: "Quartal", ersatz: "Ersatz", shop: "Webshop", sonstige: "Sonstige", unbekannt: "unklar" }))}
${feld("Anzahl", eingabe("anzahl", f.anzahl, { type: "number", mode: "numeric", cls: "schmal", min: 0, max: 60 }), "Sensoren in diesem Paket")}
${f.modell === "G6" || f.art === "ersatz" || (f.transmitter && f.transmitter !== "0") ? feld("Transmitter", eingabe("transmitter", f.transmitter, { type: "number", mode: "numeric", cls: "schmal", min: 0, max: 10 }), "G6-Transmitter im Paket – leer = automatisch (1 je G6-Quartalslieferung, 1 als Ersatz für einen reklamierten)") : ""}
${feld("Modell", chips("modell", modelle, f.modell))}
${feld("Versendet am", eingabe("versendet", f.versendet, { type: "datetime-local", cls: "mittel2" }), neu ? "" : "leer = laut Mail")}
${feld("Zugestellt am", eingabe("zugestellt_am", f.zugestellt_am, { type: "datetime-local", cls: "mittel2" }), neu ? "" : "leer = laut DHL")}
${f.art === "quartal" ? feld("Versorgungszeitraum", `<div class="von-bis">${eingabe("zeitraum_von", f.zeitraum_von, { type: "date", cls: "mittel2" })}<span>bis</span>${eingabe("zeitraum_bis", f.zeitraum_bis, { type: "date", cls: "mittel2" })}</div>`, neu ? "" : "leer = laut Mail") : ""}
${feld("Sendungsnummer", eingabe("sendungsnr", f.sendungsnr, { mode: "numeric", ph: "DHL-Sendungsnummer" }), neu ? "" : "leer = laut Mail")}
${feld("Notiz", textfeld("notiz", f.notiz))}
${fehlerZeile(d)}
</div>
${dFuss(knopf(neu ? "zu" : "zurueck-ansicht", neu ? "Abbrechen" : "Zurück", "", d), knopf("lief-speichern", "Speichern", "haupt", d, "mdi:content-save-outline"))}`;
}

function fallAnsicht(d, m) {
  const f = ((m.daten && m.daten.faelle) || []).find((x) => x.id === d.id) || d.e;
  const tz = m.tz;
  const karte = f.quelle === "karte";
  const s = f.sensor ? sensorById(m.daten, f.sensor) : null;
  const L = f.lieferung ? ((m.daten && m.daten.lieferungen) || []).find((x) => x.id === f.lieferung) : null;
  const sensoren = (m.daten.sensoren || []).slice(0, 25);
  const txListe = (m.daten.transmitter || {}).liste || [];
  const tr = f.sensor ? transmitterById(m.daten, f.sensor) : null;
  const gewaehlt = d.f.sensor ?? f.sensor ?? "";
  const txOpt = txListe.length ? `<optgroup label="Transmitter">${txListe.map((x) => `<option value="${esc(x.id)}"${x.id === gewaehlt ? " selected" : ""}>${esc(`${txName(x)} vom ${datumText(x.start, tz)}`)}</option>`).join("")}</optgroup>` : "";
  const auswahl = `<select data-f="sensor" class="voll"><option value="">– ${txListe.length ? "nichts zugeordnet" : "keinem Sensor"} –</option>${txListe.length ? `<optgroup label="Sensoren">` : ""}${sensoren.map((x) => `<option value="${esc(x.id)}"${x.id === (d.f.sensor ?? f.sensor ?? "") ? " selected" : ""}>${esc(`${x.modell || "?"} vom ${datumText(x.gesetzt, tz)}${x.lot ? " · LOT " + x.lot : ""}`)}</option>`).join("")}${txListe.length ? "</optgroup>" : ""}${txOpt}</select>`;
  const antwort = { ersatz: "Ersatz verschickt", kulanz: "Ersatz aus Kulanz", abgelehnt: "abgelehnt", info: "Antwort ohne Ersatz-Zusage" }[f.antwort] || "";
  return `${dKopf(karte ? "Reklamation" : `Fall ${f.id}`, d)}
<div class="inhalt">
${wert("Status", `<span class="badge ${fallCls(f)}">${esc(fallText(f, tz))}</span>`, f.historisch ? "vor Beginn der Bestandsführung – keine Erinnerung" : "")}
${wert("Eingereicht", esc(tagZeit(f.datum, tz, m.heute)), karte ? "aus der Karte (ohne Support-Mail)" : f.nummern && f.nummern.length > 1 ? `Fallnummern ${esc(f.nummern.join(", "))} – vermutlich doppelt abgeschickt` : "")}
${karte ? wert("Dexcom-Antwort", antwort ? esc(antwort) : `<span class="klein">keine Mail</span>`)
    : feld("Dexcom-Antwort", `<select data-f="antwort" class="voll">${[["mail", "wie aus den Mails"], ["keine", "keine Antwort"], ["ersatz", "Ersatz verschickt"], ["kulanz", "Ersatz aus Kulanz"], ["abgelehnt", "abgelehnt"], ["info", "Antwort ohne Ersatz-Zusage"]].map(([v, t]) => `<option value="${v}"${v === (d.f.antwort ?? (f.antwort_korrigiert ? f.antwort || "keine" : "mail")) ? " selected" : ""}>${esc(t)}</option>`).join("")}</select>`,
      f.antwort_korrigiert ? "von Hand geändert" : antwort ? `laut Mail: ${esc(antwort)}${f.antwort_datum ? ` · ${esc(datumText(f.antwort_datum, tz))}` : ""}` : "keine Antwort-Mail erkannt")}
${wert("Ersatzpaket", L ? `${esc(LIEF_STATUS[L.status] || L.status)}${L.zugestellt_am ? " " + esc(datumText(L.zugestellt_am, tz)) : ""}` : f.ersatz_erhalten_am ? "erhalten " + esc(datumText(f.ersatz_erhalten_am, tz)) + " (von Hand)" : `<span class="klein">nicht erkannt</span>`)}
${karte ? (tr ? wert("Transmitter", esc(`${tr.sn || "ohne Nummer"} vom ${datumText(tr.start, tz)}`)) : wert("Sensor", s ? esc(`${s.modell} vom ${datumText(s.gesetzt, tz)}`) : "")) : feld(txListe.length ? "Gehört zu" : "Sensor", auswahl)}
${karte ? "" : feld("Notiz", textfeld("notiz", d.f.notiz ?? f.notiz ?? ""))}
<div class="aktionen">
${["offen", "zugesagt", "unterwegs"].includes(f.status) ? knopf("fall-ersatz", "Ersatz erhalten", "haupt", d, "mdi:package-variant-closed-check") : ""}
${f.status === "erledigt" ? knopf("fall-offen", "Wieder öffnen", "", d) : knopf("fall-erledigt", "Abschließen", "", d, "mdi:check")}
${karte && s ? knopf("fall-sensor", "Zum Sensor", "", d, "mdi:needle") : ""}
${tr ? knopf("fall-tx", "Zum Transmitter", "", d, "mdi:access-point") : ""}
</div>
${fehlerZeile(d)}
</div>
${dFuss("", (karte ? "" : knopf("fall-speichern", "Speichern", "", d, "mdi:content-save-outline")) + knopf("zu", "Schließen", "haupt", d))}`;
}

function naechsteAnsicht(d, m) {
  const n = (m.daten && m.daten.naechste) || null;
  const tz = m.tz;
  const unterwegs = ((m.daten && m.daten.lieferungen) || []).filter((L) => (m.daten.unterwegs || []).includes(L.id));
  let inhalt;
  if (n) {
    inhalt = `${wert("Status", `<span class="badge ${n.status === "ueberfaellig" ? "rot" : ""}">${n.status === "ueberfaellig" ? `überfällig seit ${n.tage_ueber} ${n.tage_ueber === 1 ? "Tag" : "Tagen"}` : "angekündigt"}</span>`)}
${wert("Angekündigt", esc((n.angekuendigt || []).map((x) => datumText(x, tz, false)).join(", ")), "Mails „Information zu Ihrer Versorgung“")}
${wert(n.vorbereitung_ab ? "Vorbereitung ab" : "Versand geplant", esc(datumText(n.vorbereitung_ab || n.versand_geplant, tz)))}
${d.frist ? feld("Zustellung bis", eingabe("frist", d.f.frist, { type: "date", cls: "mittel2" }), "z. B. nach Auskunft von Dexcom")
    : wert("Zustellung bis", esc(datumText(n.frist, tz)), n.frist_manuell ? "von Hand geändert" : n.vorbereitung_ab ? "Dexcom: „bis zu zwei Wochen“ ab Vorbereitung" : "geplanter Versand + einige Tage")}
${n.status === "ueberfaellig" ? `<div class="frage">${icon("mdi:phone-outline")}<span>Noch keine Versandbestätigung. Dexcom-Kundenservice: <a href="tel:${TEL_KUNDE}">0800 724 6447</a> (Mo–Fr 8–17 Uhr) oder de.info@dexcom.com.</span></div>` : ""}`;
  } else if (unterwegs.length) {
    const L = unterwegs[0];
    inhalt = `${wert("Status", esc(LIEF_STATUS[L.status] || L.status))}${wert("Erwartet", L.erwartet ? esc(datumText(L.erwartet, tz)) : "")}${wert("Sendung", L.sendungsnr ? `<a href="${esc(dhlLink(L.sendungsnr))}" target="_blank" rel="noreferrer">${esc(L.sendungsnr)}</a>` : "")}`;
  } else {
    inhalt = `<p>Gerade ist keine Lieferung angekündigt oder unterwegs. Sobald Dexcom die nächste ankündigt („Information zu Ihrer Versorgung“), steht sie hier.</p>`;
  }
  if (n && d.frist) {
    inhalt += `<div class="aktionen">${knopf("naechste-frist-speichern", "Frist speichern", "haupt", d, "mdi:content-save-outline")}${n.frist_manuell ? knopf("naechste-frist-reset", "Wie aus der Mail", "", d) : ""}${knopf("naechste-frist-ab", "Abbrechen", "", d)}</div>`;
  } else if (n) {
    inhalt += `<div class="aktionen">${knopf("naechste-da", "Ist angekommen", "haupt", d, "mdi:package-variant-closed-check")}${knopf("naechste-frist", "Frist ändern", "", d, "mdi:calendar-edit")}${knopf("naechste-erledigt", "Ausblenden", "", d, "mdi:eye-off-outline")}</div>`;
  } else if (m.daten && m.daten.naechste_ausgeblendet) {
    inhalt += `<div class="aktionen">${knopf("naechste-offen", "Ausgeblendete Ankündigung zeigen", "", d, "mdi:eye-outline")}</div>`;
  }
  return `${dKopf("Nächste Lieferung", d)}
<div class="inhalt">${inhalt}${fehlerZeile(d)}</div>
${dFuss(knopf("gmail-dlg", "Im Postfach nachsehen", "", d, "mdi:email-search-outline"), knopf("zu", "Schließen", "haupt", d))}`;
}

function rezeptAnsicht(d, m) {
  const rz = m.daten && m.daten.folgerezept;
  const tz = m.tz;
  const terminFeld = feld("Im Original bis", eingabe("bis", d.f.bis ?? (rz ? rz.bis : ""), { type: "date", cls: "mittel2" }), "Termin aus dem Rezept bzw. der Dexcom-Mail");
  if (!rz) return `${dKopf("Folgerezept", d)}<div class="inhalt"><p>Aus den Dexcom-Mails ist noch kein Termin bekannt – du kannst ihn hier eintragen.</p>${terminFeld}${fehlerZeile(d)}</div>${dFuss(knopf("zu", "Schließen", "", d), knopf("rezept-termin", "Termin speichern", "haupt", d, "mdi:content-save-outline"))}`;
  return `${dKopf("Folgerezept", d)}
<div class="inhalt">
${d.termin ? terminFeld : wert("Im Original bis", `<b>${esc(datumText(rz.bis, tz))}</b>`, rz.manuell ? "von Hand eingetragen" : `aus der Dexcom-Mail vom ${esc(datumText(rz.aus_mail, tz))}`)}
${d.termin ? `<div class="aktionen">${knopf("rezept-termin", "Termin speichern", "haupt", d, "mdi:content-save-outline")}${rz.manuell ? knopf("rezept-termin-reset", "Wie aus den Mails", "", d) : ""}${knopf("rezept-termin-ab", "Abbrechen", "", d)}</div>` : ""}
${wert("Status", rz.verschickt ? `verschickt am ${esc(datumText(rz.verschickt_am, tz))} ✓` : "noch nicht verschickt")}
${!rz.verschickt && !d.termin ? feld("Verschickt am", eingabe("verschickt_am", d.f.verschickt_am ?? heuteIn(tz), { type: "date", cls: "mittel2" })) : ""}
${!d.termin ? `<div class="aktionen">${knopf("rezept-termin-form", "Termin ändern", "", d, "mdi:calendar-edit")}</div>` : ""}
<div class="info klein">${icon("mdi:information-outline")}<span>Dexcom braucht das Rezept im Original per Post (Dexcom Deutschland GmbH, Rotterdamer Platz 10, 55120 Mainz – Anschrift laut Dexcom, Stand November 2026). Zu früh eingereichte Rezepte verlieren ihre Gültigkeit.</span></div>
${fehlerZeile(d)}
</div>
${dFuss(rz.verschickt ? knopf("rezept-offen", "Doch nicht verschickt", "", d) : "", rz.verschickt ? knopf("zu", "Schließen", "haupt", d) : knopf("zu", "Schließen", "", d) + knopf("rezept-verschickt", "Rezept verschickt", "haupt", d, "mdi:email-fast-outline"))}`;
}

function einstellungenHtml(d, m) {
  const f = d.f;
  const daten = m.daten;
  const tz = m.tz;
  const modelle = daten.modelle || ["G6", "G7", "G7 15 Tage", "ONE+"];
  const b = daten.bestand;
  const inv = daten.inventur;
  const meld = (daten.meldungen || []).slice(0, 6).map((x) => `<div class="mz"><span class="mn">${esc(x.titel)}</span><span>${esc(x.text)}</span><span>${esc(tagZeit(x.z, tz, m.heute))}</span></div>`).join("");
  const tx = daten.transmitter || {};
  const pk = (daten.papierkorb || []).map((x) => `<div class="mz"><span class="mn">${esc(x.art === "transmitter" ? `${txName(x)} vom ${datumText(x.gesetzt, tz)}` : `${x.modell || "?"} vom ${datumText(x.gesetzt, tz)}${x.lot ? " · LOT " + x.lot : ""}`)}</span><span><button class="link" data-a="wiederherstellen" data-v="${esc(x.id)}">wiederherstellen</button></span></div>`).join("");
  const g = daten.gmail || {};
  return `${dKopf("Einstellungen", d)}
<div class="inhalt">
<div class="abschnitt">Bestand</div>
<div class="info klein">${icon("mdi:clipboard-list-outline")}<span>${b ? `Jetzt ${b.gesamt} ${b.gesamt === 1 ? "Sensor" : "Sensoren"} (${Object.entries(b.je_modell || {}).map(([k, v]) => `${v}× ${k}`).join(", ")}).` : "Noch keine Inventur."} ${inv ? `Zählung: ${esc(tagZeit(inv.zeit, tz, m.heute))} – seitdem zählen Lieferungen (+) und gesetzte Sensoren (−).` : ""}${tx.relevant ? ` Transmitter im Vorrat: ${tx.bestand ? tx.bestand.anzahl : "noch nicht gezählt"}.` : ""}</span></div>
${d.inventur ? `<div class="inv">${modelle.map((mo) => `<label>${esc(mo)}${eingabe("inv_" + mo, f["inv_" + mo], { type: "number", mode: "numeric", cls: "schmal", min: 0, max: 100 })}</label>`).join("")}${tx.relevant ? `<label>Transmitter${eingabe("inv_tx", f.inv_tx, { type: "number", mode: "numeric", cls: "schmal", min: 0, max: 50, ph: "–" })}</label>` : ""}</div>
<div class="aktionen">${knopf("inventur-speichern", "Bestand übernehmen", "haupt", d, "mdi:check")}${knopf("inventur-ab", "Abbrechen", "", d)}</div>` : `<div class="aktionen">${knopf("inventur", "Bestand jetzt zählen …", "", d, "mdi:counter")}</div>`}
<div class="abschnitt">Lieferungen</div>
${feld("Modell neuer Lieferungen", chips("modell_lieferung", modelle, f.modell_lieferung), "Die Dexcom-Mails nennen kein Modell")}
${feld("Sensoren je Quartal", eingabe("quartal_anzahl", f.quartal_anzahl, { type: "number", mode: "numeric", cls: "schmal", min: 0, max: 60 }))}
${feld("Transmitter je Quartal", eingabe("transmitter_je_lieferung", f.transmitter_je_lieferung, { type: "number", mode: "numeric", cls: "schmal", min: 0, max: 5 }), "nur bei G6-Lieferungen (G7 hat ihn im Sensor)")}
<div class="abschnitt">Transmitter (G6)</div>
${feld("Laufzeit", eingabe("transmitter_tage", f.transmitter_tage, { type: "number", mode: "numeric", cls: "schmal", min: 30, max: 200 }), "Tage ab der ersten Kopplung (Dexcom: bis zu 90)")}
${feld("Erinnerung", eingabe("transmitter_vorlauf_tage", f.transmitter_vorlauf_tage, { type: "number", mode: "numeric", cls: "schmal", min: 0, max: 60 }), "Tage vor dem Sensorwechsel, an dem ein neuer Transmitter fällig ist")}
<div class="abschnitt">Laufzeit je Modell</div>
<table class="lz"><tr><th></th><th>Tage</th><th>Nachlauf (h)</th></tr>${modelle.map((mo) => `<tr><td>${esc(mo)}</td><td>${eingabe("lz_" + mo + "_tage", f["lz_" + mo + "_tage"], { type: "number", mode: "decimal", cls: "schmal", min: 1, max: 30, step: "0.5" })}</td><td>${eingabe("lz_" + mo + "_nach", f["lz_" + mo + "_nach"], { type: "number", mode: "numeric", cls: "schmal", min: 0, max: 48 })}</td></tr>`).join("")}</table>
<div class="abschnitt">Benachrichtigungen</div>
${MELDEN.map(([k, n, t]) => schalter("m_" + k, f["m_" + k], n, t)).join("")}
${feld("Sensorwechsel", eingabe("wechsel_vorlauf_h", f.wechsel_vorlauf_h, { type: "number", mode: "decimal", cls: "schmal", min: 0, max: 48, step: "0.5" }), "Stunden vor Ablauf (nachts vorgezogen auf 21:30)")}
${feld("Ersatz fehlt nach", eingabe("ersatz_tage", f.ersatz_tage, { type: "number", mode: "numeric", cls: "schmal", min: 1, max: 60 }), "Tagen ohne Ersatzpaket")}
${feld("Rezept-Erinnerung", eingabe("rezept_vorlauf_tage", f.rezept_vorlauf_tage, { type: "number", mode: "numeric", cls: "schmal", min: 1, max: 120 }), "Tage vor dem Termin (zusätzlich 7 Tage vorher)")}
${feld("Bestand knapp ab", eingabe("knapp_tage", f.knapp_tage, { type: "number", mode: "numeric", cls: "schmal", min: 0, max: 60 }), "Tagen Restreichweite ohne Lieferung unterwegs")}
${feld("Fotos behalten", eingabe("foto_tage", f.foto_tage, { type: "number", mode: "numeric", cls: "schmal", min: 1, max: 60 }), "Tage, dann wird das Etikett-Foto gelöscht")}
${feld("Handy", eingabe("notify", f.notify, { ph: "mobile_app_…" }), `notify-Dienst · <button class="link" data-a="test-push">Test senden</button>`)}
${schalter("erkennung", f.erkennung, "Sensor- und Transmitterwechsel automatisch erkennen", "über die CGM-Entitäten (Auswahl unter Integration → Konfigurieren)")}
<div class="abschnitt">Mails</div>
<div class="info klein">${icon("mdi:email-outline")}<span>${g.fehler ? esc(g.fehler) + " · " : ""}${g.mails || 0} Mails von Dexcom, Support und DHL seit ${esc(datumText(f.gmail_ab, tz))}${g.stand ? `, zuletzt ${esc(tagZeit(g.stand, tz, m.heute))}` : ""}. Nur lesen – nichts wird markiert oder verschoben.</span></div>
<div class="aktionen">${knopf("gmail-dlg", "Jetzt prüfen", "", d, "mdi:email-search-outline")}${knopf("gmail-neu", "Alle neu einlesen", "", d)}</div>
${meld ? `<div class="abschnitt">Letzte Meldungen</div>${meld}` : ""}
${pk ? `<div class="abschnitt">Papierkorb</div>${pk}` : ""}
<div class="klein fusszeile">Karte ${DXK_VERSION} · Daten ${esc(daten.karte || "")}</div>
${fehlerZeile(d)}
</div>
${dFuss(knopf("zu", "Abbrechen", "", d), knopf("einst-speichern", "Speichern", "haupt", d, "mdi:content-save-outline"))}`;
}

export function dialogHtml(d, m) {
  if (d.art === "sensor") {
    if (d.schritt === "form") return sensorForm(d, m);
    if (d.schritt === "reklamation") return reklamationForm(d, m);
    if (d.schritt === "loeschen") return loeschFrage(d, "Diesen Sensor-Eintrag in den Papierkorb legen? Er zählt dann nicht mehr gegen den Bestand.", "zurueck-ansicht", "sensor-del");
    return sensorAnsicht(d, m);
  }
  if (d.art === "sensor-neu") return sensorForm(d, m);
  if (d.art === "transmitter") {
    if (d.schritt === "form") return transmitterForm(d, m);
    if (d.schritt === "reklamation") return reklamationForm(d, m);
    if (d.schritt === "loeschen") return loeschFrage(d, "Diesen Transmitter-Eintrag in den Papierkorb legen? Er zählt dann nicht mehr gegen den Vorrat.", "zurueck-ansicht", "tx-del");
    return transmitterAnsicht(d, m);
  }
  if (d.art === "lieferung") {
    if (d.schritt === "form") return lieferungForm(d, m);
    if (d.schritt === "loeschen") return loeschFrage(d, "Diese von Hand eingetragene Lieferung löschen?", "zurueck-ansicht", "lief-del");
    return lieferungAnsicht(d, m);
  }
  if (d.art === "lieferung-neu") return lieferungForm(d, m);
  if (d.art === "fall") return fallAnsicht(d, m);
  if (d.art === "naechste") return naechsteAnsicht(d, m);
  if (d.art === "rezept") return rezeptAnsicht(d, m);
  if (d.art === "einstellungen") return einstellungenHtml(d, m);
  return "";
}

// ---------- CSS ----------

const KARTEN_CSS = `
:host { display: block; }
ha-card { padding: 10px 12px 10px; }
.kopf { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; min-height: 8px; }
.titel { font-size: 1.1em; font-weight: 500; margin: 2px 0 4px; }
.spacer { flex: 1; }
.icon { border: 0; background: none; color: var(--secondary-text-color); padding: 6px; border-radius: 50%; cursor: pointer; display: inline-flex; }
.icon[disabled] { opacity: .35; cursor: default; }
.lade { display: inline-flex; color: var(--secondary-text-color); padding: 6px; }
.lade ha-icon { animation: dreh 1s linear infinite; }
@keyframes dreh { to { transform: rotate(360deg); } }
.status { display: flex; align-items: center; gap: 6px; font-size: .88em; margin: 2px 2px 4px; line-height: 1.35; }
.status ha-icon { --mdc-icon-size: 18px; flex: none; }
.status.ok { color: var(--success-color, #43a047); }
.status.fehler { color: var(--error-color, #db4437); }
.hero { border-radius: 14px; padding: 12px 14px 10px; background: var(--secondary-background-color, rgba(127,127,127,.08)); cursor: pointer; margin: 2px 0 8px; }
.hero:focus-visible, .z:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }
.h1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.h1 ha-icon { color: var(--primary-color); }
.hm { font-size: 1.25em; font-weight: 600; }
.hs { font-size: .9em; color: var(--secondary-text-color); }
.hs.warn { color: #c77700; }
.hz { font-size: .95em; white-space: nowrap; }
.hz b { font-size: 1.15em; }
.bar { height: 8px; border-radius: 4px; background: rgba(127,127,127,.2); margin: 9px 0 6px; overflow: hidden; }
.bar span { display: block; height: 100%; border-radius: 4px; background: var(--primary-color); }
.bar.warn span { background: #f0a020; }
.bar.aus span { background: var(--error-color, #db4437); }
.h2 { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-size: .84em; color: var(--secondary-text-color); }
.h3 { font-size: .82em; color: var(--secondary-text-color); margin-top: 4px; display: flex; align-items: center; gap: 4px; }
.h3 ha-icon { --mdc-icon-size: 16px; }
.warnt { color: #c77700; }
.leerhero { display: flex; gap: 12px; align-items: center; }
.leerhero div { display: flex; flex-direction: column; }
.leerhero span { font-size: .85em; color: var(--secondary-text-color); }
.kacheln { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 0 0 8px; }
@media (min-width: 900px) { :host(.breit) .kacheln { grid-template-columns: repeat(4, 1fr); } }
.kachel { text-align: left; border: 0; border-radius: 12px; padding: 9px 11px; background: var(--secondary-background-color, rgba(127,127,127,.08)); color: var(--primary-text-color); font: inherit; cursor: pointer; display: flex; flex-direction: column; gap: 1px; min-width: 0; border-left: 4px solid transparent; }
.kachel.warn { border-left-color: #f0a020; }
.kachel.rot { border-left-color: var(--error-color, #db4437); }
.kachel.gut { border-left-color: var(--success-color, #43a047); }
.kacheln > .kachel.tx { grid-column: 1 / -1; }
@media (min-width: 900px) { :host(.breit) .kacheln.mit-tx { grid-template-columns: repeat(5, 1fr); } :host(.breit) .kacheln > .kachel.tx { grid-column: auto; } }
.kl { display: flex; align-items: center; gap: 6px; font-size: .84em; color: var(--secondary-text-color); margin-bottom: 2px; }
.kl ha-icon { --mdc-icon-size: 17px; }
.kw { display: flex; align-items: baseline; gap: 5px; white-space: nowrap; }
.kw b { font-size: 1.3em; font-weight: 600; }
.kw b.klein-b { font-size: 1.05em; }
.kw span { font-size: .78em; color: var(--secondary-text-color); }
.ks { font-size: .75em; color: var(--secondary-text-color); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hinweis { display: flex; align-items: center; gap: 8px; font-size: .85em; border-radius: 8px; padding: 7px 10px; margin: 4px 0; background: rgba(127,127,127,.09); color: var(--primary-text-color); line-height: 1.35; }
.hinweis ha-icon { --mdc-icon-size: 18px; flex: none; }
.hinweis.warn { background: rgba(250,178,25,.16); }
.tabs { display: flex; border: 1px solid var(--divider-color); border-radius: 18px; overflow: hidden; margin: 8px 0 4px; }
.tabs button { flex: 1; border: 0; background: none; color: var(--primary-text-color); padding: 8px 2px; font: inherit; font-size: .9em; cursor: pointer; min-width: 0; }
.tabs button.an { background: var(--primary-color); color: var(--text-primary-color, #fff); }
.zahl { display: inline-block; min-width: 1.2em; padding: 0 4px; border-radius: 9px; background: #f0a020; color: #fff; font-size: .8em; font-weight: 600; }
.leiste { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 8px 0 4px; }
.knopf { display: inline-flex; align-items: center; gap: 2px; border: 0; border-radius: 18px; padding: 6px 14px 6px 9px; background: var(--primary-color); color: var(--text-primary-color, #fff); font: inherit; font-size: .92em; cursor: pointer; }
.knopf ha-icon { --mdc-icon-size: 18px; }
.knopf2 { display: inline-flex; align-items: center; gap: 2px; border: 1px solid var(--divider-color); border-radius: 18px; padding: 5px 12px 5px 8px; background: none; color: var(--primary-text-color); font: inherit; font-size: .9em; cursor: pointer; }
.knopf2 ha-icon { --mdc-icon-size: 18px; }
.h3.warnt { cursor: pointer; text-decoration: underline; }
.klein { font-size: .82em; color: var(--secondary-text-color); }
.erkl { margin: 6px 2px 4px; line-height: 1.4; }
.z { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; background: var(--secondary-background-color, rgba(127,127,127,.08)); margin: 4px 0; cursor: pointer; }
.z.aus { opacity: .5; }
.z.naechste { border-left: 4px solid var(--divider-color); }
.z.naechste.rot { border-left-color: var(--error-color, #db4437); }
.zt { display: flex; flex-direction: column; min-width: 3.1em; font-variant-numeric: tabular-nums; line-height: 1.3; }
.zt b { font-weight: 600; }
.zt span { font-size: .8em; color: var(--secondary-text-color); }
.zt ha-icon { color: var(--secondary-text-color); }
.zm { flex: 1; min-width: 0; }
.z1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
.weg { font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.z2 { display: flex; align-items: center; gap: 6px; font-size: .82em; color: var(--secondary-text-color); margin-top: 3px; flex-wrap: wrap; line-height: 1.35; }
.zr { white-space: nowrap; text-align: right; color: var(--secondary-text-color); }
.zr b { color: var(--primary-text-color); font-weight: 600; }
.zr.fall-erhalten ha-icon { color: var(--success-color, #43a047); }
.zr.fall-offen ha-icon, .zr.fall-zugesagt ha-icon { color: #f0a020; }
.badge { display: inline-flex; align-items: center; gap: 3px; font-size: .92em; padding: 1px 8px; border-radius: 9px; background: rgba(127,127,127,.18); color: var(--primary-text-color); white-space: nowrap; font-weight: 500; flex: none; }
.badge ha-icon { --mdc-icon-size: 13px; }
.badge.ok { background: rgba(67,160,71,.2); }
.badge.gut { background: rgba(42,120,214,.2); }
.badge.warn { background: rgba(250,178,25,.32); }
.badge.rot { background: rgba(219,68,55,.25); }
.tag-kopf { margin: 14px 2px 4px; font-weight: 500; font-size: .84em; color: var(--secondary-text-color); }
.summe { font-size: .78em; color: var(--secondary-text-color); margin: 10px 2px 0; line-height: 1.4; }
.leer { color: var(--secondary-text-color); padding: 18px 8px; text-align: center; line-height: 1.6; }
ha-icon { --mdc-icon-size: 20px; }
`;

const DIALOG_CSS = `
.hg { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 10000; display: flex; align-items: flex-end; justify-content: center; }
@media (min-width: 600px) { .hg { align-items: center; } }
.box { background: var(--card-background-color, var(--ha-card-background, #fff)); color: var(--primary-text-color, #212121); width: 100%; max-width: 560px; max-height: 92vh; overflow: auto; border-radius: 16px 16px 0 0; box-shadow: 0 8px 30px rgba(0,0,0,.35); font-family: var(--ha-font-family-body, Roboto, Noto, sans-serif); font-size: 15px; -webkit-overflow-scrolling: touch; }
@media (min-width: 600px) { .box { border-radius: 16px; } }
.kopf { position: sticky; top: 0; background: var(--card-background-color, var(--ha-card-background, #fff)); display: flex; align-items: center; padding: 14px 12px 6px 16px; gap: 8px; z-index: 2; }
.kopf h2 { margin: 0; font-size: 1.12em; font-weight: 500; flex: 1; }
.inhalt { padding: 0 16px 10px; }
.zeile { display: flex; align-items: center; gap: 8px; margin: 10px 0; flex-wrap: wrap; }
.zeile > label { min-width: 7.2em; color: var(--secondary-text-color); font-size: .9em; }
input, select, textarea { font: inherit; font-size: 16px; color: var(--primary-text-color); background: var(--input-fill-color, rgba(127,127,127,.1)); border: 1px solid var(--divider-color, rgba(127,127,127,.3)); border-radius: 8px; padding: 7px 9px; min-width: 0; box-sizing: border-box; }
textarea { resize: vertical; }
input[type=checkbox] { width: 20px; height: 20px; padding: 0; accent-color: var(--primary-color); flex: none; }
input::placeholder, textarea::placeholder { color: var(--secondary-text-color); opacity: .75; }
.voll { flex: 1; min-width: 10em; }
.schmal { width: 5.2em; }
.mittel { width: 8em; }
.mittel2 { width: 13.5em; max-width: 100%; }
.von-bis { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; flex: 1; }
.von-bis .mittel2 { width: 10.5em; }
.neben { color: var(--secondary-text-color); font-size: .8em; flex-basis: 100%; margin: -4px 0 0 calc(7.2em + 8px); line-height: 1.35; }
.schalter { display: flex; align-items: center; gap: 10px; margin: 12px 0; cursor: pointer; flex-wrap: wrap; }
.schalter small { color: var(--secondary-text-color); font-size: .8em; flex-basis: 100%; margin-left: 30px; margin-top: -6px; line-height: 1.35; }
.chips { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; flex: 1; }
.chips button { padding: 6px 12px; border-radius: 16px; border: 1px solid var(--divider-color, rgba(127,127,127,.3)); background: none; color: var(--primary-text-color); font: inherit; font-size: .92em; cursor: pointer; }
.chips button.an { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
.abschnitt { margin: 18px 0 2px; font-weight: 500; font-size: .9em; color: var(--primary-color); }
.wert { display: flex; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--divider-color, rgba(127,127,127,.18)); }
.wl { width: 8em; flex: none; color: var(--secondary-text-color); font-size: .9em; padding-top: 1px; }
.ww { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.ww small { display: block; color: var(--secondary-text-color); font-size: .82em; margin-top: 1px; }
.ww a { color: var(--primary-color); }
.badge { display: inline-flex; align-items: center; gap: 3px; font-size: .88em; padding: 1px 8px; border-radius: 9px; background: rgba(127,127,127,.18); white-space: nowrap; font-weight: 500; }
.badge.ok { background: rgba(67,160,71,.2); }
.badge.gut { background: rgba(42,120,214,.2); }
.badge.warn { background: rgba(250,178,25,.32); }
.badge.rot { background: rgba(219,68,55,.25); }
.info { display: flex; align-items: flex-start; gap: 8px; font-size: .9em; color: var(--primary-text-color); background: rgba(127,127,127,.09); border-radius: 8px; padding: 8px 10px; margin: 8px 0; line-height: 1.4; }
.info.klein { font-size: .84em; }
.info ha-icon { --mdc-icon-size: 18px; flex: none; color: var(--secondary-text-color); }
.frage { display: flex; gap: 8px; align-items: flex-start; background: rgba(250,178,25,.18); border-radius: 8px; padding: 10px; margin: 10px 0; font-size: .92em; line-height: 1.4; }
.frage ha-icon { --mdc-icon-size: 20px; color: #f0a020; flex: none; }
.frage a { color: var(--primary-color); font-weight: 500; }
.aktionen { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 4px; }
.mz { display: flex; flex-direction: column; gap: 1px; padding: 6px 2px; border-top: 1px solid var(--divider-color); font-size: .86em; color: var(--secondary-text-color); }
.mz .mn { color: var(--primary-text-color); font-weight: 500; }
.mz.tx { flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; cursor: pointer; border-radius: 6px; padding-left: 6px; padding-right: 6px; }
.mz.tx.an { background: rgba(127,127,127,.12); }
.mz.tx.an .mn { color: var(--primary-color); }
.chipzeile { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.fotozeile { display: flex; gap: 12px; align-items: flex-start; margin: 10px 0 4px; }
.vorschau { width: 112px; height: 112px; object-fit: cover; border-radius: 10px; flex: none; background: rgba(127,127,127,.15); }
.fotoinfo { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; min-width: 0; }
.fotostatus { display: flex; gap: 6px; align-items: flex-start; font-size: .88em; line-height: 1.4; }
.fotostatus ha-icon { --mdc-icon-size: 18px; flex: none; }
.fotostatus.ok ha-icon { color: var(--success-color, #43a047); }
.fotostatus.warn ha-icon { color: #f0a020; }
.fotostatus.lesen ha-icon { animation: dreh 1s linear infinite; }
@keyframes dreh { to { transform: rotate(360deg); } }
.foto { display: block; max-width: 100%; max-height: 60vh; border-radius: 10px; margin: 6px 0; }
details.verlauf { margin: 14px 0 4px; }
details.verlauf summary { cursor: pointer; color: var(--secondary-text-color); font-size: .9em; }
table.lz { border-collapse: collapse; margin: 4px 0; }
table.lz th { font-weight: 500; font-size: .82em; color: var(--secondary-text-color); text-align: left; padding: 2px 6px; }
table.lz td { padding: 3px 6px; }
.inv { display: flex; gap: 10px; flex-wrap: wrap; margin: 8px 0; }
.inv label { display: flex; flex-direction: column; gap: 3px; font-size: .85em; color: var(--secondary-text-color); }
.link { border: 0; background: none; color: var(--primary-color); font: inherit; padding: 0; cursor: pointer; text-decoration: underline; }
.fehler { color: var(--error-color, #db4437); font-size: .9em; margin: 10px 0; }
.fusszeile { margin-top: 14px; }
.fuss { position: sticky; bottom: 0; background: var(--card-background-color, var(--ha-card-background, #fff)); display: flex; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid var(--divider-color, rgba(127,127,127,.3)); align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.btn { display: inline-flex; align-items: center; gap: 6px; border: 0; border-radius: 18px; padding: 8px 14px; font: inherit; font-size: .95em; cursor: pointer; background: rgba(127,127,127,.15); color: var(--primary-text-color); }
.btn ha-icon { --mdc-icon-size: 18px; }
.btn.haupt { background: var(--primary-color); color: var(--text-primary-color, #fff); }
.btn.rot { color: var(--error-color, #db4437); background: none; padding-left: 8px; padding-right: 8px; }
.btn.rot-voll { background: var(--error-color, #db4437); color: #fff; }
.btn[disabled], .icon[disabled] { opacity: .5; cursor: default; }
.icon { border: 0; background: none; color: var(--secondary-text-color); padding: 6px; border-radius: 50%; cursor: pointer; display: inline-flex; }
p { margin: 8px 0; line-height: 1.45; }
ha-icon { --mdc-icon-size: 20px; }
`;

// ---------- Element ----------

if (typeof HTMLElement !== "undefined" && typeof customElements !== "undefined" && !customElements.get("dexcom-karte")) {
  class DexcomKarte extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._daten = null;
      this._ladeNr = 0;
      this._laedt = false;
      this._fehler = "";
      this._meldung = "";
      this._dlg = null;
      this._dlgHost = null;
      this._gmailLaeuft = false;
      this.shadowRoot.addEventListener("click", (e) => this._klick(e));
      this.shadowRoot.addEventListener("keydown", (e) => {
        const t = e.target;
        if ((e.key === "Enter" || e.key === " ") && t && t.dataset && t.dataset.a && t.getAttribute("role") === "button") {
          e.preventDefault();
          this._klick(e);
        }
      });
    }

    static getStubConfig() {
      return {};
    }

    setConfig(config) {
      this._cfg = { ...STANDARD, ...(config || {}) };
      if (!this._tab) {
        let t = "";
        try { t = localStorage.getItem("dxk_tab") || ""; } catch (e) { /* egal */ }
        const gueltig = (x) => TABS.some(([k]) => k === x);
        this._tab = gueltig(t) ? t : gueltig(this._cfg.tab) ? this._cfg.tab : "sensoren";
      }
      if (this._hass) this._render();
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._cfg) return;
      const st = this._sensor(hass);
      const ver = st && st.attributes ? st.attributes.version : undefined;
      if (!this._gestartet) {
        this._gestartet = true;
        this._ver = ver;
        this._render();
        this._laden();
        return;
      }
      if (ver !== undefined && ver !== this._ver) {
        this._ver = ver;
        clearTimeout(this._verTimer);
        this._verTimer = setTimeout(() => this._laden(), 800);
      }
    }

    getCardSize() {
      return 9;
    }

    getGridOptions() {
      return { columns: 12, min_columns: 6 };
    }

    connectedCallback() {
      this._sichtbar = () => {
        if (document.visibilityState === "visible" && this._hass && this._daten) this._laden();
      };
      document.addEventListener("visibilitychange", this._sichtbar);
      clearInterval(this._uhr);
      this._uhr = setInterval(() => {
        if (this._daten && !this._dlg) this._render();
      }, 60000);
      if (this._hass && this._daten) this._laden();
    }

    disconnectedCallback() {
      clearTimeout(this._verTimer);
      clearTimeout(this._meldungTimer);
      clearInterval(this._uhr);
      if (this._sichtbar) document.removeEventListener("visibilitychange", this._sichtbar);
      this._dialogZu();
      if (this._fotoInput) {
        this._fotoInput.remove();
        this._fotoInput = null;
      }
    }

    // ---- Daten ----

    async _dienst(name, daten) {
      // Integration (dexcom_bestand.*) bevorzugt, sonst die frühere Pyscript-Fassung (pyscript.dexcom_*)
      const integration = !!(this._hass.services && this._hass.services.dexcom_bestand);
      const res = await this._hass.callWS({
        type: "call_service",
        domain: integration ? "dexcom_bestand" : "pyscript",
        service: integration ? name.replace(/^dexcom_/, "") : name,
        service_data: daten || {},
        return_response: true,
      });
      return (res && res.response) || {};
    }

    // Sensor der Integration notfalls auch unter einer anderen Entitäts-ID finden
    _sensor(hass) {
      const st = hass.states[this._cfg.sensor];
      if (st) return st;
      const id = Object.keys(hass.states).find((e) => {
        const a = e.startsWith("sensor.dexcom_bestand") && hass.states[e].attributes;
        return a && "version" in a && "je_modell" in a;
      });
      return id ? hass.states[id] : null;
    }

    async _laden() {
      if (!this._hass) return;
      const nr = ++this._ladeNr;
      this._laedt = true;
      this._render();
      try {
        const antwort = await this._dienst("dexcom_liste", {});
        if (nr !== this._ladeNr) return;
        if (!antwort || antwort.ok === false || !antwort.sensoren) throw new Error((antwort && antwort.fehler) || "keine Daten");
        this._daten = antwort;
        this._fehler = "";
      } catch (err) {
        if (nr !== this._ladeNr) return;
        this._fehler = "Dexcom-Daten nicht erreichbar: " + fehlerText(err);
      }
      this._laedt = false;
      this._render();
      if (this._dlg && !this._dlg.busy && ["sensor", "lieferung", "fall", "naechste", "rezept", "transmitter"].includes(this._dlg.art) && this._dlg.schritt === "ansicht") this._dialogRender(false);
    }

    _tz() {
      return (this._hass && this._hass.config && this._hass.config.time_zone) || undefined;
    }

    _modell() {
      return {
        cfg: this._cfg,
        daten: this._daten,
        tab: this._tab,
        tz: this._tz(),
        heute: heuteIn(this._tz()),
        jetzt: Date.now(),
        laedt: this._laedt,
        fehler: this._fehler,
        meldung: this._meldung,
        gmailLaeuft: this._gmailLaeuft,
      };
    }

    _render() {
      if (!this._cfg || !this._hass) return;
      this.classList.toggle("breit", this.offsetWidth >= 700);
      this.shadowRoot.innerHTML = `<style>${KARTEN_CSS}</style>${karteHtml(this._modell())}`;
    }

    _melden(text) {
      this._meldung = text;
      clearTimeout(this._meldungTimer);
      this._meldungTimer = setTimeout(() => {
        this._meldung = "";
        this._render();
      }, 6000);
      this._render();
    }

    // ---- Klicks in der Karte ----

    _klick(e) {
      const el = e.composedPath().find((x) => x && x.dataset && x.dataset.a);
      if (!el || el.disabled) return;
      const a = el.dataset.a;
      const id = el.dataset.id;
      const d = this._daten;
      if (a === "tab") this._tabSetzen(el.dataset.v);
      else if (a === "tab-sensoren") this._tabSetzen("sensoren");
      else if (a === "tab-reklamationen") this._tabSetzen("reklamationen");
      else if (a === "einstellungen") { if (d) this._dialogEinstellungen(); }
      else if (a === "gmail") this._gmail(false);
      else if (a === "foto-neu") this._fotoAufnehmen("");
      else if (a === "foto-sensor") this._fotoAufnehmen(id);
      else if (a === "sensor") {
        const s = sensorById(d, id);
        if (s) this._dialogSensor(s);
      } else if (a === "sensor-neu") this._dialogSensorNeu();
      else if (a === "lieferung") {
        const L = ((d && d.lieferungen) || []).find((x) => x.id === id);
        if (L) this._dialogOeffnen({ art: "lieferung", id: L.id, e: L, schritt: "ansicht", f: {} });
      } else if (a === "lieferung-neu") this._dialogLieferungNeu();
      else if (a === "fall") {
        const f = ((d && d.faelle) || []).find((x) => x.id === id);
        if (f) this._dialogOeffnen({ art: "fall", id: f.id, e: f, schritt: "ansicht", f: {} });
      } else if (a === "naechste") this._dialogOeffnen({ art: "naechste", schritt: "ansicht", f: {} });
      else if (a === "rezept") this._dialogOeffnen({ art: "rezept", schritt: "ansicht", f: {} });
      else if (a === "transmitter") this._dialogTransmitter("");
    }

    _txFelder(x) {
      const tz = this._tz();
      return {
        sn: (x && x.sn) || "", gestartet: x ? alsEingabe(x.gestartet || x.start, tz) : jetztEingabe(tz), lot: (x && x.lot) || "",
        verwendbar_bis: (x && x.verwendbar_bis) || "", entfernt: x && x.entfernt ? alsEingabe(x.entfernt, tz) : "", notiz: (x && x.notiz) || "",
        aus_bestand: !x || x.aus_bestand !== false, anzahl: "",
      };
    }

    _dialogTransmitter(id) {
      const tx = (this._daten && this._daten.transmitter) || {};
      const x = (id && transmitterById(this._daten, id)) || tx.aktuell || (tx.liste || [])[0] || null;
      this._dialogOeffnen({ art: "transmitter", id: x ? x.id : "", e: x, schritt: "ansicht", f: this._txFelder(x), zaehlen: false, neu: false });
    }

    async _txSpeichern() {
      const d = this._dlg;
      const f = d.f;
      if (!f.gestartet) return this._dlgFehler("Bitte angeben, seit wann der Transmitter in Betrieb ist.");
      const neu = !!d.neu || !d.id;
      const daten = { aktion: "speichern", sn: f.sn.trim(), gestartet: eingabeZuText(f.gestartet), lot: f.lot.trim(), verwendbar_bis: f.verwendbar_bis || "", notiz: f.notiz, aus_bestand: !!f.aus_bestand };
      if (!neu) {
        daten.id = d.id;
        daten.entfernt = f.entfernt ? eingabeZuText(f.entfernt) : "";
      } else {
        for (const k of Object.keys(daten)) if (daten[k] === "") delete daten[k];
      }
      this._beschaeftigt(true);
      try {
        const r = await this._dienst("dexcom_transmitter", daten);
        if (!r || r.ok === false) throw new Error((r && r.fehler) || "fehlgeschlagen");
        await this._laden();
        if (this._dlg) {
          const x = transmitterById(this._daten, r.id);
          Object.assign(this._dlg, { id: r.id, e: x || this._dlg.e, neu: false, schritt: "ansicht", busy: false, fehler: "", zaehlen: false });
          this._dialogRender(true);
        }
        this._melden(r.aktion === "zusammengefuehrt" ? "Mit dem Transmitter gleicher Nummer zusammengeführt." : neu ? "Transmitter eingetragen." : "Gespeichert.");
      } catch (err) {
        this._dlgFehler(fehlerText(err));
      }
      return undefined;
    }

    _tabSetzen(v) {
      this._tab = v;
      try { localStorage.setItem("dxk_tab", v); } catch (err) { /* egal */ }
      this._render();
    }

    // ---- Dialoge öffnen ----

    _dialogOeffnen(d) {
      this._dlg = { busy: false, fehler: "", ...d };
      this._dialogZeigen();
    }

    _sensorFelder(s) {
      const tz = this._tz();
      return {
        modell: s.modell || "G7", gesetzt: alsEingabe(s.gesetzt, tz), lot: s.lot || "", ref: s.ref || "",
        verwendbar_bis: s.verwendbar_bis || "", hergestellt: s.hergestellt || "", code: s.code || "", sn: s.sn_uebernommen ? "" : s.sn || "",
        gtin: s.gtin || "", entfernt: s.entfernt ? alsEingabe(s.entfernt, tz) : "", notiz: s.notiz || "", aus_bestand: s.aus_bestand !== false,
      };
    }

    _dialogSensor(s) {
      this._dialogOeffnen({ art: "sensor", id: s.id, e: s, schritt: "ansicht", f: this._sensorFelder(s) });
    }

    _dialogSensorNeu() {
      const d = this._daten || {};
      const e = d.einstellungen || {};
      const b = d.bestand;
      let modell = (d.aktuell && d.aktuell.modell) || e.modell_lieferung || "G7";
      if (b && b.je_modell && !(b.je_modell[modell] > 0)) {
        const pos = Object.entries(b.je_modell).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
        if (pos.length) modell = pos[0][0];
      }
      this._dialogOeffnen({
        art: "sensor-neu", id: "", schritt: "form",
        f: { modell, gesetzt: jetztEingabe(this._tz()), lot: "", ref: "", verwendbar_bis: "", hergestellt: "", code: "", sn: "", gtin: "", entfernt: "", notiz: "", aus_bestand: true },
      });
    }

    _naechsteDa() {
      const daten = this._daten || {};
      const e = daten.einstellungen || {};
      const tz = this._tz();
      const grenze = Date.now() - 30 * 86400000;
      const unklar = (daten.lieferungen || [])
        .filter((L) => !L.manuell && !L.aus && L.art === "unbekannt" && Date.parse(L.zugestellt_am || L.versendet || "") > grenze)
        .sort((x, y) => String(y.versendet || "").localeCompare(String(x.versendet || "")))[0];
      if (unklar) {
        const f = this._liefFelder(unklar);
        Object.assign(f, { art: "quartal", anzahl: String(e.quartal_anzahl ?? 9), modell: e.modell_lieferung || "G7", transmitter: "" });
        if (!f.zugestellt_am) f.zugestellt_am = jetztEingabe(tz);
        this._dlg = {
          art: "lieferung", id: unklar.id, e: unklar, schritt: "form", busy: false, fehler: "", f, orig: this._liefFelder(unklar),
          hinweis: `Die DHL-Sendung vom ${datumText(unklar.versendet || unklar.zugestellt_am, tz)} hatte keine Versandmail von Dexcom – als diese Lieferung zählen? Anzahl und Modell prüfen und speichern.`,
          meldung: "Als Lieferung gezählt.",
        };
        return this._dialogRender(true);
      }
      this._dlg = {
        art: "lieferung-neu", id: "", schritt: "form", busy: false, fehler: "",
        f: { art: "quartal", anzahl: String(e.quartal_anzahl ?? 9), modell: e.modell_lieferung || "G7", zugestellt_am: jetztEingabe(tz), versendet: "", zeitraum_von: "", zeitraum_bis: "", sendungsnr: "", notiz: "", transmitter: "" },
        orig: {}, hinweis: "Die angekündigte Lieferung ist da, aber ohne Mail? Hier eintragen – dann zählt sie zum Bestand und die Ankündigung ist erledigt.",
        meldung: "Lieferung eingetragen – Ankündigung erledigt.",
      };
      return this._dialogRender(true);
    }

    _dialogLieferungNeu() {
      const e = (this._daten && this._daten.einstellungen) || {};
      this._dialogOeffnen({
        art: "lieferung-neu", id: "", schritt: "form",
        f: { art: "ersatz", anzahl: "1", modell: e.modell_lieferung || "G7", zugestellt_am: jetztEingabe(this._tz()), versendet: "", zeitraum_von: "", zeitraum_bis: "", sendungsnr: "", notiz: "", transmitter: "" },
        orig: {}, hinweis: "",
      });
    }

    _dialogEinstellungen() {
      const e = this._daten.einstellungen || {};
      const f = {
        modell_lieferung: e.modell_lieferung || "G7", quartal_anzahl: String(e.quartal_anzahl ?? 9), wechsel_vorlauf_h: String(e.wechsel_vorlauf_h ?? 2),
        ersatz_tage: String(e.ersatz_tage ?? 7), rezept_vorlauf_tage: String(e.rezept_vorlauf_tage ?? 28), knapp_tage: String(e.knapp_tage ?? 7),
        notify: e.notify || "", erkennung: e.erkennung !== false, gmail_ab: e.gmail_ab || "", foto_tage: String(e.foto_tage ?? 7),
        transmitter_tage: String(e.transmitter_tage ?? 90), transmitter_je_lieferung: String(e.transmitter_je_lieferung ?? 1),
        transmitter_vorlauf_tage: String(e.transmitter_vorlauf_tage ?? 7),
        inv_tx: (this._daten.transmitter || {}).bestand ? String(this._daten.transmitter.bestand.anzahl) : "",
      };
      for (const [k] of MELDEN) f["m_" + k] = !!(e.melden || {})[k];
      for (const mo of this._daten.modelle || []) {
        const lz = (e.laufzeit || {})[mo] || {};
        f["lz_" + mo + "_tage"] = String(lz.tage ?? 10);
        f["lz_" + mo + "_nach"] = String(lz.nachlauf_h ?? 0);
        f["inv_" + mo] = String(((this._daten.bestand || {}).je_modell || {})[mo] ?? 0);
      }
      this._dialogOeffnen({ art: "einstellungen", schritt: "form", f, inventur: false });
    }

    _dialogZeigen() {
      if (!this._dlgHost) {
        const host = document.createElement("div");
        host.setAttribute("data-dexcom", "dialog");
        const root = host.attachShadow({ mode: "open" });
        root.addEventListener("click", (e) => this._dlgKlick(e));
        root.addEventListener("change", (e) => this._dlgFeld(e, true));
        root.addEventListener("input", (e) => this._dlgFeld(e, false));
        this._esc = (e) => {
          if (e.key === "Escape" && this._dlg && !this._dlg.busy) this._dialogZu();
        };
        document.addEventListener("keydown", this._esc);
        document.body.appendChild(host);
        this._dlgHost = host;
      }
      this._dialogRender(true);
    }

    _dialogRender(oben) {
      if (!this._dlgHost || !this._dlg) return;
      const root = this._dlgHost.shadowRoot;
      const alteBox = root.querySelector(".box");
      const scroll = alteBox && !oben ? alteBox.scrollTop : 0;
      this._dlgHost.style.colorScheme = this._hass.themes && this._hass.themes.darkMode ? "dark" : "light";
      root.innerHTML = `<style>${DIALOG_CSS}</style><div class="hg" data-a="hg"><div class="box" role="dialog" aria-modal="true">${dialogHtml(this._dlg, this._modell())}</div></div>`;
      const box = root.querySelector(".box");
      if (box) box.scrollTop = scroll;
    }

    _dialogZu() {
      if (this._dlg && this._dlg.foto && this._dlg.foto.url) URL.revokeObjectURL(this._dlg.foto.url);
      if (this._dlgHost) {
        this._dlgHost.remove();
        this._dlgHost = null;
      }
      if (this._esc) document.removeEventListener("keydown", this._esc);
      this._esc = null;
      this._dlg = null;
    }

    _dlgFeld(e, geaendert) {
      const el = e.composedPath().find((x) => x && x.dataset && x.dataset.f);
      if (!el || !this._dlg || el.tagName === "BUTTON") return;
      const k = el.dataset.f;
      this._dlg.f[k] = el.type === "checkbox" ? el.checked : el.value;
      if (geaendert && (el.type === "checkbox" || el.tagName === "SELECT")) this._dialogRender(false);
    }

    _dlgKlick(e) {
      const pfad = e.composedPath();
      const el = pfad.find((x) => x && x.dataset && x.dataset.a);
      if (!el || !this._dlg) return;
      const d = this._dlg;
      const a = el.dataset.a;
      if (a === "hg") {
        if (pfad[0] === el && !d.busy) this._dialogZu();
        return;
      }
      if (d.busy || el.disabled) return;
      if (a === "zu") return this._dialogZu();
      if (a === "chip") {
        d.f[el.dataset.f] = el.dataset.v;
        return this._dialogRender(false);
      }
      const neu = (schritt, extra) => {
        if (d.foto && (schritt !== "form" || (extra && extra.f))) {
          if (d.foto.url) URL.revokeObjectURL(d.foto.url);
          d.foto = null;
        }
        Object.assign(d, { schritt, fehler: "" }, extra || {});
        this._dialogRender(true);
      };
      switch (a) {
        case "bearbeiten":
          return neu("form", { f: this._sensorFelder(sensorById(this._daten, d.id) || d.e) });
        case "zurueck-ansicht":
          if (d.art === "sensor-neu") return this._dialogZu();
          return neu("ansicht");
        case "loeschen":
          return neu("loeschen");
        case "sensor-del":
          return this._ausfuehren("dexcom_loeschen", { sensor_id: d.id }, "Sensor in den Papierkorb gelegt.");
        case "sensor-speichern":
          return this._sensorSpeichern();
        case "reklamieren": {
          const s = objektById(this._daten, d.id) || d.e;
          const tz = this._tz();
          return neu("reklamation", { f: { am: heuteIn(tz), ausfall_am: s.entfernt_eff && s.status !== "laeuft" ? alsEingabe(s.entfernt_eff, tz) : jetztEingabe(tz), fall: "", grund: "", notiz: "" } });
        }
        case "rek-aendern": {
          const s = objektById(this._daten, d.id) || d.e;
          const r = s.reklamation || {};
          const tz = this._tz();
          return neu("reklamation", { f: { am: r.am ? alsEingabe(r.am, tz).slice(0, 10) : heuteIn(tz), ausfall_am: r.ausfall_am ? alsEingabe(r.ausfall_am, tz) : "", fall: r.fall || "", grund: r.grund || "", notiz: r.notiz || "" } });
        }
        case "rek-speichern":
          return this._rekSpeichern();
        case "rek-ersatz":
          return this._ausfuehren("dexcom_reklamation", { sensor_id: d.id, aktion: "ersatz_erhalten" }, "Ersatz als erhalten vermerkt.", true);
        case "rek-ersatz-offen":
          return this._ausfuehren("dexcom_reklamation", { sensor_id: d.id, aktion: "ersatz_offen" }, "Ersatz wieder offen.", true);
        case "rek-erledigt":
          return this._ausfuehren("dexcom_reklamation", { sensor_id: d.id, aktion: "erledigt" }, "Reklamation abgeschlossen.", true);
        case "rek-offen":
          return this._ausfuehren("dexcom_reklamation", { sensor_id: d.id, aktion: "wieder_offen" }, "Reklamation wieder offen.", true);
        case "rek-entfernen":
          return this._ausfuehren("dexcom_reklamation", { sensor_id: d.id, aktion: "aufheben" }, "Reklamation entfernt.", true);
        case "lief-form": {
          const L = ((this._daten && this._daten.lieferungen) || []).find((x) => x.id === d.id) || d.e;
          return neu("form", { hinweis: "", f: this._liefFelder(L), orig: this._liefFelder(L) });
        }
        case "lief-speichern":
          return this._liefSpeichern();
        case "lief-zugestellt":
          return this._ausfuehren("dexcom_lieferung", { id: d.id, aktion: "zugestellt" }, "Als angekommen vermerkt.", true);
        case "lief-nicht":
          return this._ausfuehren("dexcom_lieferung", { id: d.id, aktion: "nicht_zugestellt" }, "Als nicht angekommen vermerkt.", true);
        case "lief-aus":
          return this._ausfuehren("dexcom_lieferung", { id: d.id, aktion: "ausblenden" }, "Lieferung ausgeblendet – zählt nicht mehr.", true);
        case "lief-ein":
          return this._ausfuehren("dexcom_lieferung", { id: d.id, aktion: "einblenden" }, "Lieferung zählt wieder.", true);
        case "lief-reset":
          return this._ausfuehren("dexcom_lieferung", { id: d.id, aktion: "zuruecksetzen" }, "Korrektur zurückgesetzt.", true);
        case "lief-loeschen":
          return neu("loeschen");
        case "lief-del":
          return this._ausfuehren("dexcom_lieferung", { id: d.id, aktion: "loeschen" }, "Lieferung gelöscht.");
        case "fall-ersatz":
          return this._fallAktion("ersatz_erhalten", "Ersatz als erhalten vermerkt.");
        case "fall-erledigt":
          return this._fallAktion("erledigt", "Abgeschlossen.");
        case "fall-offen":
          return this._fallAktion("offen", "Wieder offen.");
        case "fall-speichern":
          return this._fallSpeichern();
        case "tx-bearbeiten":
          return neu("form", { neu: false, f: this._txFelder(transmitterById(this._daten, d.id) || d.e) });
        case "tx-neu":
          return neu("form", { neu: true, f: this._txFelder(null) });
        case "tx-foto-neu":
          neu("form", { neu: true, f: this._txFelder(null) });
          return this._txKamera();
        case "tx-foto":
          neu("form", { neu: false, f: this._txFelder(transmitterById(this._daten, d.id) || d.e) });
          return this._txKamera();
        case "tx-foto-nochmal":
          return this._txKamera();
        case "tx-aus-foto": {
          const v = d.txVorschlag || {};
          const foto = d.foto;
          d.foto = null;
          this._dialogOeffnen({ art: "transmitter", id: "", e: null, schritt: "form", neu: true, zaehlen: false,
            f: { ...this._txFelder(null), ...v }, foto: foto ? { ...foto, status: "ok", text: v.text || foto.text } : null });
          return undefined;
        }
        case "tx-speichern":
          return this._txSpeichern();
        case "tx-loeschen":
          return neu("loeschen");
        case "tx-del":
          return this._ausfuehren("dexcom_transmitter", { aktion: "loeschen", id: d.id }, "Transmitter in den Papierkorb gelegt.");
        case "tx-zeigen": {
          const x = transmitterById(this._daten, el.dataset.v);
          if (!x) return undefined;
          return neu("ansicht", { id: x.id, e: x, zaehlen: false, neu: false, f: this._txFelder(x) });
        }
        case "tx-oeffnen":
        case "fall-tx": {
          const fx = a === "fall-tx" ? ((this._daten && this._daten.faelle) || []).find((y) => y.id === d.id) || d.e : null;
          const x = transmitterById(this._daten, a === "fall-tx" ? fx && fx.sensor : el.dataset.v);
          if (x) this._dialogOeffnen({ art: "transmitter", id: x.id, e: x, schritt: "ansicht", f: this._txFelder(x), zaehlen: false, neu: false });
          return undefined;
        }
        case "tx-zaehlen": {
          const tb = ((this._daten && this._daten.transmitter) || {}).bestand;
          d.zaehlen = true;
          d.f.anzahl = tb ? String(tb.anzahl) : "";
          return this._dialogRender(false);
        }
        case "tx-zaehlen-ab":
          d.zaehlen = false;
          return this._dialogRender(false);
        case "tx-zaehlen-speichern": {
          const v = String(d.f.anzahl ?? "").trim();
          if (!/^\d+$/.test(v)) return this._dlgFehler("Bitte die Anzahl als ganze Zahl angeben.");
          d.zaehlen = false;
          return this._ausfuehren("dexcom_transmitter", { aktion: "zaehlen", anzahl: Number(v) }, "Transmitter-Vorrat übernommen.", true);
        }
        case "fall-sensor": {
          const f = ((this._daten && this._daten.faelle) || []).find((x) => x.id === d.id) || d.e;
          const s = sensorById(this._daten, f.sensor);
          if (s) this._dialogSensor(s);
          return undefined;
        }
        case "foto-sensor":
        case "foto-nochmal":
          return this._fotoAufnehmen(d.id || "");
        case "foto-ansehen":
          return this._fotoAnsehen();
        case "foto-loeschen":
          d.fotoBild = null;
          return this._ausfuehren("dexcom_foto", { aktion: "loeschen", sensor_id: d.id }, "Foto gelöscht.", true);
        case "gmail-dlg":
          return this._gmail(false, true);
        case "gmail-neu":
          return this._gmail(true, true);
        case "rezept-verschickt":
          return this._ausfuehren("dexcom_rezept", { aktion: "verschickt", ...(d.f.verschickt_am ? { am: d.f.verschickt_am } : {}) }, "Folgerezept als verschickt vermerkt – keine Erinnerung mehr.");
        case "rezept-termin-form":
          d.termin = true;
          return this._dialogRender(false);
        case "rezept-termin-ab":
          d.termin = false;
          delete d.f.bis;
          return this._dialogRender(false);
        case "rezept-termin":
        case "rezept-termin-reset": {
          const bis = a === "rezept-termin-reset" ? "" : String(d.f.bis ?? ((this._daten && this._daten.folgerezept) || {}).bis ?? "");
          if (a === "rezept-termin" && !bis) return this._dlgFehler("Bitte ein Datum angeben.");
          d.termin = false;
          delete d.f.bis;
          return this._ausfuehren("dexcom_rezept", { aktion: "termin", bis }, bis ? "Termin gespeichert." : "Termin wieder aus den Mails.", true);
        }
        case "naechste-da":
          return this._naechsteDa();
        case "naechste-frist": {
          const n = (this._daten && this._daten.naechste) || {};
          d.frist = true;
          d.f.frist = n.frist || "";
          return this._dialogRender(false);
        }
        case "naechste-frist-ab":
          d.frist = false;
          return this._dialogRender(false);
        case "naechste-frist-speichern":
        case "naechste-frist-reset": {
          const am = a === "naechste-frist-reset" ? "" : String(d.f.frist || "");
          if (a === "naechste-frist-speichern" && !am) return this._dlgFehler("Bitte ein Datum angeben.");
          d.frist = false;
          return this._ausfuehren("dexcom_lieferung", { aktion: "ankuendigung_frist", am }, am ? "Frist geändert." : "Frist wieder wie aus der Mail.", true);
        }
        case "naechste-erledigt":
          return this._ausfuehren("dexcom_lieferung", { aktion: "ankuendigung_erledigt" }, "Ankündigung ausgeblendet.", true);
        case "naechste-offen":
          return this._ausfuehren("dexcom_lieferung", { aktion: "ankuendigung_offen" }, "Ankündigung wird wieder gezeigt.", true);
        case "rezept-offen":
          return this._ausfuehren("dexcom_rezept", { aktion: "offen" }, "Folgerezept wieder offen.", true);
        case "inventur":
          d.inventur = true;
          return this._dialogRender(false);
        case "inventur-ab":
          d.inventur = false;
          return this._dialogRender(false);
        case "inventur-speichern":
          return this._inventurSpeichern();
        case "einst-speichern":
          return this._einstSpeichern();
        case "test-push":
          return this._testPush();
        case "wiederherstellen":
          return this._ausfuehren("dexcom_loeschen", { sensor_id: el.dataset.v, wiederherstellen: true }, "Wiederhergestellt.", true);
        default:
          return undefined;
      }
    }

    // ---- Etikett-Foto ----

    _fotoDialog(sensorId) {
      const d = this._dlg;
      if (d && (d.id || "") === (sensorId || "") && (d.art === "sensor-neu" || (d.art === "sensor" && d.schritt === "form"))) return true;
      if (!sensorId) {
        this._dialogSensorNeu();
        return true;
      }
      const s = sensorById(this._daten, sensorId);
      if (!s) return false;
      if (d && d.art === "sensor" && d.id === sensorId) {
        Object.assign(d, { schritt: "form", fehler: "", f: this._sensorFelder(s) });
        this._dialogRender(true);
      } else this._dialogOeffnen({ art: "sensor", id: s.id, e: s, schritt: "form", f: this._sensorFelder(s) });
      return true;
    }

    _fotoAufnehmen(sensorId) {
      if (!this._fotoDialog(sensorId)) return;
      this._fotoZiel = sensorId || "";
      this._fotoEingabe().click();
    }

    _txKamera() {
      this._fotoZiel = { art: "tx" };
      this._fotoEingabe().click();
    }

    _fotoEingabe() {
      if (!this._fotoInput) {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "image/*";
        inp.setAttribute("capture", "environment");
        inp.setAttribute("data-dexcom", "foto");
        inp.style.display = "none";
        inp.addEventListener("change", () => {
          const datei = inp.files && inp.files[0];
          inp.value = "";
          if (!datei) return;
          const z = this._fotoZiel;
          if (z && typeof z === "object" && z.art === "tx") this._txFotoVerarbeiten(datei);
          else this._fotoVerarbeiten(datei, z);
        });
        document.body.appendChild(inp);
        this._fotoInput = inp;
      }
      return this._fotoInput;
    }

    async _txFotoVerarbeiten(datei) {
      const d = this._dlg;
      if (!d || d.art !== "transmitter" || d.schritt !== "form") return;
      const tz = this._tz();
      if (d.foto && d.foto.url) URL.revokeObjectURL(d.foto.url);
      const foto = { url: URL.createObjectURL(datei), status: "lesen", text: "Verpackung wird gelesen …", fehler: "" };
      d.foto = foto;
      this._dialogRender(false);
      let bild;
      try {
        bild = await createImageBitmap(datei);
      } catch (err) {
        foto.status = "warn";
        foto.text = "Das Foto ließ sich nicht öffnen.";
        if (this._dlg === d) this._dialogRender(false);
        return;
      }
      const erg = await barcodeLesen(bild, { snReicht: true });
      if (bild.close) bild.close();
      if (this._dlg !== d || d.foto !== foto) return;
      const g = erg.gs1;
      if (!g) {
        foto.status = "warn";
        foto.text = {
          nichts: "Kein Code erkannt. Die quadratischen Codes auf der Packung nah und scharf fotografieren (gut beleuchtet, ohne Spiegelung) – oder die Felder abtippen.",
          kein_gs1: "Code gelesen, aber ohne Packungsdaten. Felder bitte prüfen.",
          leser: "Der Code-Leser ließ sich nicht laden. Felder bitte abtippen.",
        }[erg.fehler] || "Verpackung nicht gelesen.";
      } else if (istSensorCode(g, ((this._daten && this._daten.einstellungen) || {}).gtin_modell)) {
        foto.status = "warn";
        foto.text = "Das ist ein Sensor-Etikett, keine Transmitter-Packung. Neue Sensoren unter „Neuer Sensor“ eintragen.";
      } else if (!d.neu && d.id && d.f.sn && g.sn && snKern(d.f.sn) !== snKern(g.sn)) {
        foto.status = "warn";
        foto.text = `Diese Packung gehört zu Transmitter ${g.sn}, nicht zu ${d.f.sn.trim()} – falsche Packung? Nichts übernommen.`;
      } else {
        for (const k of ["sn", "lot", "verwendbar_bis"]) if (g[k]) d.f[k] = g[k];
        const teile = [g.sn && `SN ${g.sn}`, g.lot && `LOT ${g.lot}`, g.verwendbar_bis && `verwendbar bis ${datumText(g.verwendbar_bis, tz)}`].filter(Boolean);
        if (erg.nurSn) {
          foto.status = "warn";
          foto.text = `Gelesen: ${teile.join(" · ")}. Für LOT und Verfall auch den unteren Code (UDI) scharf aufs Foto – oder abtippen.`;
        } else {
          foto.status = "ok";
          foto.text = "Gelesen: " + teile.join(" · ") + (istTransmitterCode(g) ? "" : ". Unbekannte Packung – Felder bitte prüfen.");
        }
      }
      this._dialogRender(false);
    }

    async _fotoVerarbeiten(datei, sensorId) {
      const tz = this._tz();
      if (!this._fotoDialog(sensorId)) return;
      const d = this._dlg;
      if (d.foto && d.foto.url) URL.revokeObjectURL(d.foto.url);
      const foto = { url: URL.createObjectURL(datei), status: "lesen", text: "Etikett wird gelesen …", fehler: "", upload: null };
      d.foto = foto;
      d.txVorschlag = null;
      this._dialogRender(false);
      let bild;
      try {
        bild = await createImageBitmap(datei);
      } catch (err) {
        foto.status = "warn";
        foto.text = "Das Foto ließ sich nicht öffnen.";
        if (this._dlg === d) this._dialogRender(false);
        return;
      }
      foto.upload = this._fotoHochladen(bild).catch((err) => {
        foto.fehler = "Foto nicht gespeichert: " + fehlerText(err);
        if (this._dlg === d && d.foto === foto) this._dialogRender(false);
        return null;
      });
      const erg = await barcodeLesen(bild);
      if (bild.close) bild.close();
      if (this._dlg !== d || d.foto !== foto) return;
      d.txVorschlag = null;
      if (erg.gs1 && istTransmitterCode(erg.gs1)) {
        const g = erg.gs1;
        const teile = [g.sn && `SN ${g.sn}`, g.lot && `LOT ${g.lot}`, g.verwendbar_bis && `verwendbar bis ${datumText(g.verwendbar_bis, tz)}`].filter(Boolean);
        d.txVorschlag = { sn: g.sn || "", lot: g.lot || "", verwendbar_bis: g.verwendbar_bis || "", text: "Gelesen: " + teile.join(" · ") };
        foto.status = "warn";
        foto.text = "Das ist eine Transmitter-Packung (" + teile.join(" · ") + ") – als Transmitter eintragen?";
      } else if (erg.gs1) {
        const g = erg.gs1;
        for (const k of ["lot", "ref", "verwendbar_bis", "hergestellt", "gtin", "sn"]) if (g[k]) d.f[k] = g[k];
        const mod = modellAusGtin(g.gtin, ((this._daten && this._daten.einstellungen) || {}).gtin_modell);
        if (mod) d.f.modell = mod;
        foto.status = "ok";
        foto.text = "Gelesen: " + [g.lot && `LOT ${g.lot}`, g.ref && `REF/PN ${g.ref.replace(/-/g, "‑")}`, g.verwendbar_bis && `verwendbar bis ${datumText(g.verwendbar_bis, tz)}`, g.sn && `SN ${g.sn}`].filter(Boolean).join(" · ") + (mod ? "" : ". Modell bitte prüfen – neue Packung.");
      } else {
        foto.status = "warn";
        foto.text = {
          nichts: "Kein Code erkannt. Den kleinen quadratischen Code auf dem Etikett nah und scharf fotografieren (gut beleuchtet, ohne Spiegelung) – oder die Felder abtippen.",
          kein_gs1: "Code gelesen, aber ohne Etikett-Daten. Felder bitte prüfen.",
          leser: "Der Code-Leser ließ sich nicht laden. Felder bitte abtippen.",
        }[erg.fehler] || "Etikett nicht gelesen.";
      }
      this._dialogRender(false);
    }

    _fotoHochladen(bild) {
      // gleich zeichnen (das Bild wird danach freigegeben), dann hochladen
      const f = Math.min(1, 1600 / Math.max(bild.width, bild.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bild.width * f));
      c.height = Math.max(1, Math.round(bild.height * f));
      c.getContext("2d").drawImage(bild, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/jpeg", 0.82);
      return this._dienst("dexcom_foto", { aktion: "hochladen", daten: url.split(",")[1] }).then((r) => {
        if (!r || r.ok === false || !r.foto_id) throw new Error((r && r.fehler) || "keine Antwort");
        return r.foto_id;
      });
    }

    async _fotoAnsehen() {
      const d = this._dlg;
      const s = sensorById(this._daten, d.id);
      if (!s || !s.foto) return;
      d.fotoLaedt = true;
      this._dialogRender(false);
      try {
        const r = await this._dienst("dexcom_foto", { aktion: "holen", foto_id: s.foto.id });
        if (!r || r.ok === false) throw new Error((r && r.fehler) || "Foto nicht da");
        if (this._dlg !== d) return;
        d.fotoBild = `data:${r.mime || "image/jpeg"};base64,${r.daten}`;
        d.fotoLaedt = false;
        this._dialogRender(false);
      } catch (err) {
        d.fotoLaedt = false;
        this._dlgFehler(fehlerText(err));
      }
    }

    _beschaeftigt(an) {
      if (!this._dlg) return;
      this._dlg.busy = an;
      if (an) this._dlg.fehler = "";
      this._dialogRender(false);
    }

    _dlgFehler(text) {
      if (!this._dlg) return;
      this._dlg.busy = false;
      this._dlg.fehler = text;
      this._dialogRender(false);
    }

    async _ausfuehren(dienst, daten, meldung, offenLassen) {
      this._beschaeftigt(true);
      try {
        const r = await this._dienst(dienst, daten);
        if (r && r.ok === false) throw new Error(r.fehler || "fehlgeschlagen");
        if (offenLassen && this._dlg) {
          this._dlg.busy = false;
          this._dlg.schritt = "ansicht";
          await this._laden();
          if (this._dlg) this._dialogRender(false);
          this._melden(meldung);
        } else {
          this._dialogZu();
          this._melden(meldung);
          this._laden();
        }
        return r;
      } catch (err) {
        this._dlgFehler(fehlerText(err));
        return null;
      }
    }

    async _sensorSpeichern() {
      const d = this._dlg;
      const f = d.f;
      if (!f.gesetzt) return this._dlgFehler("Bitte angeben, wann der Sensor gesetzt wurde.");
      const daten = {
        modell: f.modell, gesetzt: eingabeZuText(f.gesetzt), lot: f.lot.trim(), ref: f.ref.trim(), verwendbar_bis: f.verwendbar_bis || "",
        hergestellt: f.hergestellt || "", code: f.code.trim(), sn: f.sn.trim(), gtin: f.gtin.trim(), notiz: f.notiz, aus_bestand: !!f.aus_bestand,
      };
      if (d.id) {
        daten.id = d.id;
        if (f.entfernt) daten.entfernt = eingabeZuText(f.entfernt);
      } else {
        daten.quelle = "hand";
      }
      for (const k of Object.keys(daten)) if (daten[k] === "" && !d.id) delete daten[k];
      this._beschaeftigt(true);
      let fotoHinweis = "";
      if (d.foto && d.foto.upload) {
        const fid = await d.foto.upload;
        if (fid) {
          daten.foto = fid;
          const alt = d.id ? sensorById(this._daten, d.id) : null;
          if (!alt || ["automatisch", "hand", "verlauf"].includes(alt.quelle)) daten.quelle = "foto";
        } else fotoHinweis = " Foto konnte nicht gespeichert werden.";
      }
      try {
        const r = await this._dienst("dexcom_sensor", daten);
        if (!r || r.ok === false) throw new Error((r && r.fehler) || "fehlgeschlagen");
        const text = (r.aktion === "zusammengefuehrt" ? "Mit dem automatisch erkannten Sensor zusammengeführt." : d.id ? "Gespeichert." : "Sensor eingetragen.") + fotoHinweis;
        await this._laden();
        const s = sensorById(this._daten, r.id);
        if (d.foto && d.foto.url) URL.revokeObjectURL(d.foto.url);
        if (s) {
          this._dlg = { art: "sensor", id: s.id, e: s, schritt: "ansicht", busy: false, fehler: "", f: this._sensorFelder(s) };
          this._dialogRender(true);
        } else this._dialogZu();
        this._melden(text);
      } catch (err) {
        this._dlgFehler(fehlerText(err));
      }
      return undefined;
    }

    async _rekSpeichern() {
      const d = this._dlg;
      const f = d.f;
      if (!f.am) return this._dlgFehler("Bitte das Datum der Reklamation angeben.");
      const daten = { sensor_id: d.id, aktion: "setzen", am: f.am, fall: f.fall.trim(), grund: f.grund.trim(), notiz: f.notiz };
      if (f.ausfall_am) daten.ausfall_am = eingabeZuText(f.ausfall_am);
      return this._ausfuehren("dexcom_reklamation", daten, "Reklamation gespeichert – ich achte auf das Ersatzpaket.", true);
    }

    _liefFelder(L) {
      const tz = this._tz();
      return {
        art: L.art, anzahl: String(L.anzahl ?? ""), modell: L.modell || ((this._daten.einstellungen || {}).modell_lieferung || "G7"),
        zugestellt_am: L.zugestellt_am && !L.zugestellt_angenommen ? alsEingabe(L.zugestellt_am, tz) : "",
        versendet: L.versendet ? alsEingabe(L.versendet, tz) : "", zeitraum_von: L.zeitraum_von || "", zeitraum_bis: L.zeitraum_bis || "",
        sendungsnr: L.sendungsnr || "", notiz: L.notiz || "", transmitter: String(L.transmitter ?? ""),
      };
    }

    async _liefSpeichern() {
      const d = this._dlg;
      const f = d.f;
      const zusatzTx = {};
      const anz = String(f.anzahl ?? "").trim();
      if (anz !== "" && !/^\d+$/.test(anz)) return this._dlgFehler("Anzahl bitte als ganze Zahl.");
      const txAnz = String(f.transmitter ?? "").trim();
      if (txAnz !== "" && !/^\d+$/.test(txAnz)) return this._dlgFehler("Transmitter bitte als ganze Zahl.");
      if (!d.id ? txAnz !== "" : txAnz !== String((d.orig || {}).transmitter ?? "").trim()) zusatzTx.transmitter = txAnz === "" ? "" : Number(txAnz);
      if ((f.zeitraum_von || "") && (f.zeitraum_bis || "") && f.zeitraum_bis < f.zeitraum_von) return this._dlgFehler("Der Versorgungszeitraum endet vor seinem Beginn.");
      const zusatz = { ...zusatzTx };
      for (const k of ["versendet", "zeitraum_von", "zeitraum_bis", "sendungsnr"]) {
        if (k.startsWith("zeitraum") && f.art !== "quartal" && !(d.orig || {})[k]) continue;
        const wert = k === "versendet" ? eingabeZuText(f[k]) : String(f[k] || "").trim();
        const alt = k === "versendet" ? eingabeZuText((d.orig || {})[k]) : String((d.orig || {})[k] || "").trim();
        if (!d.id ? wert !== "" : wert !== alt) zusatz[k] = wert;
      }
      if (!d.id) {
        if (anz === "") return this._dlgFehler("Bitte die Anzahl angeben.");
        const daten = { aktion: "neu", art: f.art, anzahl: Number(anz), modell: f.modell, zugestellt_am: eingabeZuText(f.zugestellt_am), notiz: f.notiz, ...zusatz };
        return this._ausfuehren("dexcom_lieferung", daten, d.meldung || "Lieferung eingetragen.");
      }
      const daten = { id: d.id, aktion: "speichern", art: f.art, modell: f.modell, notiz: f.notiz, zugestellt_am: eingabeZuText(f.zugestellt_am), ...zusatz };
      if (anz !== "") daten.anzahl = Number(anz);
      return this._ausfuehren("dexcom_lieferung", daten, d.meldung || "Lieferung korrigiert.", true);
    }

    async _fallAktion(aktion, meldung) {
      const d = this._dlg;
      const f = ((this._daten && this._daten.faelle) || []).find((x) => x.id === d.id) || d.e;
      if (f.quelle === "karte") {
        const map = { ersatz_erhalten: "ersatz_erhalten", erledigt: "erledigt", offen: "wieder_offen" };
        return this._ausfuehren("dexcom_reklamation", { sensor_id: f.sensor, aktion: map[aktion] }, meldung, true);
      }
      return this._ausfuehren("dexcom_fall", { fall_id: f.id, aktion }, meldung, true);
    }

    async _fallSpeichern() {
      const d = this._dlg;
      const f = ((this._daten && this._daten.faelle) || []).find((x) => x.id === d.id) || d.e;
      this._beschaeftigt(true);
      try {
        if (d.f.sensor !== undefined && (d.f.sensor || "") !== (f.sensor || "")) {
          const r = await this._dienst("dexcom_fall", { fall_id: f.id, aktion: "zuordnen", sensor_id: d.f.sensor || "", fall_datum: f.datum });
          if (r && r.ok === false) throw new Error(r.fehler);
        }
        if (d.f.notiz !== undefined && d.f.notiz !== (f.notiz || "")) {
          const r = await this._dienst("dexcom_fall", { fall_id: f.id, aktion: "notiz", notiz: d.f.notiz });
          if (r && r.ok === false) throw new Error(r.fehler);
        }
        const antwortAlt = f.antwort_korrigiert ? f.antwort || "keine" : "mail";
        if (d.f.antwort !== undefined && d.f.antwort !== antwortAlt) {
          const r = await this._dienst("dexcom_fall", { fall_id: f.id, aktion: "antwort", antwort: d.f.antwort });
          if (r && r.ok === false) throw new Error(r.fehler);
        }
        this._dialogZu();
        this._melden("Gespeichert.");
        this._laden();
      } catch (err) {
        this._dlgFehler(fehlerText(err));
      }
    }

    async _inventurSpeichern() {
      const f = this._dlg.f;
      const bestand = {};
      for (const mo of this._daten.modelle || []) {
        const v = String(f["inv_" + mo] ?? "").trim();
        if (v === "") continue;
        if (!/^\d+$/.test(v)) return this._dlgFehler(`Bestand ${mo}: bitte eine ganze Zahl.`);
        bestand[mo] = Number(v);
      }
      const txv = String(f.inv_tx ?? "").trim();
      if (txv !== "" && !/^\d+$/.test(txv)) return this._dlgFehler("Transmitter: bitte eine ganze Zahl.");
      this._beschaeftigt(true);
      try {
        const r = await this._dienst("dexcom_inventur", txv !== "" ? { bestand, transmitter: Number(txv) } : { bestand });
        if (!r || r.ok === false) throw new Error((r && r.fehler) || "fehlgeschlagen");
        await this._laden();
        if (this._dlg) {
          this._dlg.busy = false;
          this._dlg.inventur = false;
          this._dialogRender(false);
        }
        this._melden("Bestand übernommen.");
      } catch (err) {
        this._dlgFehler(fehlerText(err));
      }
      return undefined;
    }

    async _einstSpeichern() {
      const f = this._dlg.f;
      const laufzeit = {};
      for (const mo of this._daten.modelle || []) laufzeit[mo] = { tage: f["lz_" + mo + "_tage"], nachlauf_h: f["lz_" + mo + "_nach"] };
      const melden = {};
      for (const [k] of MELDEN) melden[k] = !!f["m_" + k];
      const e = {
        laufzeit, melden, modell_lieferung: f.modell_lieferung, quartal_anzahl: f.quartal_anzahl, wechsel_vorlauf_h: f.wechsel_vorlauf_h,
        ersatz_tage: f.ersatz_tage, rezept_vorlauf_tage: f.rezept_vorlauf_tage, knapp_tage: f.knapp_tage, notify: f.notify, erkennung: !!f.erkennung,
        foto_tage: f.foto_tage, transmitter_tage: f.transmitter_tage, transmitter_je_lieferung: f.transmitter_je_lieferung,
        transmitter_vorlauf_tage: f.transmitter_vorlauf_tage,
      };
      return this._ausfuehren("dexcom_einstellungen", { einstellungen: e }, "Einstellungen gespeichert.");
    }

    async _testPush() {
      this._beschaeftigt(true);
      try {
        const r = await this._dienst("dexcom_test_push", {});
        this._dlg.busy = false;
        this._dlg.fehler = r && r.ok ? "" : "Senden ging nicht – notify-Dienst prüfen.";
        this._dialogRender(false);
        if (r && r.ok) this._melden("Test-Benachrichtigung gesendet.");
      } catch (err) {
        this._dlgFehler(fehlerText(err));
      }
    }

    async _gmail(neu, ausDialog) {
      if (this._gmailLaeuft) return;
      this._gmailLaeuft = true;
      if (ausDialog) this._beschaeftigt(true);
      this._render();
      try {
        const r = await this._dienst("dexcom_gmail", { neu: !!neu });
        if (r && r.ok === false) throw new Error(r.fehler || "Postfach nicht erreichbar");
        this._gmailLaeuft = false;
        if (ausDialog && this._dlg) {
          this._dlg.busy = false;
          this._dialogRender(false);
        }
        await this._laden();
        if (ausDialog && this._dlg) this._dialogRender(false);
        this._melden(r && r.neu ? `${r.neu} neue Mail${r.neu === 1 ? "" : "s"} gelesen.` : "Keine neuen Dexcom-Mails.");
      } catch (err) {
        this._gmailLaeuft = false;
        if (ausDialog && this._dlg) this._dlgFehler(fehlerText(err));
        else {
          this._fehler = "Mails: " + fehlerText(err);
          this._render();
        }
      }
    }
  }

  customElements.define("dexcom-karte", DexcomKarte);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "dexcom-karte",
    name: "Dexcom-Karte",
    description: "Dexcom-Sensoren: Bestand, aktueller Sensor, Lieferungen und Reklamationen (Integration Dexcom Sensorbestand)",
  });
  console.info(`%c DEXCOM-KARTE %c ${DXK_VERSION} `, "background:#3f7fe0;color:#fff;border-radius:3px 0 0 3px", "background:#ddd;color:#000;border-radius:0 3px 3px 0");
}

// ------------------------------------------------------------------ Seitenleiste
// Eigene Seite „Dexcom“ (von der Integration angemeldet): Kopfzeile mit Menüknopf + Karte.
if (typeof HTMLElement !== "undefined" && typeof customElements !== "undefined") {
  class DexcomPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    this._hass = hass;
    this._zeichnen();
  }

  get hass() {
    return this._hass;
  }

  set narrow(narrow) {
    this._narrow = narrow;
    this._zeichnen();
  }

  set panel(panel) {
    this._panel = panel;
    this._zeichnen();
  }

  set route(route) {
    this._route = route;
  }

  _zeichnen() {
    if (!this._hass) return;
    if (!this._karte) {
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; min-height: 100%; background: var(--primary-background-color); }
          .kopf {
            position: sticky; top: 0; z-index: 2;
            display: flex; align-items: center; gap: 4px;
            height: var(--header-height, 56px); padding: 0 16px 0 4px; box-sizing: border-box;
            background: var(--app-header-background-color, var(--primary-color));
            color: var(--app-header-text-color, var(--text-primary-color, #fff));
            border-bottom: var(--app-header-border-bottom, none);
            padding-top: env(safe-area-inset-top);
          }
          .kopf button {
            display: flex; align-items: center; justify-content: center;
            width: 48px; height: 48px; border: 0; border-radius: 50%;
            background: none; color: inherit; cursor: pointer;
          }
          .kopf button[hidden] { display: none; }
          .titel { font-size: 20px; font-weight: 400; margin-left: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .inhalt { max-width: 900px; margin: 0 auto; padding: 8px; box-sizing: border-box; }
        </style>
        <div class="kopf">
          <button class="menue" title="Menü" aria-label="Menü"><ha-icon icon="mdi:menu"></ha-icon></button>
          <div class="titel"></div>
        </div>
        <div class="inhalt"></div>`;
      this.shadowRoot.querySelector(".menue").addEventListener("click", () => {
        this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }));
      });
      const karte = document.createElement("dexcom-karte");
      const cfg = (this._panel && this._panel.config && this._panel.config.karte) || {};
      karte.setConfig(cfg);
      this.shadowRoot.querySelector(".inhalt").appendChild(karte);
      this._karte = karte;
    }
    const menue = this.shadowRoot.querySelector(".menue");
    menue.hidden = !(this._narrow || this._hass.dockedSidebar === "always_hidden");
    const titel = (this._panel && this._panel.title) || "Dexcom";
    this.shadowRoot.querySelector(".titel").textContent = titel;
    this._karte.hass = this._hass;
  }
}

  if (!customElements.get("dexcom-panel")) {
    customElements.define("dexcom-panel", DexcomPanel);
  }
}
