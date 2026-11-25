"""Reine Logik des Dexcom-Sensorbestands (ohne Home-Assistant-Abhängigkeiten).

Wird von ``kern.py`` aufgerufen und ist 1:1 aus der früheren Pyscript-Fassung übernommen:
Mail-Erkennung (Dexcom-Ankündigungen, Versand, Webshop, DHL, Support-Fälle), Ableitung von
Lieferungen und Reklamationsfällen, Auswertung der Sensoren, Bestand, fällige Meldungen,
Bearbeitung von Sensoren/Reklamationen/Fällen/Lieferungen, Einstellungen und die Ausgabe für
die Karte. Alle Funktionen sind synchron und arbeiten nur auf den übergebenen Daten.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime, time as dtime, timedelta

try:
    from .const import VERSION
except ImportError:  # Tests ohne Paket
    VERSION = "test"

VERLAUF_MAX = 30
PAPIERKORB = 20
MELDUNGEN_MAX = 40
KUNDENSERVICE = "0800 724 6447 (Mo–Fr 8–17 Uhr)"

MODELLE = ["G6", "G7", "G7 15 Tage", "ONE+"]
ARTEN = ["quartal", "ersatz", "shop", "unbekannt", "sonstige"]
_STANDARD_LAUFZEIT = {
    "G6": {"tage": 10, "nachlauf_h": 0},
    "G7": {"tage": 10, "nachlauf_h": 12},
    "G7 15 Tage": {"tage": 15, "nachlauf_h": 12},
    "ONE+": {"tage": 10, "nachlauf_h": 12},
}
_STANDARD_MELDEN = {"wechsel": True, "neu_erkannt": True, "lieferung": True, "ersatz": True, "rezept": True,
                   "transmitter": True}
_STANDARD_EINST = {
    "laufzeit": _STANDARD_LAUFZEIT,
    "modell_lieferung": "G7",
    "quartal_anzahl": 9,
    "ersatz_anzahl": 1,
    "notify": "",
    "melden": _STANDARD_MELDEN,
    "wechsel_vorlauf_h": 2,
    "ruhe_von": 22,
    "ruhe_bis": 7,
    "ersatz_tage": 7,
    "rezept_vorlauf_tage": 28,
    "knapp_tage": 7,
    "erkennung": True,
    "gmail_ab": "",
    "start": "",
    "foto_tage": 7,
    "gtin_modell": {"00386270000927": "G6"},
    "transmitter_tage": 90,
    "transmitter_je_lieferung": 1,
    "transmitter_vorlauf_tage": 7,
}
_SENSOR_FELDER = ["modell", "ref", "lot", "hergestellt", "verwendbar_bis", "gtin", "code", "sn",
                  "gesetzt", "entfernt", "notiz", "quelle", "aus_bestand"]
_TRANSMITTER_FELDER = ["sn", "lot", "verwendbar_bis", "gestartet", "entfernt", "notiz", "quelle", "aus_bestand"]
TRANSMITTER_AKTIVIEREN_MONATE = 5  # Dexcom: G6-Transmitter innerhalb von 5 Monaten nach Versand aktivieren
_WT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
_ST_LIEF = {"unterwegs": "unterwegs", "heute": "heute", "gleich": "heute", "verzoegert": "verzoegert",
            "abholbereit": "abholbereit", "zurueck": "zurueck", "info": "unterwegs", "zugestellt": "unterwegs"}


def _neue_id(p):
    return p + uuid.uuid4().hex[:8]


def _txt(s, n):
    return re.sub(r"\s+", " ", str(s if s is not None else "")).strip()[:n]


def _zeit(s, tz):
    """ISO-Zeit, „JJJJ-MM-TT HH:MM“ oder „TT.MM.JJ(JJ) HH:MM“ → datetime mit Zeitzone (sonst None)."""
    if s is None or s == "":
        return None
    if isinstance(s, datetime):
        return s if s.tzinfo else s.replace(tzinfo=tz)
    if isinstance(s, date):
        return datetime(s.year, s.month, s.day, tzinfo=tz)
    t = str(s).strip().replace("Uhr", "").strip()
    m = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:[ ,T]+(\d{1,2})[:.](\d{2}))?$", t)
    if m:
        j = int(m.group(3))
        j = j + 2000 if j < 100 else j
        try:
            return datetime(j, int(m.group(2)), int(m.group(1)), int(m.group(4) or 0), int(m.group(5) or 0), tzinfo=tz)
        except ValueError:
            return None
    t = t.replace("Z", "+00:00")
    if len(t) > 10 and t[10] == " ":
        t = t[:10] + "T" + t[11:]
    try:
        d = datetime.fromisoformat(t)
    except ValueError:
        return None
    if d.tzinfo is None:
        return d.replace(tzinfo=tz)
    return d.astimezone(tz)


def _datum(s):
    """„JJJJ-MM-TT“, „JJJJ/MM/TT“, „TT.MM.JJ(JJ)“ oder ISO-Zeit → date (sonst None)."""
    if s is None or s == "":
        return None
    if isinstance(s, datetime):
        return s.date()
    if isinstance(s, date):
        return s
    t = str(s).strip()
    m = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{2,4})", t)
    if m:
        j = int(m.group(3))
        j = j + 2000 if j < 100 else j
        try:
            return date(j, int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None
    m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})", t)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    return None


def _iso(d):
    if d is None:
        return None
    if isinstance(d, datetime):
        return d.isoformat(timespec="seconds")
    return d.isoformat()


def _tag_txt(d, heute):
    if d == heute:
        return "heute"
    if d == heute + timedelta(days=1):
        return "morgen"
    if d == heute - timedelta(days=1):
        return "gestern"
    return _WT[d.weekday()] + " " + d.strftime("%d.%m.")


def _wann(dt, jetzt):
    return _tag_txt(dt.date(), jetzt.date()) + " " + dt.strftime("%H:%M")


def _tage_txt(h):
    if h is None:
        return "?"
    if h < 36:
        return str(int(round(h))) + " h"
    t = int(h / 2.4 + 0.5) / 10.0
    s = ("%.1f" % t).replace(".", ",")
    if s.endswith(",0"):
        s = s[:-2]
    return s + (" Tag" if s == "1" else " Tage")


def _sensoren_txt(n):
    return str(n) + (" Sensor" if n == 1 else " Sensoren")


def _modell_norm(m):
    t = str(m or "").strip().upper().replace("DEXCOM", "").strip()
    if not t:
        return None
    if "G7" in t and "15" in t:
        return "G7 15 Tage"
    if "G7" in t:
        return "G7"
    if "G6" in t:
        return "G6"
    if "ONE" in t:
        return "ONE+"
    return None


def _laufzeit(einst, modell):
    lz = ((einst or {}).get("laufzeit") or {}).get(modell) or _STANDARD_LAUFZEIT.get(modell) or {"tage": 10, "nachlauf_h": 0}
    try:
        tage = float(lz.get("tage") or 10)
    except Exception:
        tage = 10.0
    try:
        nach = float(lz.get("nachlauf_h") or 0)
    except Exception:
        nach = 0.0
    return tage, nach


def _fall_norm(s):
    t = str(s or "").strip()
    m = re.search(r"(\d{6})\s*-\s*(\d{6})", t)
    if m:
        return m.group(1) + "-" + m.group(2)
    return t[:40]


# ---------------------------------------------------------------------------
# Mails erkennen
# ---------------------------------------------------------------------------

def _mail_lesen(m, tz):
    """Erkennt eine Mail ({uid, datum, von, betreff, text}) und liefert nur die Felder, die zählen."""
    von = str(m.get("von") or "").lower()
    adr = von.split("<")[-1].replace(">", "").strip() if "<" in von else von.strip()
    dom = adr.split("@")[-1] if "@" in adr else ""
    betr = re.sub(r"\s+", " ", str(m.get("betreff") or "")).strip()
    b = betr.lower()
    t = re.sub(r"\s+", " ", str(m.get("text") or ""))
    tl = t.lower()
    aus = {"uid": str(m.get("uid")), "datum": m.get("datum") or "", "betreff": betr[:140], "typ": "andere"}
    md = _zeit(m.get("datum"), tz)

    def dat(x):
        d = _datum(x)
        return d.isoformat() if d else None

    # --- DHL ---
    if dom.endswith("dhl.de") or dom.endswith("dhl.com"):
        if "dexcom" not in b and "dexcom" not in tl[:800]:
            return aus
        st = "info"
        if re.search(r"liegt am gew|ist angekommen|wurde .{0,40}zugestellt|zugestellt worden|an nachbar", b):
            st = "zugestellt"
        elif re.search(r"abholbereit|filiale|packstation|paketshop|abholen", b):
            st = "abholbereit"
        elif "gleich zugestellt" in b:
            st = "gleich"
        elif "kommt heute" in b:
            st = "heute"
        elif "unterwegs" in b:
            st = "unterwegs"
        elif re.search(r"versp\S*tet|verz\S*gert", b):
            st = "verzoegert"
        elif re.search(r"zur\S*ck|r\S*cksendung|verweigert", b):
            st = "zurueck"
        elif re.search(r"ist angekommen|am vereinbarten ablageort hinterlegt", tl):
            st = "zugestellt"
        mnr = re.search(r"\b(00\d{18})\b", t) or re.search(r"\b(JJD\d{8,22})\b", t) or re.search(r"Sendungs\w*\s*:?\s*(\d{12,20})", t)
        erw = None
        me = (re.search(r"voraussichtlich\s+(?:am\s+)?[A-Za-zÄÖÜäöü]+,?\s+(?:den\s+)?(\d{1,2})\.(\d{1,2})\.", t)
              or re.search(r"Zustelltag ist\s+[A-Za-zÄÖÜäöü]+,?\s+(?:der\s+)?(\d{1,2})\.(\d{1,2})\.", t))
        if me and md:
            try:
                e = date(md.year, int(me.group(2)), int(me.group(1)))
                if e < md.date() - timedelta(days=60):
                    e = date(md.year + 1, e.month, e.day)
                erw = e.isoformat()
            except ValueError:
                erw = None
        if st in ("heute", "gleich") and md and not erw:
            erw = md.date().isoformat()
        mf = re.search(r"heute zwischen (\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})", t)
        aus.update({"typ": "dhl", "status": st, "sendungsnr": mnr.group(1) if mnr else None, "erwartet": erw,
                    "fenster": (mf.group(1) + "–" + mf.group(2)) if mf else None})
        return aus

    # --- Support-Fall (Onlineportal) ---
    if "custhelp" in dom:
        if "supportanfrage" in b or "fall-referenznummer" in tl:
            nummern = []
            for n in re.findall(r"\b(\d{6}-\d{6})\b", t):
                if n not in nummern:
                    nummern.append(n)
            if nummern:
                aus.update({"typ": "fall", "nummern": nummern})
        return aus

    if "dexcom" not in dom:
        return aus

    # --- Antwort des technischen Supports ---
    if "technical support" in b or "technischer support" in b or ("sensor-ersatzrichtlinie" in tl and "technischen support" in tl):
        if re.search(r"sensor wurde bereits an sie verschickt|ersatzsensor (?:zu )?senden|ersatz\w* (?:wird|wurde|werden) .{0,40}(?:verschickt|versendet|gesendet|zugeschickt)|senden ihnen .{0,40}ersatz", tl):
            art = "kulanz" if "kulanz" in tl else "ersatz"
        elif re.search(r"nicht die kriterien|kein ersatz|keinen ersatz", tl):
            art = "abgelehnt"
        else:
            art = "info"
        aus.update({"typ": "fall_antwort", "antwort": art})
        return aus

    # Antworten (Aw:/Re:/WG:): nur der eigene Text zählt, nicht das zitierte Original darunter
    antwort = bool(re.match(r"(?:(?:aw|re|wg|fw|fwd)\s*:\s*)+", b))
    if antwort:
        mz = re.search(r"\s(?:Von|From)\s*:\s|\sGesendet\s*:|-{3,}\s*(?:Original|Ursprüngliche)|\sschrieb am\s|\swrote:\s", t)
        if mz:
            t = t[:mz.start()]
            tl = t.lower()
    kundendienst = antwort or "customer service" in von or "kundenservice" in von or adr.startswith("de.info@")

    def versand_laut_kundendienst():
        for mk in re.finditer(r"an den versand übergeben|an (?:unseren|den) versanddienstleister übergeben|auf dem weg zu ihnen"
                              r"|(?:wurde|wird) (?:heute |gestern |bereits |soeben )?(?:versendet|versandt|verschickt)", tl):
            davor = tl[max(0, mk.start() - 60):mk.start()]
            if not re.search(r"\bnicht\b|\bnoch kein|\bsobald\b|\bwenn\b|\bvoraussichtlich\b|\bdemnächst\b", davor):
                return True
        return False

    extra = {}
    fr = (re.search(r"Folgerezept.{0,160}?zum\s*\*?\s*(\d{1,2}\.\d{1,2}\.\d{4})", t)
          or re.search(r"zum\s*\*?\s*(\d{1,2}\.\d{1,2}\.\d{4})\s*\*?\s*ein neues Rezept", t))
    if fr:
        extra["folgerezept"] = dat(fr.group(1))
    gen = (re.search(r"Genehmigungszeitraum endet am\s*\*?\s*(\d{1,2}\.\d{1,2}\.\d{4})", t)
           or re.search(r"Versorgung endet vorerst zum\s*\*?\s*(\d{1,2}\.\d{1,2}\.\d{4})", t))
    if gen:
        extra["genehmigung_bis"] = dat(gen.group(1))

    # --- Versand eines Quartalspakets ---
    mv = re.search(r"Versorgungszeitraum\s*\*?\s*(\d{1,2}\.\d{1,2}\.\d{4})\s*\*?\s*[-–]\s*\*?\s*(\d{1,2}\.\d{1,2}\.\d{4})\s*\*?\s*,?\s*wurde heute an (?:unseren|den) Versanddienstleister", t)
    if mv:
        aus.update({"typ": "versand", "von": dat(mv.group(1)), "bis": dat(mv.group(2)),
                    "teil": "teillieferung" in b, "letzte": "letzte" in b})
        aus.update(extra)
        return aus

    # --- Kundenservice: „Ihre Lieferung wurde heute an den Versand übergeben“ (ohne Versandbestätigung) ---
    if kundendienst and not re.search(r"\bDE\d{6,}[A-Z]{0,3}\b", t) and versand_laut_kundendienst():
        aus.update({"typ": "versand", "von": None, "bis": None, "teil": False, "letzte": False, "kundendienst": True})
        aus.update(extra)
        return aus

    # --- Ankündigung ---
    mg = re.search(r"planen den Versand zum\s*\*?\s*(\d{1,2}\.\d{1,2}\.\d{4})", t)
    mb = re.search(r"ab dem\s*\*?\s*(\d{1,2}\.\d{1,2}\.\d{4})\s*\*?\s*beginnt die Vorbereitung", t)
    if mg or mb:
        aus.update({"typ": "ankuendigung", "versand_geplant": dat(mg.group(1)) if mg else None,
                    "vorbereitung_ab": dat(mb.group(1)) if mb else None})
        aus.update(extra)
        return aus

    # --- Webshop ---
    mn = re.search(r"\b(DE\d{6,}[A-Z]{0,3})\b", t)
    if mn and "bestellung" in (b + " " + tl[:300]):
        nr = mn.group(1)
        if "sendungsverfolgungsnummer" in tl and re.search(r"auf dem weg|versandt", b + " " + tl[:500]):
            ms = re.search(r"Sendungsverfolgungsnummer[^0-9]{0,90}(\d{12,22})", t)
            aus.update({"typ": "shop_versand", "bestellnr": nr, "sendungsnr": ms.group(1) if ms else None})
        else:
            anzahl = 0
            modell = None
            for x in re.finditer(r"Dexcom (G7 15 Tage|G7|G6|ONE\+?) Sensor ([A-Z0-9-]{4,}) (\d+)\s*[·x×]\s*Menge", t):
                anzahl += int(x.group(3))
                modell = modell or _modell_norm(x.group(1))
            if anzahl == 0:
                for x in re.finditer(r"Dexcom (G7|G6|ONE\+?) Monatspaket ([A-Z0-9-]{4,}) (\d+)\s*[·x×]\s*Menge", t):
                    anzahl += 3 * int(x.group(3))
                    modell = modell or _modell_norm(x.group(1))
            aus.update({"typ": "shop_bestellt", "bestellnr": nr, "anzahl": anzahl or None, "modell": modell})
        aus.update(extra)
        return aus

    if extra:
        aus.update({"typ": "rezept_info"})
        aus.update(extra)
    return aus


# ---------------------------------------------------------------------------
# Auswertung: Lieferungen, Fälle, Sensoren, Bestand, Meldungen
# ---------------------------------------------------------------------------

def _neue_lieferung(lid, art, versendet):
    return {"id": lid, "art": art, "versendet": versendet, "bestellt": None, "sendungsnr": None, "dhl": [],
            "quellen": [], "faelle": [], "anzahl_mail": None, "modell_mail": None, "zugestellt_mail": None,
            "zeitraum_von": None, "zeitraum_bis": None, "teil": False, "letzte": False, "folgerezept": None,
            "bestellnr": None, "manuell": False, "notiz": "", "kundendienst": False, "abgeleitet": False,
            "transmitter_mail": None}


def _ableiten(mails, daten, jetzt, tz):
    """Baut aus den erkannten Mails und den eigenen Angaben Lieferungen, Fälle, nächste Lieferung, Folgerezept."""
    e = daten.get("einstellungen") or {}
    korr = daten.get("korrekturen") or {}
    kl = korr.get("lieferungen") or {}
    kf = korr.get("faelle") or {}
    sensoren = daten.get("sensoren") or []
    # reklamierbar sind Sensoren („s…“) und Transmitter („t…“)
    objekte = sensoren + [t for t in (daten.get("transmitter") or []) if isinstance(t, dict) and t.get("id")]
    inv_zeit = _zeit((daten.get("inventur") or {}).get("zeit"), tz)
    liste = []
    for m in mails.values():
        if m.get("typ") in (None, "andere"):
            continue
        md = _zeit(m.get("datum"), tz)
        if md is None:
            continue
        liste.append((md, str(m.get("uid") or ""), m))
    liste.sort(key=lambda x: (x[0], x[1]))

    # Reklamationen aus der Karte ↔ Fall-Mails verknüpfen (ausdrücklich über die Fallnummer, sonst ±3 Tage)
    fall_mails = [(md, m) for (md, u, m) in liste if m["typ"] == "fall"]
    fall_sensor = {}
    for s in objekte:
        r = s.get("reklamation") or {}
        fn = _fall_norm(r.get("fall"))
        if r.get("am") and fn:
            for (md, m) in fall_mails:
                if fn in m.get("nummern", []):
                    fall_sensor[m["nummern"][0]] = s["id"]
    for fid, k in kf.items():
        if k.get("sensor") and fid not in fall_sensor:
            fall_sensor[fid] = k["sensor"]
    gesperrt = set([fid for fid, k in kf.items() if k.get("sensor") == ""])
    belegt = set(fall_sensor.values())
    karte_faelle = []
    for s in sorted(objekte, key=lambda x: str((x.get("reklamation") or {}).get("am") or "")):
        r = s.get("reklamation") or {}
        if not r.get("am") or s["id"] in belegt:
            continue
        am = _zeit(r.get("am"), tz)
        if am is None:
            continue
        if not _fall_norm(r.get("fall")):
            for (md, m) in fall_mails:
                fid = m["nummern"][0]
                if fid not in fall_sensor and fid not in gesperrt and abs((md - am).total_seconds()) <= 3 * 86400:
                    fall_sensor[fid] = s["id"]
                    belegt.add(s["id"])
                    break
        if s["id"] not in belegt:
            karte_faelle.append({"id": "K-" + s["id"], "nummern": [_fall_norm(r.get("fall"))] if _fall_norm(r.get("fall")) else [],
                                 "datum": am, "antwort": None, "antwort_datum": None, "lieferung": None,
                                 "uid": None, "quelle": "karte", "sensor": s["id"]})

    lief = []
    nach_nr = {}
    nach_best = {}
    faelle = list(karte_faelle)
    ank = []
    rezept = None
    genehmigung = None
    for (md, uid, m) in liste:
        typ = m["typ"]
        if m.get("folgerezept") and (rezept is None or md >= rezept["mail"]):
            rezept = {"bis": m["folgerezept"], "mail": md}
        if m.get("genehmigung_bis") and (genehmigung is None or md >= genehmigung["mail"]):
            genehmigung = {"bis": m["genehmigung_bis"], "mail": md}
        if typ == "ankuendigung":
            ank.append({"uid": uid, "datum": md, "versand_geplant": m.get("versand_geplant"), "vorbereitung_ab": m.get("vorbereitung_ab")})
        elif typ == "versand":
            kd = bool(m.get("kundendienst"))
            L = None
            # dieselbe Sendung schon bekannt? unklare DHL-Sendung (36 h) oder Kundenservice-Antwort bzw.
            # aus DHL abgeleitete Quartalslieferung (5 Tage) – dann zusammenführen statt doppelt zählen
            for x in reversed(lief):
                if not x.get("versendet") or x["versendet"] > md:
                    continue
                alter = md - x["versendet"]
                if x["art"] == "unbekannt" and alter <= timedelta(hours=36):
                    L = x
                    break
                if x["art"] == "quartal" and alter <= timedelta(days=5) and (kd or x.get("kundendienst") or x.get("abgeleitet")):
                    L = x
                    break
            if L is None:
                L = _neue_lieferung("M" + uid, "quartal", md)
                L["kundendienst"] = kd
                lief.append(L)
            L["art"] = "quartal"
            L["abgeleitet"] = False
            if not kd:
                L.update({"zeitraum_von": m.get("von"), "zeitraum_bis": m.get("bis"), "teil": bool(m.get("teil")),
                          "letzte": bool(m.get("letzte")), "folgerezept": m.get("folgerezept"), "kundendienst": False})
            L["quellen"].append(uid)
        elif typ in ("shop_bestellt", "shop_versand"):
            nr = m.get("bestellnr") or uid
            L = nach_best.get(nr)
            if L is None:
                L = _neue_lieferung("S" + nr, "shop", None)
                L["bestellnr"] = nr
                lief.append(L)
                nach_best[nr] = L
            L["quellen"].append(uid)
            if typ == "shop_bestellt":
                L["bestellt"] = L["bestellt"] or md
                if m.get("anzahl"):
                    L["anzahl_mail"] = m["anzahl"]
                if m.get("modell"):
                    L["modell_mail"] = m["modell"]
            else:
                L["versendet"] = md
                if m.get("sendungsnr"):
                    L["sendungsnr"] = m["sendungsnr"]
                    nach_nr[m["sendungsnr"]] = L
        elif typ == "fall":
            fid = m["nummern"][0]
            faelle.append({"id": fid, "nummern": list(m["nummern"]), "datum": md, "antwort": None, "antwort_datum": None,
                           "lieferung": None, "uid": uid, "quelle": "mail", "sensor": fall_sensor.get(fid)})
        elif typ == "fall_antwort":
            kand = [f for f in faelle if f["quelle"] == "mail" and f["antwort"] is None
                    and md - timedelta(days=5) <= f["datum"] <= md + timedelta(minutes=10)]
            if kand:
                kand[-1]["antwort"] = m.get("antwort")
                kand[-1]["antwort_datum"] = md
        elif typ == "dhl":
            nr = m.get("sendungsnr")
            L = nach_nr.get(nr) if nr else None
            if L is None and nr:
                kand = [x for x in lief if x["art"] in ("quartal", "shop") and not x.get("sendungsnr") and x.get("versendet")
                        and md - timedelta(days=4) <= x["versendet"] <= md + timedelta(hours=12)]
                if kand:
                    L = kand[-1]
                else:
                    offen = [f for f in faelle if f["lieferung"] is None and f["datum"] <= md
                             and f["datum"] >= md - timedelta(days=21) and f["antwort"] != "abgelehnt"]
                    # angekündigte Quartalslieferung, deren Versandzeitraum begonnen hat (Dexcom schickt nicht immer eine Versandmail)
                    q_versand = [x["versendet"] for x in lief if x["art"] == "quartal" and x.get("versendet")]
                    q_letzte = max(q_versand) if q_versand else None
                    q_ank = [a for a in ank if (q_letzte is None or a["datum"] > q_letzte) and a["datum"] <= md]
                    q_start = None
                    if q_ank:
                        if q_ank[-1].get("vorbereitung_ab"):
                            q_start = _datum(q_ank[-1]["vorbereitung_ab"])
                        elif q_ank[-1].get("versand_geplant"):
                            q_start = _datum(q_ank[-1]["versand_geplant"]) - timedelta(days=1)
                    if not offen and q_start is not None and md.date() >= q_start:
                        L = _neue_lieferung("D" + nr, "quartal", md)
                        L["abgeleitet"] = True
                    elif offen:
                        offen.sort(key=lambda f: (0 if f["antwort"] in ("ersatz", "kulanz") else 1,
                                                  0 if f["quelle"] == "mail" else 1, f["datum"]))
                        f = offen[0]
                        L = _neue_lieferung("D" + nr, "ersatz", md)
                        L["faelle"] = [f["id"]]
                        f["lieferung"] = L["id"]
                    else:
                        L = _neue_lieferung("D" + nr, "unbekannt", md)
                    lief.append(L)
                L["sendungsnr"] = nr
                nach_nr[nr] = L
            if L is None:
                kand = [x for x in lief if x["dhl"] and md - timedelta(days=5) <= x["dhl"][-1]["datum"] <= md]
                L = kand[-1] if kand else None
            if L is not None:
                L["dhl"].append({"datum": md, "status": m.get("status"), "erwartet": m.get("erwartet"), "fenster": m.get("fenster")})
                L["quellen"].append(uid)
                if m.get("status") == "zugestellt" and not L.get("zugestellt_mail"):
                    L["zugestellt_mail"] = md

    # eigene Lieferungen (von Hand)
    for h in daten.get("lieferungen") or []:
        L = _neue_lieferung(h["id"], h.get("art") or "sonstige", _zeit(h.get("versendet"), tz))
        L.update({"manuell": True, "anzahl_mail": h.get("anzahl"), "modell_mail": h.get("modell"),
                  "zugestellt_mail": _zeit(h.get("zugestellt_am"), tz), "notiz": h.get("notiz") or "",
                  "zeitraum_von": h.get("zeitraum_von"), "zeitraum_bis": h.get("zeitraum_bis"), "sendungsnr": h.get("sendungsnr"),
                  "transmitter_mail": h.get("transmitter")})
        lief.append(L)

    # Korrekturen, Standardwerte, Status
    # (Ersatz für einen reklamierten Transmitter enthält standardmäßig einen Transmitter statt eines Sensors)
    fall_nach_id = {}
    for f in faelle:
        fall_nach_id[f["id"]] = f

    def fall_objekt(fid):
        f = fall_nach_id.get(fid)
        if f is None:
            return None
        k2 = kf.get(fid) or {}
        if f["quelle"] == "mail" and k2.get("sensor") is not None:
            return k2.get("sensor") or None
        return f.get("sensor")

    ml = e.get("modell_lieferung") or "G7"
    for L in lief:
        k = {} if L["manuell"] else (kl.get(L["id"]) or {})
        if k.get("art") in ARTEN:
            L["art"] = k["art"]
        if k.get("versendet"):
            L["versendet"] = _zeit(k["versendet"], tz) or L.get("versendet")
        for feld in ("zeitraum_von", "zeitraum_bis", "sendungsnr"):
            if k.get(feld):
                L[feld] = k[feld]
        angenommen = False
        if k.get("nicht_zugestellt"):
            z = None
        elif k.get("zugestellt_am"):
            z = _zeit(k.get("zugestellt_am"), tz)
        else:
            z = L.get("zugestellt_mail")
            # „kommt heute“ ohne spätere Zustellmeldung: an jenem Tag zugestellt
            if z is None and L["dhl"] and L["dhl"][-1]["status"] in ("heute", "gleich") and L["dhl"][-1]["datum"].date() < jetzt.date():
                z = L["dhl"][-1]["datum"]
                angenommen = True
        L["zugestellt_am"] = z
        L["zugestellt_angenommen"] = angenommen
        tx_ersatz = L["art"] == "ersatz" and bool([x for x in (L.get("faelle") or []) if str(fall_objekt(x) or "").startswith("t")])
        anz = k.get("anzahl")
        if anz is None or anz == "":
            anz = L.get("anzahl_mail")
        if anz is None:
            if L["art"] == "quartal":
                anz = e.get("quartal_anzahl", 9)
            elif L["art"] == "ersatz":
                anz = 0 if tx_ersatz else e.get("ersatz_anzahl", 1)
            else:
                anz = 0
        try:
            L["anzahl"] = int(anz)
        except Exception:
            L["anzahl"] = 0
        mod = _modell_norm(k.get("modell")) or _modell_norm(L.get("modell_mail"))
        bezug = z or L.get("versendet") or L.get("bestellt")
        if mod is None and (inv_zeit is None or bezug is None or bezug > inv_zeit):
            mod = ml
        L["modell"] = mod
        tx = k.get("transmitter")
        if tx is None or tx == "":
            tx = L.get("transmitter_mail")
        if tx is None or tx == "":
            if L["art"] == "quartal" and mod == "G6" and L["anzahl"] > 0:
                tx = e.get("transmitter_je_lieferung", 1)
            elif tx_ersatz:
                tx = 1
            else:
                tx = 0
        try:
            L["transmitter"] = max(0, int(tx))
        except Exception:
            L["transmitter"] = 0
        L["aus"] = bool(k.get("aus"))
        if k.get("notiz") is not None and not L["manuell"]:
            L["notiz"] = k.get("notiz") or ""
        L["korrigiert"] = sorted([x for x in k.keys() if x != "notiz"])
        if z:
            L["status"] = "zugestellt"
        elif L["dhl"]:
            L["status"] = _ST_LIEF.get(L["dhl"][-1]["status"], "unterwegs")
        elif L.get("versendet"):
            L["status"] = "versendet"
        elif L.get("bestellt"):
            L["status"] = "bestellt"
        else:
            L["status"] = "offen"
        erw = None
        for x in L["dhl"]:
            if x.get("erwartet"):
                erw = x["erwartet"]
        L["erwartet"] = erw

    # Fälle abschließen
    nach_id = {}
    for L in lief:
        nach_id[L["id"]] = L
    sensor_nach_id = {}
    for s in objekte:
        sensor_nach_id[s["id"]] = s
    for f in faelle:
        k = kf.get(f["id"]) or {}
        f["antwort_korrigiert"] = "antwort" in k
        if "antwort" in k:
            f["antwort"] = k["antwort"]
        if f["quelle"] == "mail" and k.get("sensor") is not None:
            f["sensor"] = k.get("sensor") or None
        s = sensor_nach_id.get(f.get("sensor")) if f.get("sensor") else None
        r = (s.get("reklamation") or {}) if s else {}
        L = nach_id.get(f["lieferung"]) if f["lieferung"] else None
        manuell = k.get("ersatz_erhalten") or r.get("ersatz_erhalten_am")
        if k.get("erledigt") or r.get("erledigt"):
            st = "erledigt"
        elif manuell:
            st = "erhalten"
        elif L is not None and L.get("zugestellt_am"):
            st = "erhalten"
        elif L is not None:
            st = "unterwegs"
        elif f["antwort"] == "abgelehnt":
            st = "abgelehnt"
        elif f["antwort"] in ("ersatz", "kulanz"):
            st = "zugesagt"
        else:
            st = "offen"
        f["status"] = st
        f["ersatz_erhalten_am"] = (_zeit(manuell, tz) if manuell else None) or (L.get("zugestellt_am") if L is not None else None)
        f["notiz"] = k.get("notiz") or ""
        f["historisch"] = bool(inv_zeit is not None and f["datum"] < inv_zeit)

    # nächste Lieferung (eine von Hand eingetragene Quartalslieferung zählt mit ihrem Versand- bzw. Zustelldatum)
    kn = korr.get("naechste") or {}
    versand = []
    for L in lief:
        bez = L.get("versendet") or (L.get("zugestellt_am") if L["manuell"] else None)
        if L["art"] == "quartal" and bez and not L.get("aus"):
            versand.append(bez)
    letzte = max(versand) if versand else None
    offen_ank = [a for a in ank if letzte is None or a["datum"] > letzte]
    erledigt_bis = _zeit(kn.get("erledigt_bis"), tz)
    nach = [a for a in offen_ank if erledigt_bis is None or a["datum"] > erledigt_bis]
    naechste_aus = len(nach) < len(offen_ank)
    naechste = None
    if nach:
        a = nach[-1]
        frist = None
        if a.get("vorbereitung_ab"):
            frist = _datum(a["vorbereitung_ab"]) + timedelta(days=14)
        elif a.get("versand_geplant"):
            frist = _datum(a["versand_geplant"]) + timedelta(days=6)
        fk = kn.get("frist") or {}
        fk_gesetzt = _zeit(fk.get("gesetzt"), tz)
        frist_manuell = bool(fk.get("datum") and _datum(fk["datum"]) and fk_gesetzt is not None and fk_gesetzt >= nach[0]["datum"])
        if frist_manuell:
            frist = _datum(fk["datum"])
        status = "angekuendigt"
        if frist and jetzt.date() > frist:
            status = "ueberfaellig"
        naechste = {"uid": a["uid"], "angekuendigt": [_iso(x["datum"].date()) for x in nach],
                    "vorbereitung_ab": a.get("vorbereitung_ab"), "versand_geplant": a.get("versand_geplant"),
                    "frist": _iso(frist), "status": status, "frist_manuell": frist_manuell,
                    "tage_ueber": (jetzt.date() - frist).days if (frist and status == "ueberfaellig") else 0}
    # Folgerezept-Termin von Hand (gilt, bis eine neuere Mail einen Termin nennt)
    kr = korr.get("rezept") or {}
    if kr.get("bis") and _datum(kr["bis"]):
        kr_gesetzt = _zeit(kr.get("gesetzt"), tz)
        if rezept is None or kr_gesetzt is None or kr_gesetzt >= rezept["mail"]:
            rezept = {"bis": _datum(kr["bis"]).isoformat(), "mail": kr_gesetzt or jetzt, "manuell": True}
    return {"lieferungen": lief, "faelle": faelle, "naechste": naechste, "naechste_ausgeblendet": naechste_aus,
            "rezept": rezept, "genehmigung": genehmigung}


def _sensoren_auswerten(sensoren, einst, jetzt, tz):
    srt = sorted(sensoren, key=lambda s: str(s.get("gesetzt") or ""))
    aus = []
    for i, s in enumerate(srt):
        tage, nach_h = _laufzeit(einst, s.get("modell"))
        g = _zeit(s.get("gesetzt"), tz)
        st0 = _zeit(s.get("sitzung_start"), tz) or g
        ende = _zeit(s.get("ende_quelle"), tz) or (st0 + timedelta(days=tage) if st0 else None)
        nach = ende + timedelta(hours=nach_h) if ende else None
        weg = _zeit(s.get("entfernt"), tz)
        weg_manuell = weg is not None
        if weg is None and i + 1 < len(srt):
            weg = _zeit(srt[i + 1].get("gesetzt"), tz)
        soll_h = tage * 24.0
        gehalten = None
        if weg is not None and st0 is not None:
            gehalten = (weg - st0).total_seconds() / 3600.0
            if nach is not None:
                gehalten = min(gehalten, (nach - st0).total_seconds() / 3600.0)
            gehalten = max(0.0, gehalten)
        if weg is not None:
            status = "vorzeitig" if (gehalten is not None and gehalten < soll_h - 12) else "verbraucht"
        elif ende is not None and jetzt < ende:
            status = "laeuft"
        elif nach is not None and jetzt < nach:
            status = "nachlauf"
        else:
            status = "abgelaufen"
        x = dict(s)
        x.update({"start": _iso(st0), "ende": _iso(ende), "nachlauf_bis": _iso(nach) if nach_h else None,
                  "entfernt_eff": _iso(weg), "entfernt_manuell": weg_manuell, "gehalten_h": round(gehalten, 1) if gehalten is not None else None,
                  "soll_h": soll_h, "status": status,
                  "rest_h": round((ende - jetzt).total_seconds() / 3600.0, 1) if (status == "laeuft" and ende) else None,
                  "tag": int((jetzt - st0).total_seconds() // 86400) + 1 if (status in ("laeuft", "nachlauf") and st0) else None,
                  "verfall_ueberschritten": bool(_datum(s.get("verwendbar_bis")) and g and _datum(s.get("verwendbar_bis")) < g.date())})
        aus.append(x)
    return aus


def _plus_monate(d, n):
    m = d.month - 1 + n
    j = d.year + m // 12
    m = m % 12 + 1
    schalt = j % 4 == 0 and (j % 100 != 0 or j % 400 == 0)
    tage = [31, 29 if schalt else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return date(j, m, min(d.day, tage))


def _plus_abs(dt, tage):
    """dt + tage als echte Zeitspanne (über eine Zeitumstellung hinweg ohne Stundenversatz)."""
    return datetime.fromtimestamp(dt.timestamp() + tage * 86400.0, dt.tzinfo)


def _transmitter_tage(einst):
    try:
        return min(200.0, max(1.0, float(einst.get("transmitter_tage", 90))))
    except Exception:
        return 90.0


def _transmitter_auswerten(liste, sens, einst, jetzt, tz):
    """G6-Transmitter: Laufzeit ab Aktivierung (Standard 90 Tage); neue Sensorsitzung nur, solange noch
    eine ganze Sensorlaufzeit übrig ist („start_bis“). Ein neuer Transmitter beendet den vorigen."""
    tage = _transmitter_tage(einst)
    s_tage = _laufzeit(einst, "G6")[0]
    srt = sorted([t for t in liste if _zeit(t.get("gestartet"), tz) is not None], key=lambda t: _zeit(t.get("gestartet"), tz))
    aus = []
    for i, t in enumerate(srt):
        st = _zeit(t.get("gestartet"), tz)
        ende = _zeit(t.get("ende_quelle"), tz) or _plus_abs(st, tage)
        weg = _zeit(t.get("entfernt"), tz)
        weg_manuell = weg is not None
        naechster = _zeit(srt[i + 1].get("gestartet"), tz) if i + 1 < len(srt) else None
        if weg is None:
            weg = naechster
        soll = (ende - st).total_seconds() / 86400.0
        gehalten = None
        if weg is not None:
            gehalten = max(0.0, (min(weg, ende) - st).total_seconds() / 86400.0)
            status = "vorzeitig" if gehalten < soll - s_tage - 1 else "verbraucht"
        elif jetzt < ende:
            status = "laeuft"
        else:
            status = "abgelaufen"
        # Sensoren in seiner Zeit (einer, der kurz vor dem nächsten Transmitter gesetzt wurde, gehört zu jenem)
        bis = naechster - timedelta(hours=12) if (naechster is not None and not weg_manuell) else (weg if weg is not None else ende)
        n = 0
        for s in sens:
            sg = _zeit(s.get("start") or s.get("gesetzt"), tz)
            if s.get("modell") == "G6" and sg is not None and st - timedelta(hours=12) <= sg < bis:
                n += 1
        x = dict(t)
        x.update({"start": _iso(st), "ende": _iso(ende), "start_bis": _iso(_plus_abs(ende, -s_tage)),
                  "entfernt_eff": _iso(weg), "entfernt_manuell": weg_manuell,
                  "gehalten_tage": round(gehalten, 1) if gehalten is not None else None, "soll_tage": round(soll, 1),
                  "status": status, "tag": int((jetzt - st).total_seconds() // 86400) + 1 if status == "laeuft" else None,
                  "rest_tage": round((ende - jetzt).total_seconds() / 86400.0, 1) if status == "laeuft" else None,
                  "sensoren_n": n})
        aus.append(x)
    return aus


def _transmitter_zu(daten, zeitpunkt, tz):
    """Transmitter, der zu einem Zeitpunkt (z. B. Setzen eines G6-Sensors) lief – oder None."""
    if zeitpunkt is None:
        return None
    tage = _transmitter_tage(daten.get("einstellungen") or {})
    srt = sorted([t for t in (daten.get("transmitter") or []) if _zeit(t.get("gestartet"), tz) is not None],
                 key=lambda t: _zeit(t.get("gestartet"), tz))
    treffer = None
    for i, t in enumerate(srt):
        st = _zeit(t.get("gestartet"), tz)
        ende = _zeit(t.get("ende_quelle"), tz) or _plus_abs(st, tage)
        weg = _zeit(t.get("entfernt"), tz)
        if weg is None and i + 1 < len(srt):
            weg = _zeit(srt[i + 1].get("gestartet"), tz)
        bis = min(weg, ende) if weg is not None else ende
        if st - timedelta(hours=12) <= zeitpunkt < bis:
            treffer = t
    return treffer


def _transmitter_bestand(daten, lief, tz):
    """Transmitter im Vorrat: Zählung + gelieferte − seitdem gestartete. None, solange nie gezählt wurde."""
    inv = daten.get("transmitter_inventur") or {}
    t0 = _zeit(inv.get("zeit"), tz)
    if t0 is None or inv.get("anzahl") is None:
        return None
    try:
        n0 = int(inv.get("anzahl"))
    except Exception:
        n0 = 0
    zu = []
    for L in lief:
        if L.get("aus") or not L.get("transmitter"):
            continue
        z = L.get("zugestellt_am")
        if z is not None and z > t0:
            zu.append((z, L.get("versendet") or z, int(L["transmitter"]), L["id"]))
    zu.sort(key=lambda x: x[0])
    verbraucht = 0
    for t in daten.get("transmitter") or []:
        g = _zeit(t.get("gestartet"), tz)
        if g is not None and g > t0 and t.get("aus_bestand", True) is not False:
            verbraucht += 1
    geliefert = sum([x[2] for x in zu])
    anzahl = n0 + geliefert - verbraucht
    # der älteste noch vorhandene gelieferte (verbraucht wird der Reihe nach, gezählte zuerst)
    rest = max(0, verbraucht - n0)
    aelteste = None
    for (z, v, k, lid) in zu:
        if rest >= k:
            rest -= k
            continue
        aelteste = {"lieferung": lid, "versendet": _iso(v), "aktivieren_bis": _plus_monate(v.date(), TRANSMITTER_AKTIVIEREN_MONATE).isoformat()}
        break
    return {"anzahl": anzahl, "seit": inv.get("zeit"), "inventur": n0, "geliefert": geliefert, "verbraucht": verbraucht,
            "aelteste": aelteste if anzahl > 0 else None}


def _transmitter_lage(daten, lief, sens, aktuell, e, jetzt, tz):
    """Transmitter: Liste, aktueller, Bestand und der Sensorwechsel, ab dem ein neuer nötig ist."""
    liste = _transmitter_auswerten(daten.get("transmitter") or [], sens, e, jetzt, tz)
    akt = None
    for t in reversed(liste):
        if t["status"] == "laeuft":
            akt = t
            break
    if akt is None and liste and liste[-1]["status"] == "abgelaufen":
        akt = liste[-1]
    wechsel = None
    if akt is not None and akt["status"] == "laeuft":
        sb = _zeit(akt["start_bis"], tz)
        wechsel = sb
        if aktuell and aktuell.get("modell") == "G6":
            s_tage = _laufzeit(e, "G6")[0]
            w = _zeit(aktuell.get("ende"), tz) if aktuell.get("status") == "laeuft" else jetzt
            n = 0
            while w is not None and w <= sb and n < 40:
                w = _plus_abs(w, s_tage)
                n += 1
            if w is not None:
                wechsel = w
    # G6-Sensoren dem jeweils laufenden Transmitter zuordnen (nur für die Anzeige)
    for s in sens:
        if s.get("modell") != "G6":
            continue
        sg = _zeit(s.get("start") or s.get("gesetzt"), tz)
        for t in liste:
            st = _zeit(t["start"], tz)
            bis = _zeit(t["entfernt_eff"], tz) or _zeit(t["ende"], tz)
            if sg is not None and st - timedelta(hours=12) <= sg < bis:
                s["transmitter_info"] = {"id": t["id"], "sn": t.get("sn") or ""}
    best = _transmitter_bestand(daten, lief, tz)
    g6 = [s for s in sens if s.get("modell") == "G6" and (_zeit(s.get("start") or s.get("gesetzt"), tz) or jetzt) >= jetzt - timedelta(days=120)]
    relevant = bool(liste) or best is not None or bool(g6) or e.get("modell_lieferung") == "G6" or bool([L for L in lief if L.get("transmitter")])
    return {"liste": liste, "aktuell": akt, "bestand": best, "wechsel_am": wechsel, "relevant": relevant}

def _bestand(daten, lief, tz):
    inv = daten.get("inventur") or {}
    t0 = _zeit(inv.get("zeit"), tz)
    if t0 is None:
        return None
    je = {}
    for k, v in (inv.get("bestand") or {}).items():
        try:
            je[k] = int(v)
        except Exception:
            je[k] = 0
    ml = (daten.get("einstellungen") or {}).get("modell_lieferung") or "G7"
    for L in lief:
        if L.get("aus") or not L.get("anzahl"):
            continue
        z = L.get("zugestellt_am")
        if z is not None and z > t0:
            m = L.get("modell") or ml
            je[m] = je.get(m, 0) + int(L["anzahl"])
    for s in daten.get("sensoren") or []:
        g = _zeit(s.get("gesetzt"), tz)
        if g is not None and g > t0 and s.get("aus_bestand", True) is not False:
            m = s.get("modell") or ml
            je[m] = je.get(m, 0) - 1
    return {"je_modell": je, "gesamt": sum(je.values()), "seit": inv.get("zeit")}


def _modell_vermuten(daten, je):
    srt = sorted([s for s in (daten.get("sensoren") or []) if s.get("modell")], key=lambda s: str(s.get("gesetzt") or ""))
    m = srt[-1]["modell"] if srt else None
    if je:
        if m and je.get(m, 0) > 0:
            return m
        pos = sorted([(v, k) for k, v in je.items() if v > 0], reverse=True)
        if pos:
            return pos[0][1]
    return m or (daten.get("einstellungen") or {}).get("modell_lieferung") or "G7"


def _ruhe(t, einst):
    """Fällt t in die Ruhezeit (z. B. 22–7 Uhr), wird auf 21:30 Uhr davor vorgezogen."""
    try:
        von = int(einst.get("ruhe_von", 22))
        bis = int(einst.get("ruhe_bis", 7))
    except Exception:
        von, bis = 22, 7
    h = t.hour
    nachts = (h >= von or h < bis) if von > bis else (von <= h < bis)
    if not nachts:
        return t
    tag = t.date() if h >= von else t.date() - timedelta(days=1)
    return datetime.combine(tag, dtime(max(0, von - 1), 30), t.tzinfo)


def _auswerten(daten, mails, jetzt, tz):
    e = daten.get("einstellungen") or {}
    abl = _ableiten(mails, daten, jetzt, tz)
    lief = abl["lieferungen"]
    sens = _sensoren_auswerten(daten.get("sensoren") or [], e, jetzt, tz)
    best = _bestand(daten, lief, tz)
    aktuell = None
    for s in reversed(sens):
        if s["status"] in ("laeuft", "nachlauf"):
            aktuell = s
            break
    if aktuell is None and sens and sens[-1]["status"] == "abgelaufen":
        aktuell = sens[-1]
    txl = _transmitter_lage(daten, lief, sens, aktuell, e, jetzt, tz)
    reicht = None
    basis = _zeit(aktuell["ende"], tz) if (aktuell and aktuell.get("ende") and aktuell["status"] == "laeuft") else jetzt
    if best is not None:
        h = 0.0
        for m, n in best["je_modell"].items():
            if n > 0:
                h += n * _laufzeit(e, m)[0] * 24.0
        reicht = basis + timedelta(hours=h)
    unterwegs = [L for L in lief if not L.get("aus") and L["status"] in ("versendet", "unterwegs", "heute", "verzoegert", "abholbereit")
                 and (L.get("versendet") or jetzt) >= jetzt - timedelta(days=30)]
    rz = None
    if abl["rezept"]:
        verschickt = (daten.get("rezept") or {}).get("verschickt_fuer") == abl["rezept"]["bis"]
        rz = {"bis": abl["rezept"]["bis"], "aus_mail": _iso(abl["rezept"]["mail"]), "verschickt": verschickt,
              "verschickt_am": (daten.get("rezept") or {}).get("verschickt_am") if verschickt else None,
              "manuell": bool(abl["rezept"].get("manuell"))}
    warn = []
    n = abl["naechste"]
    if n and n["status"] == "ueberfaellig":
        warn.append({"art": "lieferung", "text": "Nächste Lieferung überfällig – sollte bis " + _datum(n["frist"]).strftime("%d.%m.") + " da sein, noch nicht versendet."})
    if best is not None:
        for m, x in best["je_modell"].items():
            if x < 0:
                warn.append({"art": "bestand", "text": "Bestand " + m + " ist negativ (" + str(x) + ") – bitte Inventur prüfen."})
        tage_rest = (reicht - jetzt).total_seconds() / 86400.0 if reicht else 0
        if tage_rest <= float(e.get("knapp_tage", 7)) and not unterwegs:
            warn.append({"art": "knapp", "text": "Bestand " + str(best["gesamt"]) + " – reicht nur bis " + _wann(reicht, jetzt) + "."})
    else:
        warn.append({"art": "inventur", "text": "Noch keine Inventur – Bestand unbekannt."})
    for f in abl["faelle"]:
        if not f["historisch"] and f["status"] in ("offen", "zugesagt") and (jetzt - f["datum"]).days >= int(e.get("ersatz_tage", 7)):
            warn.append({"art": "ersatz", "text": "Reklamation vom " + f["datum"].strftime("%d.%m.") + (" (Fall " + f["id"] + ")" if f["quelle"] == "mail" else "") + ": noch kein Ersatz."})
    for L in lief:
        if L["art"] == "unbekannt" and not L.get("aus") and (best is None or (L.get("zugestellt_am") or L.get("versendet") or jetzt) > _zeit(best["seit"], tz)):
            warn.append({"art": "sendung", "text": "Dexcom-Sendung " + (L["versendet"].strftime("%d.%m.") if L.get("versendet") else "") + " ohne Zuordnung – Ersatz oder Lieferung?"})
    if rz and not rz["verschickt"]:
        bis = _datum(rz["bis"])
        if bis and (bis - jetzt.date()).days <= int(e.get("rezept_vorlauf_tage", 28)):
            warn.append({"art": "rezept", "text": "Folgerezept im Original bis " + bis.strftime("%d.%m.%Y") + " an Dexcom schicken."})
    for s in sens:
        if s.get("quelle") == "automatisch" and not s.get("lot") and s["status"] in ("laeuft", "nachlauf"):
            warn.append({"art": "foto", "text": "Aktueller Sensor ohne Etikett-Daten – Etikett-Foto in der Karte aufnehmen."})
    # Transmitter (nur solange G6 im Einsatz ist)
    t_akt = txl["aktuell"]
    tb = txl["bestand"]
    if txl["relevant"] and (aktuell is None or aktuell.get("modell") == "G6"):
        try:
            t_vor = float(e.get("transmitter_vorlauf_tage", 7))
        except Exception:
            t_vor = 7.0
        leer = tb is not None and tb["anzahl"] <= 0
        tw = txl["wechsel_am"]
        if t_akt is not None and t_akt["status"] == "laeuft" and tw is not None:
            bis_w = (tw - jetzt).total_seconds() / 86400.0
            if bis_w <= t_vor:
                text = ("Transmitter" + ((" " + t_akt["sn"]) if t_akt.get("sn") else "") + ": beim Sensorwechsel " + _wann(tw, jetzt)
                        + " einen neuen einsetzen (neue Sitzung nur bis " + _wann(_zeit(t_akt["start_bis"], tz), jetzt) + ").")
                warn.append({"art": "transmitter", "text": text + (" Kein Transmitter im Bestand!" if leer else "")})
            elif leer and bis_w <= 30 and not [L for L in unterwegs if L.get("transmitter")]:
                warn.append({"art": "transmitter", "text": "Kein Transmitter mehr im Bestand – der jetzige reicht bis zum Sensorwechsel " + _wann(tw, jetzt) + "."})
        elif (t_akt is not None and t_akt["status"] == "abgelaufen" and aktuell is not None and aktuell.get("status") in ("laeuft", "nachlauf")
              and (_zeit(aktuell.get("start") or aktuell.get("gesetzt"), tz) or jetzt) > _zeit(t_akt["start_bis"], tz)):
            warn.append({"art": "transmitter", "text": "Neuer Transmitter fehlt – der vom " + _zeit(t_akt["start"], tz).strftime("%d.%m.")
                         + " ist seit " + _zeit(t_akt["ende"], tz).strftime("%d.%m.") + " abgelaufen. In der Karte unter „Transmitter“ eintragen."})
        if tb is not None and tb["anzahl"] < 0:
            warn.append({"art": "transmitter", "text": "Transmitter-Bestand ist negativ (" + str(tb["anzahl"]) + ") – bitte zählen."})
        if tb is not None and tb.get("aelteste"):
            ab = _datum(tb["aelteste"]["aktivieren_bis"])
            if ab is not None and (ab - jetzt.date()).days <= 14 and (tw is None or tw.date() > ab):
                warn.append({"art": "transmitter", "text": "Transmitter aus der Lieferung vom " + _zeit(tb["aelteste"]["versendet"], tz).strftime("%d.%m.")
                             + " bis " + ab.strftime("%d.%m.%Y") + " in Betrieb nehmen (Dexcom: innerhalb von 5 Monaten nach Versand)."})
    return {"abl": abl, "sensoren": sens, "aktuell": aktuell, "bestand": best, "reicht_bis": reicht,
            "unterwegs": [L["id"] for L in unterwegs], "folgerezept": rz, "warnungen": warn, "transmitter": txl}


def _meldungen_faellig(a, daten, jetzt, tz):
    e = daten.get("einstellungen") or {}
    melden = e.get("melden") or {}
    gem = daten.get("gemeldet") or {}
    start = _datum(e.get("start"))
    aus = []
    best = a["bestand"]

    def bestand_txt():
        if best is None:
            return ""
        if best["gesamt"] <= 0:
            return "Kein Sensor mehr im Bestand!"
        teile = [str(n) + " × " + m for m, n in sorted(best["je_modell"].items()) if n > 0]
        return "Bestand: " + ", ".join(teile) + "."

    akt = a["aktuell"]
    if melden.get("wechsel") and akt and akt["status"] == "laeuft" and akt.get("ende"):
        ende = _zeit(akt["ende"], tz)
        try:
            vorlauf = float(e.get("wechsel_vorlauf_h", 2))
        except Exception:
            vorlauf = 2.0
        t = _ruhe(ende - timedelta(hours=vorlauf), e)
        key = "wechsel:" + akt["id"] + ":" + akt["ende"][:16]
        if t <= jetzt < ende and key not in gem:
            text = akt.get("modell", "") + "-Sensor vom " + _zeit(akt["start"] or akt["gesetzt"], tz).strftime("%d.%m.") + " läuft " + _wann(ende, jetzt) + " Uhr ab. " + bestand_txt()
            txw = (a.get("transmitter") or {}).get("wechsel_am")
            if txw is not None and akt.get("modell") == "G6" and abs((txw - ende).total_seconds()) < 3600:
                txb = (a.get("transmitter") or {}).get("bestand")
                text = text.strip() + " Diesmal auch den Transmitter wechseln – der jetzige startet keine neue Sitzung mehr."
                if txb is not None:
                    text += " Transmitter im Bestand: " + str(txb["anzahl"]) + "."
            aus.append({"key": key, "art": "wechsel", "titel": "Dexcom: Sensorwechsel", "text": text.strip(), "tag": "dexcom-wechsel"})
    if not (9 <= jetzt.hour < 21):
        return aus
    txl = a.get("transmitter") or {}
    ta = txl.get("aktuell")
    tw = txl.get("wechsel_am")
    tb = txl.get("bestand")
    if (melden.get("transmitter") and txl.get("relevant") and ta is not None and ta["status"] == "laeuft" and tw is not None
            and (akt is None or akt.get("modell") == "G6")):
        try:
            t_vor = float(e.get("transmitter_vorlauf_tage", 7))
        except Exception:
            t_vor = 7.0
        bis_w = (tw - jetzt).total_seconds() / 86400.0
        leer = tb is not None and tb["anzahl"] <= 0
        sn = (" " + ta["sn"]) if ta.get("sn") else ""
        if bis_w <= t_vor:
            key = "transmitter:" + ta["id"] + ":" + str(ta["start_bis"])[:10]
            if key not in gem:
                text = ("Transmitter" + sn + " vom " + _zeit(ta["start"], tz).strftime("%d.%m.") + ": neue Sitzung nur bis "
                        + _wann(_zeit(ta["start_bis"], tz), jetzt) + " – beim Sensorwechsel " + _wann(tw, jetzt) + " einen neuen Transmitter einsetzen. ")
                if leer:
                    text += "Kein Transmitter im Bestand! Kundenservice " + KUNDENSERVICE + "."
                elif tb is not None:
                    text += "Im Bestand: " + str(tb["anzahl"]) + "."
                aus.append({"key": key, "art": "transmitter", "titel": "Dexcom: Transmitter wechseln", "text": text.strip(), "tag": "dexcom-transmitter"})
        elif leer and bis_w <= 21:
            unterwegs_tx = [L for L in a["abl"]["lieferungen"] if L["id"] in a["unterwegs"] and L.get("transmitter")]
            key = "transmitter_leer:" + ta["id"]
            if key not in gem and not unterwegs_tx:
                text = "Kein Transmitter mehr im Bestand. Der jetzige" + sn + " reicht bis zum Sensorwechsel " + _wann(tw, jetzt) + ". Kundenservice " + KUNDENSERVICE + "."
                aus.append({"key": key, "art": "transmitter", "titel": "Dexcom: kein Transmitter", "text": text, "tag": "dexcom-transmitter"})
    n = a["abl"]["naechste"]
    if melden.get("lieferung"):
        if n and n["status"] == "ueberfaellig":
            frist = _datum(n["frist"])
            stufe = max(0, (jetzt.date() - frist).days) // 3
            key = "lieferung:" + str(n["uid"]) + ":" + str(stufe)
            if key not in gem:
                was = ("Vorbereitung ab " + _datum(n["vorbereitung_ab"]).strftime("%d.%m.")) if n.get("vorbereitung_ab") else ("Versand geplant zum " + _datum(n["versand_geplant"]).strftime("%d.%m."))
                text = "Angekündigt (" + was + "), Zustellung bis etwa " + frist.strftime("%d.%m.") + " – bisher kein Versand. "
                if akt and akt.get("ende") and akt["status"] == "laeuft":
                    text += "Aktueller Sensor endet " + _wann(_zeit(akt["ende"], tz), jetzt) + ". "
                text += bestand_txt() + " Kundenservice " + KUNDENSERVICE + "."
                aus.append({"key": key, "art": "lieferung", "titel": "Dexcom: Lieferung überfällig", "text": text, "tag": "dexcom-lieferung"})
        elif best is not None and a["reicht_bis"] is not None and not a["unterwegs"]:
            rest = (a["reicht_bis"] - jetzt).total_seconds() / 86400.0
            if rest <= float(e.get("knapp_tage", 7)):
                key = "knapp:" + a["reicht_bis"].date().isoformat() + ":" + str(jetzt.toordinal() // 3)
                if key not in gem and not [k for k in gem if k.startswith("knapp:" + a["reicht_bis"].date().isoformat())
                                           and (jetzt - _zeit(gem[k], tz)).total_seconds() < 3 * 86400]:
                    text = bestand_txt() + " Reicht bis " + _wann(a["reicht_bis"], jetzt) + ". "
                    text += "Lieferung angekündigt, aber noch nicht versendet." if n else "Keine Lieferung unterwegs oder angekündigt."
                    aus.append({"key": key, "art": "lieferung", "titel": "Dexcom: Bestand knapp", "text": text.strip(), "tag": "dexcom-lieferung"})
    if melden.get("ersatz"):
        try:
            frist_tage = int(e.get("ersatz_tage", 7))
        except Exception:
            frist_tage = 7
        for f in a["abl"]["faelle"]:
            if f["historisch"] or f["status"] not in ("offen", "zugesagt"):
                continue
            if start and f["datum"].date() < start:
                continue
            tage = (jetzt - f["datum"]).days
            if tage < frist_tage:
                continue
            key = "ersatz:" + f["id"] + ":" + str((tage - frist_tage) // 7)
            if key in gem:
                continue
            wer = ("Fall " + f["id"]) if f["quelle"] == "mail" else "Reklamation"
            text = wer + " vom " + f["datum"].strftime("%d.%m.") + ": seit " + str(tage) + " Tagen kein Ersatzpaket."
            if f["status"] == "zugesagt":
                text += " Dexcom hatte Ersatz zugesagt."
            text += " Technischer Support 0800 724 6449."
            aus.append({"key": key, "art": "ersatz", "titel": "Dexcom: Ersatz fehlt", "text": text, "tag": "dexcom-ersatz-" + f["id"]})
    rz = a["folgerezept"]
    if melden.get("rezept") and rz and not rz["verschickt"]:
        bis = _datum(rz["bis"])
        try:
            vor = int(e.get("rezept_vorlauf_tage", 28))
        except Exception:
            vor = 28
        stufen = sorted(set([7, vor]))
        faellig = [st for st in stufen if bis and bis - timedelta(days=st) <= jetzt.date() <= bis + timedelta(days=3)]
        if faellig:
            st = faellig[0]
            key = "rezept:" + bis.isoformat() + ":" + str(st)
            if key not in gem:
                text = "Dexcom braucht das Folgerezept im Original bis " + bis.strftime("%d.%m.%Y") + " per Post (noch " + str((bis - jetzt.date()).days) + " Tage)."
                aus.append({"key": key, "art": "rezept", "titel": "Dexcom: Folgerezept", "text": text, "tag": "dexcom-rezept",
                            "auch": ["rezept:" + bis.isoformat() + ":" + str(x) for x in stufen if x > st]})
    return aus


# ---------------------------------------------------------------------------
# Änderungen (nativ)
# ---------------------------------------------------------------------------

def _normalisieren(d):
    d = d if isinstance(d, dict) else {}
    e = dict(_STANDARD_EINST)
    e.update(d.get("einstellungen") or {})
    lz = {}
    for m in MODELLE:
        x = dict(_STANDARD_LAUFZEIT[m])
        x.update(((d.get("einstellungen") or {}).get("laufzeit") or {}).get(m) or {})
        lz[m] = x
    e["laufzeit"] = lz
    mel = dict(_STANDARD_MELDEN)
    mel.update((d.get("einstellungen") or {}).get("melden") or {})
    e["melden"] = mel
    gm = dict(_STANDARD_EINST["gtin_modell"])
    gm.update((d.get("einstellungen") or {}).get("gtin_modell") or {})
    e["gtin_modell"] = gm
    k = d.get("korrekturen") or {}
    return {
        "version": 1,
        "zaehler": int(d.get("zaehler") or 0),
        "sensoren": [s for s in (d.get("sensoren") or []) if isinstance(s, dict) and s.get("id")],
        "transmitter": [t for t in (d.get("transmitter") or []) if isinstance(t, dict) and t.get("id")],
        "transmitter_inventur": d.get("transmitter_inventur") or None,
        "lieferungen": [x for x in (d.get("lieferungen") or []) if isinstance(x, dict) and x.get("id")],
        "korrekturen": {"lieferungen": dict(k.get("lieferungen") or {}), "faelle": dict(k.get("faelle") or {}),
                        "naechste": dict(k.get("naechste") or {}), "rezept": dict(k.get("rezept") or {})},
        "inventur": d.get("inventur") or None,
        "rezept": d.get("rezept") or None,
        "einstellungen": e,
        "gemeldet": dict(d.get("gemeldet") or {}),
        "meldungen": list(d.get("meldungen") or [])[-MELDUNGEN_MAX:],
        "papierkorb": list(d.get("papierkorb") or [])[-PAPIERKORB:],
        "letzte_quelle": d.get("letzte_quelle"),
    }


def _eintrag(s, jetzt, was):
    v = list(s.get("verlauf") or [])
    v.append({"z": _iso(jetzt), "was": was})
    s["verlauf"] = v[-VERLAUF_MAX:]


def _leerer_sensor(jetzt):
    return {"id": _neue_id("s"), "modell": None, "ref": "", "lot": "", "hergestellt": None, "verwendbar_bis": None,
            "gtin": "", "code": "", "sn": "", "sn_uebernommen": False, "gesetzt": None, "sitzung_start": None,
            "ende_quelle": None, "entfernt": None, "notiz": "", "quelle": "hand", "aus_bestand": True,
            "reklamation": None, "foto": None, "erstellt": _iso(jetzt), "geaendert": _iso(jetzt), "verlauf": []}


def _sensor_feld(k, v, tz):
    if k in ("hergestellt", "verwendbar_bis"):
        d = _datum(v)
        return d.isoformat() if d else None
    if k in ("gesetzt", "entfernt"):
        z = _zeit(v, tz)
        return _iso(z) if z else None
    if k == "modell":
        return _modell_norm(v)
    if k == "aus_bestand":
        return v is not False and str(v).lower() not in ("false", "0", "nein", "no")
    if k == "notiz":
        return str(v if v is not None else "").strip()[:500]
    if k == "code":
        return re.sub(r"\s+", "", str(v or ""))[:12]
    if k == "quelle":
        x = str(v or "").strip().lower()
        return x if x in ("foto", "hand", "automatisch", "verlauf") else "hand"
    return _txt(v, 60)


def _sensor_speichern(daten, f, jetzt, tz, je):
    """Legt einen Sensor an (ohne id) oder ändert ihn. Ohne id wird ein automatisch erkannter Eintrag
    (±12 h, noch ohne LOT) übernommen, statt einen zweiten anzulegen."""
    sensoren = daten["sensoren"]
    sid = str(f.get("id") or "").strip()
    alt = None
    aktion = "angelegt"
    if sid:
        for s in sensoren:
            if s["id"] == sid:
                alt = s
        if alt is None:
            return {"ok": False, "fehler": "Sensor " + sid + " nicht gefunden."}
        aktion = "geaendert"
    g = _zeit(f.get("gesetzt"), tz) if f.get("gesetzt") not in (None, "") else None
    if f.get("gesetzt") not in (None, "") and g is None:
        return {"ok": False, "fehler": "Setzzeit nicht lesbar: " + str(f.get("gesetzt"))}
    if not sid:
        if g is None:
            g = jetzt.replace(second=0, microsecond=0)
            f["gesetzt"] = _iso(g)
        if g > jetzt + timedelta(hours=1):
            return {"ok": False, "fehler": "Setzzeit liegt in der Zukunft."}
        lot = _txt(f.get("lot"), 60)
        for s in sensoren:
            sg = _zeit(s.get("gesetzt"), tz)
            if sg is None:
                continue
            if lot and s.get("lot") == lot and abs((sg - g).total_seconds()) <= 3600:
                return {"ok": True, "id": s["id"], "aktion": "unveraendert"}
        kand = []
        for s in sensoren:
            sg = _zeit(s.get("gesetzt"), tz)
            if sg is not None and abs((sg - g).total_seconds()) <= 12 * 3600 and (s.get("quelle") == "automatisch" or not s.get("lot")):
                kand.append((abs((sg - g).total_seconds()), s))
        if kand:
            kand.sort(key=lambda x: x[0])
            alt = kand[0][1]
            aktion = "zusammengefuehrt"
    s = alt if alt is not None else _leerer_sensor(jetzt)
    geaendert = []
    for k in _SENSOR_FELDER:
        if k not in f or f[k] is None:
            continue
        if k == "quelle" and aktion == "zusammengefuehrt" and s.get("quelle") == "automatisch" and f[k] in (None, ""):
            continue
        v = _sensor_feld(k, f[k], tz)
        if k == "modell" and v is None and f[k] not in (None, ""):
            return {"ok": False, "fehler": "Unbekanntes Modell: " + str(f[k]) + " (möglich: " + ", ".join(MODELLE) + ")"}
        if s.get(k) != v:
            s[k] = v
            geaendert.append(k)
    fid = str(f.get("foto") or "").strip()
    if fid:
        s["foto"] = {"id": fid, "zeit": _iso(jetzt)}
        geaendert.append("foto")
    if "sn" in geaendert:
        s["sn_uebernommen"] = False
    if not s.get("modell"):
        s["modell"] = _modell_vermuten(daten, je)
        geaendert.append("modell")
    if s.get("modell") == "G6" and not s.get("sn"):
        tr = _transmitter_zu(daten, _zeit(s.get("gesetzt"), tz), tz)
        if tr is not None:
            if tr.get("sn"):
                s["sn"] = tr["sn"]
                s["sn_uebernommen"] = True
        else:
            vor = sorted([x for x in sensoren if x is not s and x.get("modell") == "G6" and x.get("sn") and x.get("gesetzt")],
                         key=lambda x: str(x.get("gesetzt")))
            if vor:
                vg = _zeit(vor[-1]["gesetzt"], tz)
                sg = _zeit(s.get("gesetzt"), tz)
                if vg and sg and timedelta(0) <= sg - vg <= timedelta(days=100):
                    s["sn"] = vor[-1]["sn"]
                    s["sn_uebernommen"] = True
    s["geaendert"] = _iso(jetzt)
    if aktion == "angelegt":
        _eintrag(s, jetzt, "angelegt (" + (s.get("quelle") or "hand") + ")")
        sensoren.append(s)
    elif aktion == "zusammengefuehrt":
        if s.get("quelle") == "automatisch":
            s["quelle"] = _sensor_feld("quelle", f.get("quelle") or "foto", tz)
        _eintrag(s, jetzt, "Etikett-Daten ergänzt: " + ", ".join(geaendert))
    elif geaendert:
        _eintrag(s, jetzt, "geändert: " + ", ".join(geaendert))
    if s.get("gtin") and s.get("modell") and s.get("quelle") in ("foto", "hand"):
        daten["einstellungen"].setdefault("gtin_modell", {})[s["gtin"]] = s["modell"]
    return {"ok": True, "id": s["id"], "aktion": aktion, "geaendert": geaendert}


def _leerer_transmitter(jetzt):
    return {"id": _neue_id("t"), "sn": "", "lot": "", "verwendbar_bis": None, "gestartet": None, "ende_quelle": None,
            "entfernt": None, "notiz": "", "quelle": "hand", "aus_bestand": True, "reklamation": None,
            "erstellt": _iso(jetzt), "geaendert": _iso(jetzt), "verlauf": []}


def _sn_norm(x):
    return re.sub(r"\s+", "", str(x or "")).upper()[:30]


def _sn_gleich(a, b):
    a = _sn_norm(a)
    b = _sn_norm(b)
    if not a or not b:
        return False
    return a == b or a.split("-")[0] == b.split("-")[0]


def _transmitter_feld(k, v, tz):
    if k == "sn":
        return _sn_norm(v)
    if k == "verwendbar_bis":
        d = _datum(v)
        return d.isoformat() if d else None
    if k in ("gestartet", "entfernt"):
        z = _zeit(v, tz)
        return _iso(z) if z else None
    if k == "aus_bestand":
        return v is not False and str(v).lower() not in ("false", "0", "nein", "no")
    if k == "notiz":
        return str(v if v is not None else "").strip()[:500]
    if k == "quelle":
        x = str(v or "").strip().lower()
        return x if x in ("hand", "automatisch", "foto") else "hand"
    return _txt(v, 30)


def _transmitter_aktion(daten, p, jetzt, tz):
    """Transmitter anlegen oder ändern (speichern), löschen (Papierkorb) oder den Vorrat zählen (zaehlen)."""
    aktion = str(p.get("aktion") or "speichern")
    liste = daten.setdefault("transmitter", [])
    tid = str(p.get("id") or "").strip()
    if aktion == "zaehlen":
        try:
            n = int(p.get("anzahl"))
        except Exception:
            return {"ok": False, "fehler": "Anzahl ist keine Zahl."}
        if n < 0 or n > 50:
            return {"ok": False, "fehler": "Anzahl bitte zwischen 0 und 50."}
        t = _zeit(p.get("zeit"), tz) if p.get("zeit") else jetzt
        if t is None:
            return {"ok": False, "fehler": "Zeitpunkt nicht lesbar."}
        daten["transmitter_inventur"] = {"zeit": _iso(t), "anzahl": n, "erstellt": _iso(jetzt)}
        return {"ok": True, "aktion": "gezaehlt", "anzahl": n}
    alt = None
    if tid:
        for x in liste:
            if x["id"] == tid:
                alt = x
        if alt is None:
            return {"ok": False, "fehler": "Transmitter nicht gefunden."}
    if aktion == "loeschen":
        if alt is None:
            return {"ok": False, "fehler": "Kein Transmitter angegeben."}
        daten["transmitter"] = [x for x in liste if x["id"] != tid]
        alt["geloescht"] = _iso(jetzt)
        alt["art"] = "transmitter"
        daten["papierkorb"].append(alt)
        daten["papierkorb"] = daten["papierkorb"][-PAPIERKORB:]
        return {"ok": True, "id": tid, "aktion": "geloescht"}
    if aktion != "speichern":
        return {"ok": False, "fehler": "Unbekannte Aktion: " + aktion}
    for k in ("gestartet", "entfernt"):
        if p.get(k) not in (None, "") and _zeit(p.get(k), tz) is None:
            return {"ok": False, "fehler": ("Startzeit" if k == "gestartet" else "Ende") + " nicht lesbar: " + str(p.get(k))}
    if p.get("verwendbar_bis") not in (None, "") and _datum(p.get("verwendbar_bis")) is None:
        return {"ok": False, "fehler": "Datum „verwendbar bis“ nicht lesbar."}
    f = dict(p)
    art = "geaendert"
    if alt is None:
        g = _zeit(f.get("gestartet"), tz) if f.get("gestartet") not in (None, "") else jetzt.replace(second=0, microsecond=0)
        if g > jetzt + timedelta(hours=1):
            return {"ok": False, "fehler": "Startzeit liegt in der Zukunft."}
        sn = _sn_norm(f.get("sn"))
        for x in liste:
            if sn and _sn_gleich(sn, x.get("sn")):
                alt = x
        if alt is not None:
            art = "zusammengefuehrt"
            f.pop("gestartet", None)
            f.pop("quelle", None)
        else:
            art = "angelegt"
            f["gestartet"] = _iso(g)
    t = alt if alt is not None else _leerer_transmitter(jetzt)
    geaendert = []
    for k in _TRANSMITTER_FELDER:
        if k not in f or f[k] is None:
            continue
        if k == "gestartet" and f[k] == "":
            continue
        if art == "zusammengefuehrt" and f[k] == "":
            continue
        v = _transmitter_feld(k, f[k], tz)
        if t.get(k) != v:
            t[k] = v
            geaendert.append(k)
    t["geaendert"] = _iso(jetzt)
    if art == "angelegt":
        _eintrag(t, jetzt, "angelegt (" + (t.get("quelle") or "hand") + ")")
        liste.append(t)
    elif geaendert:
        _eintrag(t, jetzt, ("ergänzt: " if art == "zusammengefuehrt" else "geändert: ") + ", ".join(geaendert))
    return {"ok": True, "id": t["id"], "aktion": art, "geaendert": geaendert}


def _transmitter_quelle(daten, ende_s, tid, jetzt, tz):
    """Transmitter aus dem „Transmitter-Ende“ (und ggf. der ID) einer CGM-Integration erkennen, z. B. YourLoops/DBLG1.
    Liefert None oder {aktion: neu|angepasst|verknuepft, id, …}."""
    ende = _zeit(ende_s, tz)
    if ende is None:
        return None
    sn = _sn_norm(tid)
    if sn in ("UNKNOWN", "UNAVAILABLE", "NONE"):
        sn = ""
    start = _plus_abs(ende, -_transmitter_tage(daten.get("einstellungen") or {}))
    if start > jetzt + timedelta(hours=1):
        return None
    liste = daten.setdefault("transmitter", [])
    for t in liste:
        eq = _zeit(t.get("ende_quelle"), tz)
        if (eq is not None and abs((eq - ende).total_seconds()) <= 86400) or (sn and _sn_gleich(sn, t.get("sn"))):
            was = []
            if eq is None or abs((eq - ende).total_seconds()) > 60:
                t["ende_quelle"] = _iso(ende)
                was.append("Ende " + ende.strftime("%d.%m.%Y %H:%M"))
            if sn and not t.get("sn"):
                t["sn"] = sn
                was.append("SN " + sn)
            g = _zeit(t.get("gestartet"), tz)
            if t.get("quelle") == "automatisch" and (g is None or abs((g - start).total_seconds()) > 60):
                t["gestartet"] = _iso(start)
                was.append("Start")
            if not was:
                return None
            t["geaendert"] = _iso(jetzt)
            _eintrag(t, jetzt, "aus der CGM-Integration: " + ", ".join(was))
            return {"aktion": "angepasst", "id": t["id"]}
    for t in liste:
        g = _zeit(t.get("gestartet"), tz)
        if (g is not None and not t.get("ende_quelle") and abs((g - start).total_seconds()) <= 3 * 86400
                and not (sn and t.get("sn") and not _sn_gleich(sn, t.get("sn")))):
            t["ende_quelle"] = _iso(ende)
            if sn and not t.get("sn"):
                t["sn"] = sn
            t["geaendert"] = _iso(jetzt)
            _eintrag(t, jetzt, "mit der CGM-Integration verknüpft (Ende " + ende.strftime("%d.%m.%Y %H:%M") + ")")
            return {"aktion": "verknuepft", "id": t["id"]}
    juengster = None
    for t in liste:
        g = _zeit(t.get("gestartet"), tz)
        if g is not None and (juengster is None or g > juengster):
            juengster = g
    if juengster is not None and juengster > start + timedelta(days=3):
        return None
    t = _leerer_transmitter(jetzt)
    t.update({"sn": sn, "gestartet": _iso(start), "ende_quelle": _iso(ende), "quelle": "automatisch"})
    _eintrag(t, jetzt, "automatisch erkannt (Ende " + ende.strftime("%d.%m.%Y %H:%M") + ")")
    liste.append(t)
    return {"aktion": "neu", "id": t["id"], "sn": sn, "start": _iso(start), "ende": _iso(ende)}

def _reklamation_aktion(daten, sid, aktion, p, jetzt, tz):
    s = None
    for x in daten["sensoren"] + (daten.get("transmitter") or []):
        if x["id"] == sid:
            s = x
    if s is None:
        return {"ok": False, "fehler": "Sensor bzw. Transmitter nicht gefunden."}
    r = dict(s.get("reklamation") or {})
    if aktion == "setzen":
        am = _zeit(p.get("am"), tz) if p.get("am") else jetzt
        if am is None:
            return {"ok": False, "fehler": "Datum der Reklamation nicht lesbar."}
        if p.get("am") and len(str(p.get("am")).strip()) <= 10:
            am = am.replace(hour=12)
        ausfall = _zeit(p.get("ausfall_am"), tz) if p.get("ausfall_am") else None
        if p.get("ausfall_am") and ausfall is None:
            return {"ok": False, "fehler": "Ausfallzeit nicht lesbar."}
        neu = not r.get("am")
        r["am"] = _iso(am)
        if "fall" in p:
            r["fall"] = _fall_norm(p.get("fall"))
        if "grund" in p:
            r["grund"] = _txt(p.get("grund"), 200)
        if "notiz" in p:
            r["notiz"] = str(p.get("notiz") or "").strip()[:500]
        if ausfall is not None:
            r["ausfall_am"] = _iso(ausfall)
            if not s.get("entfernt"):
                s["entfernt"] = _iso(ausfall)
        r.setdefault("erstellt", _iso(jetzt))
        s["reklamation"] = r
        _eintrag(s, jetzt, ("reklamiert am " if neu else "Reklamation geändert: ") + am.strftime("%d.%m.%Y") + ((" (Fall " + r["fall"] + ")") if r.get("fall") else ""))
    elif aktion == "aufheben":
        s["reklamation"] = None
        _eintrag(s, jetzt, "Reklamation entfernt")
    elif aktion in ("ersatz_erhalten", "ersatz_offen", "erledigt", "wieder_offen"):
        if not r.get("am"):
            return {"ok": False, "fehler": "Dieser Sensor ist nicht reklamiert."}
        if aktion == "ersatz_erhalten":
            am = _zeit(p.get("am"), tz) if p.get("am") else jetzt
            r["ersatz_erhalten_am"] = _iso(am)
            _eintrag(s, jetzt, "Ersatz erhalten am " + am.strftime("%d.%m.%Y"))
        elif aktion == "ersatz_offen":
            r.pop("ersatz_erhalten_am", None)
            _eintrag(s, jetzt, "Ersatz wieder offen")
        elif aktion == "erledigt":
            r["erledigt"] = True
            _eintrag(s, jetzt, "Reklamation abgeschlossen")
        else:
            r["erledigt"] = False
            _eintrag(s, jetzt, "Reklamation wieder offen")
        s["reklamation"] = r
    else:
        return {"ok": False, "fehler": "Unbekannte Aktion: " + str(aktion)}
    s["geaendert"] = _iso(jetzt)
    return {"ok": True, "id": sid}


def _fall_aktion(daten, fid, aktion, p, jetzt, tz):
    kf = daten["korrekturen"]["faelle"]
    k = dict(kf.get(fid) or {})
    if aktion == "zuordnen":
        sid = str(p.get("sensor_id") or "").strip()
        if sid:
            s = None
            for x in daten["sensoren"] + (daten.get("transmitter") or []):
                if x["id"] == sid:
                    s = x
            if s is None:
                return {"ok": False, "fehler": "Sensor bzw. Transmitter nicht gefunden."}
            r = dict(s.get("reklamation") or {})
            if not r.get("am"):
                d = _zeit(p.get("fall_datum"), tz) or jetzt
                r["am"] = _iso(d)
                r["erstellt"] = _iso(jetzt)
            r["fall"] = fid
            s["reklamation"] = r
            _eintrag(s, jetzt, "Fall " + fid + " zugeordnet")
            k["sensor"] = sid
        else:
            k["sensor"] = ""
            for x in daten["sensoren"] + (daten.get("transmitter") or []):
                r = x.get("reklamation") or {}
                if _fall_norm(r.get("fall")) == fid:
                    r["fall"] = ""
    elif aktion == "erledigt":
        k["erledigt"] = True
    elif aktion == "offen":
        k["erledigt"] = False
        k.pop("ersatz_erhalten", None)
    elif aktion == "ersatz_erhalten":
        am = _zeit(p.get("am"), tz) if p.get("am") else jetzt
        k["ersatz_erhalten"] = _iso(am)
    elif aktion == "notiz":
        k["notiz"] = str(p.get("notiz") or "").strip()[:500]
    elif aktion == "antwort":
        a = str(p.get("antwort") or "").strip()
        if a in ("", "mail"):
            k.pop("antwort", None)
        elif a in ("keine", "ersatz", "kulanz", "abgelehnt", "info"):
            k["antwort"] = None if a == "keine" else a
        else:
            return {"ok": False, "fehler": "Unbekannte Antwort: " + a}
    else:
        return {"ok": False, "fehler": "Unbekannte Aktion: " + str(aktion)}
    kf[fid] = k
    return {"ok": True, "id": fid}


def _lieferung_aktion(daten, p, jetzt, tz):
    aktion = str(p.get("aktion") or "speichern")
    lid = str(p.get("id") or "").strip()

    def tag(x):
        d = _datum(x)
        return d.isoformat() if d else None

    if aktion in ("ankuendigung_erledigt", "ankuendigung_offen", "ankuendigung_frist"):
        kn = daten["korrekturen"].setdefault("naechste", {})
        if aktion == "ankuendigung_erledigt":
            kn["erledigt_bis"] = _iso(jetzt)
        elif aktion == "ankuendigung_offen":
            kn.pop("erledigt_bis", None)
        elif p.get("am") in (None, ""):
            kn.pop("frist", None)
        elif tag(p.get("am")) is None:
            return {"ok": False, "fehler": "Datum nicht erkannt."}
        else:
            kn["frist"] = {"datum": tag(p.get("am")), "gesetzt": _iso(jetzt)}
        return {"ok": True, "aktion": aktion}
    for feld in ("zeitraum_von", "zeitraum_bis"):
        if p.get(feld) not in (None, "") and tag(p.get(feld)) is None:
            return {"ok": False, "fehler": "Datum im Versorgungszeitraum nicht erkannt."}
    if p.get("versendet") not in (None, "") and _zeit(p.get("versendet"), tz) is None:
        return {"ok": False, "fehler": "Versanddatum nicht erkannt."}
    if p.get("transmitter") not in (None, ""):
        try:
            if not 0 <= int(p.get("transmitter")) <= 10:
                return {"ok": False, "fehler": "Transmitter bitte 0 bis 10."}
        except Exception:
            return {"ok": False, "fehler": "Anzahl Transmitter ist keine Zahl."}
    if aktion == "neu" or (not lid and aktion == "speichern"):
        art = p.get("art") if p.get("art") in ARTEN else "sonstige"
        z = _zeit(p.get("zugestellt_am"), tz) if p.get("zugestellt_am") else jetzt
        try:
            anz = int(p.get("anzahl") if p.get("anzahl") not in (None, "") else (9 if art == "quartal" else 1))
        except Exception:
            return {"ok": False, "fehler": "Anzahl ist keine Zahl."}
        h = {"id": _neue_id("H"), "art": art, "anzahl": anz, "modell": _modell_norm(p.get("modell")) or (daten["einstellungen"].get("modell_lieferung") or "G7"),
             "versendet": _iso(_zeit(p.get("versendet"), tz)) if p.get("versendet") else None,
             "zugestellt_am": _iso(z), "notiz": str(p.get("notiz") or "").strip()[:500], "erstellt": _iso(jetzt),
             "zeitraum_von": tag(p.get("zeitraum_von")), "zeitraum_bis": tag(p.get("zeitraum_bis")),
             "sendungsnr": re.sub(r"\s+", "", str(p.get("sendungsnr") or ""))[:40] or None,
             "transmitter": int(p["transmitter"]) if p.get("transmitter") not in (None, "") else None}
        daten["lieferungen"].append(h)
        return {"ok": True, "id": h["id"], "aktion": "angelegt"}
    if not lid:
        return {"ok": False, "fehler": "Keine Lieferung angegeben."}
    if lid.startswith("H"):
        h = None
        for x in daten["lieferungen"]:
            if x["id"] == lid:
                h = x
        if h is None:
            return {"ok": False, "fehler": "Lieferung nicht gefunden."}
        if aktion == "loeschen":
            daten["lieferungen"] = [x for x in daten["lieferungen"] if x["id"] != lid]
            return {"ok": True, "id": lid, "aktion": "geloescht"}
        ziel = h
    else:
        ziel = dict(daten["korrekturen"]["lieferungen"].get(lid) or {})
    if aktion == "zugestellt":
        ziel["zugestellt_am"] = _iso(_zeit(p.get("am"), tz) if p.get("am") else jetzt)
        ziel.pop("nicht_zugestellt", None)
    elif aktion == "nicht_zugestellt":
        if lid.startswith("H"):
            ziel["zugestellt_am"] = None
        else:
            ziel.pop("zugestellt_am", None)
            ziel["nicht_zugestellt"] = True
    elif aktion == "ausblenden":
        ziel["aus"] = True
    elif aktion == "einblenden":
        ziel.pop("aus", None)
    elif aktion == "zuruecksetzen" and not lid.startswith("H"):
        ziel = {}
    elif aktion == "speichern":
        if "art" in p and p["art"] not in (None, ""):
            if p["art"] not in ARTEN:
                return {"ok": False, "fehler": "Unbekannte Art."}
            ziel["art"] = p["art"]
        if "anzahl" in p and p["anzahl"] not in (None, ""):
            try:
                ziel["anzahl"] = int(p["anzahl"])
            except Exception:
                return {"ok": False, "fehler": "Anzahl ist keine Zahl."}
        if "modell" in p and p["modell"] not in (None, ""):
            m = _modell_norm(p["modell"])
            if m is None:
                return {"ok": False, "fehler": "Unbekanntes Modell."}
            ziel["modell"] = m
        if "zugestellt_am" in p:
            ziel["zugestellt_am"] = _iso(_zeit(p["zugestellt_am"], tz)) if p["zugestellt_am"] else None
            if not ziel["zugestellt_am"] and not lid.startswith("H"):
                ziel.pop("zugestellt_am", None)
        if "notiz" in p:
            ziel["notiz"] = str(p.get("notiz") or "").strip()[:500]
        if "transmitter" in p:
            if p["transmitter"] in (None, ""):
                if lid.startswith("H"):
                    ziel["transmitter"] = None
                else:
                    ziel.pop("transmitter", None)
            else:
                ziel["transmitter"] = int(p["transmitter"])
        # Versand, Versorgungszeitraum, Sendungsnummer (leer = wie aus den Mails)
        neu_werte = {}
        if "versendet" in p:
            neu_werte["versendet"] = _iso(_zeit(p["versendet"], tz)) if p["versendet"] not in (None, "") else None
        for feld in ("zeitraum_von", "zeitraum_bis"):
            if feld in p:
                neu_werte[feld] = tag(p[feld])
        if "sendungsnr" in p:
            neu_werte["sendungsnr"] = re.sub(r"\s+", "", str(p["sendungsnr"] or ""))[:40] or None
        for feld, wert in neu_werte.items():
            if wert is None and not lid.startswith("H"):
                ziel.pop(feld, None)
            else:
                ziel[feld] = wert
    else:
        return {"ok": False, "fehler": "Unbekannte Aktion: " + aktion}
    if not lid.startswith("H"):
        if ziel:
            daten["korrekturen"]["lieferungen"][lid] = ziel
        else:
            daten["korrekturen"]["lieferungen"].pop(lid, None)
    return {"ok": True, "id": lid, "aktion": aktion}


def _rezept_termin(daten, bis, jetzt):
    """Folgerezept-Termin von Hand setzen (leer = wieder aus den Mails)."""
    if bis in (None, ""):
        daten["korrekturen"]["rezept"] = {}
        return {"ok": True, "termin": None}
    d = _datum(bis)
    if d is None:
        return {"ok": False, "fehler": "Datum nicht erkannt."}
    daten["korrekturen"]["rezept"] = {"bis": d.isoformat(), "gesetzt": _iso(jetzt)}
    return {"ok": True, "termin": d.isoformat()}


def _einst_sauber(neu, alt):
    e = dict(alt)
    neu = neu if isinstance(neu, dict) else {}
    if isinstance(neu.get("laufzeit"), dict):
        lz = {}
        for m in MODELLE:
            x = dict(alt["laufzeit"].get(m) or _STANDARD_LAUFZEIT[m])
            y = neu["laufzeit"].get(m) or {}
            for k, lo, hi in (("tage", 1, 30), ("nachlauf_h", 0, 48)):
                if k in y:
                    try:
                        x[k] = min(hi, max(lo, float(str(y[k]).replace(",", "."))))
                    except Exception:
                        pass
            lz[m] = x
        e["laufzeit"] = lz
    if isinstance(neu.get("melden"), dict):
        mel = dict(alt["melden"])
        for k in _STANDARD_MELDEN:
            if k in neu["melden"]:
                mel[k] = bool(neu["melden"][k])
        e["melden"] = mel
    for k, lo, hi in (("quartal_anzahl", 0, 60), ("ersatz_anzahl", 0, 10), ("wechsel_vorlauf_h", 0, 48), ("ruhe_von", 0, 23),
                      ("ruhe_bis", 0, 23), ("ersatz_tage", 1, 60), ("rezept_vorlauf_tage", 1, 120), ("knapp_tage", 0, 60),
                      ("foto_tage", 1, 60), ("transmitter_tage", 30, 200), ("transmitter_je_lieferung", 0, 5),
                      ("transmitter_vorlauf_tage", 0, 60)):
        if k in neu and neu[k] not in (None, ""):
            try:
                v = float(str(neu[k]).replace(",", "."))
                e[k] = int(v) if k != "wechsel_vorlauf_h" else v
                e[k] = min(hi, max(lo, e[k]))
            except Exception:
                pass
    if "modell_lieferung" in neu and _modell_norm(neu["modell_lieferung"]):
        e["modell_lieferung"] = _modell_norm(neu["modell_lieferung"])
    if "notify" in neu:
        e["notify"] = str(neu["notify"] or "").replace("notify.", "").strip()
    if "erkennung" in neu:
        e["erkennung"] = bool(neu["erkennung"])
    if "gmail_ab" in neu and _datum(neu["gmail_ab"]):
        e["gmail_ab"] = _datum(neu["gmail_ab"]).isoformat()
    return e


def _sitzung(daten, neu_s, jetzt, tz, je):
    """Neue Sitzung aus dem „Sensorende“ der CGM-Integration erkennen. Liefert None oder {aktion, id, …}."""
    neu = _zeit(neu_s, tz)
    if neu is None:
        return None
    sensoren = daten["sensoren"]
    for s in sensoren:
        eq = _zeit(s.get("ende_quelle"), tz)
        if eq is not None and abs((eq - neu).total_seconds()) <= 3 * 3600:
            if eq != neu:
                s["ende_quelle"] = _iso(neu)
                tage, _n = _laufzeit(daten["einstellungen"], s.get("modell"))
                s["sitzung_start"] = _iso(neu - timedelta(days=tage))
                return {"aktion": "angepasst", "id": s["id"]}
            return None
    modell = _modell_vermuten(daten, je)
    tage, _n = _laufzeit(daten["einstellungen"], modell)
    start = neu - timedelta(days=tage)
    if start > jetzt + timedelta(hours=1):
        return None
    for s in sensoren:
        g = _zeit(s.get("gesetzt"), tz)
        if g is not None and not s.get("ende_quelle") and start - timedelta(hours=12) <= g <= start + timedelta(hours=3):
            tage2, _n2 = _laufzeit(daten["einstellungen"], s.get("modell"))
            s["sitzung_start"] = _iso(neu - timedelta(days=tage2))
            s["ende_quelle"] = _iso(neu)
            _eintrag(s, jetzt, "Sitzung erkannt (Start " + (neu - timedelta(days=tage2)).strftime("%d.%m. %H:%M") + ")")
            return {"aktion": "verknuepft", "id": s["id"]}
    juengster = None
    for s in sensoren:
        g = _zeit(s.get("gesetzt"), tz)
        if g is not None and (juengster is None or g > juengster):
            juengster = g
    if juengster is not None and juengster > start + timedelta(hours=3):
        return None
    s = _leerer_sensor(jetzt)
    s.update({"modell": modell, "gesetzt": _iso(start), "sitzung_start": _iso(start), "ende_quelle": _iso(neu), "quelle": "automatisch"})
    _eintrag(s, jetzt, "automatisch erkannt (Sensorende " + neu.strftime("%d.%m. %H:%M") + ")")
    sensoren.append(s)
    return {"aktion": "neu", "id": s["id"], "modell": modell, "start": _iso(start)}


def _ausgabe(a, daten, mails_info, jetzt):
    """Antwort für die Karte (nur JSON-taugliche Werte)."""
    def lief_out(L):
        return {"id": L["id"], "art": L["art"], "anzahl": L["anzahl"], "modell": L["modell"], "status": L["status"],
                "versendet": _iso(L.get("versendet")), "bestellt": _iso(L.get("bestellt")), "zugestellt_am": _iso(L.get("zugestellt_am")),
                "zugestellt_angenommen": L.get("zugestellt_angenommen", False), "erwartet": L.get("erwartet"), "sendungsnr": L.get("sendungsnr"), "zeitraum_von": L.get("zeitraum_von"),
                "zeitraum_bis": L.get("zeitraum_bis"), "teil": L.get("teil"), "letzte": L.get("letzte"),
                "folgerezept": L.get("folgerezept"), "bestellnr": L.get("bestellnr"), "faelle": L.get("faelle") or [],
                "transmitter": L.get("transmitter") or 0, "manuell": L["manuell"], "aus": L.get("aus", False), "notiz": L.get("notiz") or "", "korrigiert": L.get("korrigiert") or [],
                "herkunft": "kundendienst" if L.get("kundendienst") else ("abgeleitet" if L.get("abgeleitet") else None),
                "dhl": [{"datum": _iso(x["datum"]), "status": x["status"], "erwartet": x.get("erwartet"), "fenster": x.get("fenster")} for x in L["dhl"]]}

    def fall_out(f):
        return {"id": f["id"], "nummern": f["nummern"], "datum": _iso(f["datum"]), "antwort": f["antwort"],
                "antwort_datum": _iso(f["antwort_datum"]), "lieferung": f["lieferung"], "quelle": f["quelle"],
                "sensor": f.get("sensor"),
                "objekt": ("transmitter" if str(f.get("sensor") or "").startswith("t") else "sensor") if f.get("sensor") else None,
                "status": f["status"], "ersatz_erhalten_am": _iso(f.get("ersatz_erhalten_am")),
                "notiz": f.get("notiz") or "", "historisch": f["historisch"], "antwort_korrigiert": bool(f.get("antwort_korrigiert"))}

    lief = sorted(a["abl"]["lieferungen"], key=lambda L: (L.get("zugestellt_am") or L.get("versendet") or L.get("bestellt") or jetzt), reverse=True)
    faelle = sorted(a["abl"]["faelle"], key=lambda f: f["datum"], reverse=True)
    fall_je_sensor = {}
    for f in faelle:
        if f.get("sensor"):
            fall_je_sensor[f["sensor"]] = fall_out(f)
    sens = []
    for s in reversed(a["sensoren"]):
        x = dict(s)
        x["fall_info"] = fall_je_sensor.get(s["id"])
        sens.append(x)
    best = a["bestand"]
    txl = a.get("transmitter") or {}
    t_liste = []
    for t in reversed(txl.get("liste") or []):
        x = dict(t)
        x["fall_info"] = fall_je_sensor.get(t["id"])
        t_liste.append(x)
    t_akt = txl.get("aktuell")
    return {
        "ok": True,
        "version": daten["zaehler"],
        "karte": VERSION,
        "jetzt": _iso(jetzt),
        "heute": jetzt.date().isoformat(),
        "aktuell": dict(a["aktuell"], fall_info=fall_je_sensor.get(a["aktuell"]["id"])) if a["aktuell"] else None,
        "sensoren": sens,
        "lieferungen": [lief_out(L) for L in lief],
        "naechste": a["abl"]["naechste"],
        "naechste_ausgeblendet": bool(a["abl"].get("naechste_ausgeblendet")),
        "faelle": [fall_out(f) for f in faelle],
        "bestand": best,
        "reicht_bis": _iso(a["reicht_bis"]),
        "unterwegs": a["unterwegs"],
        "folgerezept": a["folgerezept"],
        "genehmigung_bis": a["abl"]["genehmigung"]["bis"] if a["abl"]["genehmigung"] else None,
        "warnungen": a["warnungen"],
        "einstellungen": daten["einstellungen"],
        "inventur": daten.get("inventur"),
        "transmitter": {
            "relevant": bool(txl.get("relevant")),
            "liste": t_liste,
            "aktuell": dict(t_akt, fall_info=fall_je_sensor.get(t_akt["id"])) if t_akt else None,
            "bestand": txl.get("bestand"),
            "wechsel_am": _iso(txl.get("wechsel_am")),
            "inventur": daten.get("transmitter_inventur"),
        },
        "modelle": MODELLE,
        "arten": ARTEN,
        "gmail": mails_info,
        "meldungen": list(reversed(daten.get("meldungen") or []))[:15],
        "papierkorb": [{"id": s["id"], "art": s.get("art") or "sensor", "modell": s.get("modell"), "gesetzt": s.get("gesetzt") or s.get("gestartet"),
                        "lot": s.get("lot"), "sn": s.get("sn"), "geloescht": s.get("geloescht")} for s in reversed(daten.get("papierkorb") or [])][:10],
    }


def _foto_id_ok(fid):
    return bool(re.match(r"^f\d{14}-[0-9a-f]{6}$", str(fid or "")))


def _neue_foto_id(jetzt):
    return "f" + jetzt.strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:6]


def _fotos_entfernen(daten, weg):
    """Verweise auf gelöschte Fotos an den Sensoren entfernen; liefert die Zahl der geänderten Sensoren."""
    n = 0
    for s in (daten.get("sensoren") or []) + (daten.get("papierkorb") or []):
        f = s.get("foto") or {}
        if f.get("id") and f["id"] in weg:
            s["foto"] = None
            n += 1
    return n


def _als_text(d):
    return json.dumps(d, ensure_ascii=False, indent=1)
