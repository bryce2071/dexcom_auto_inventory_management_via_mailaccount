"""Mails lesen (IMAP, nur lesend).

Blockierend – läuft über ``hass.async_add_executor_job``. Gelesen wird ausschließlich mit
``BODY.PEEK``: nichts wird als gelesen markiert, verschoben oder gelöscht.

- Gmail (erkannt an der Server-Fähigkeit ``X-GM-EXT-1``): Suche mit der Gmail-Syntax im Ordner
  „Alle Nachrichten“ (Ordner mit dem Merkmal ``\\All``).
- Andere Anbieter: normale IMAP-Suche (``SINCE`` + Absender dexcom.com, custhelp.com, dhl.de)
  im eingestellten Ordner, sonst im Posteingang. DHL-Mails ohne „Dexcom“ erkennt die Logik als
  „andere“ und lässt sie außen vor.
"""

from __future__ import annotations

import email
import html as html_mod
import imaplib
import re
from datetime import date
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime
from typing import Any

from .logik import _mail_lesen

GMAIL_SUCHE = "(from:dexcom.com OR from:dexcom_intl@mailft.custhelp.com OR (from:dhl.de dexcom))"
IMAP_ABSENDER = ("dexcom.com", "custhelp.com", "dhl.de")
_MONATE = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


class AnmeldungFehler(Exception):
    """Benutzername oder Passwort falsch."""


class VerbindungFehler(Exception):
    """Server nicht erreichbar."""


def _dek(x: Any) -> str:
    try:
        return str(make_header(decode_header(x or "")))
    except Exception:  # noqa: BLE001
        return str(x or "")


def _text_aus(msg: email.message.Message) -> str:
    plain: list[str] = []
    htm: list[str] = []
    for part in msg.walk():
        if part.is_multipart() or part.get_filename():
            continue
        ct = part.get_content_type()
        if ct not in ("text/plain", "text/html"):
            continue
        try:
            t = (part.get_payload(decode=True) or b"").decode(part.get_content_charset() or "utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            continue
        if ct == "text/plain":
            plain.append(t)
        else:
            t = re.sub(r"(?is)<(script|style|head).*?</\1>", " ", t)
            t = re.sub(r"(?is)<br\s*/?>|</p>|</tr>|</div>|</li>|</h\d>|</td>", "\n", t)
            t = html_mod.unescape(re.sub(r"(?s)<[^>]+>", " ", t))
            htm.append(t)
    t = "\n".join(htm) if len("".join(htm).strip()) > 40 else "\n".join(plain)
    t = html_mod.unescape(t)
    t = re.sub("[\u200b-\u200f\u034f\u00ad\ufeff]", "", t).replace("\xa0", " ")
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"[ \t\r\f\v]+", " ", t)
    t = re.sub(r"\n\s*\n+", "\n", t)
    return t.strip()


def _verbinden(zugang: dict) -> imaplib.IMAP4_SSL:
    try:
        verbindung = imaplib.IMAP4_SSL(zugang["server"], int(zugang.get("port") or 993), timeout=60)
    except Exception as exc:  # noqa: BLE001
        raise VerbindungFehler(str(exc)[:200]) from exc
    try:
        verbindung.login(zugang["benutzer"], zugang["passwort"])
    except imaplib.IMAP4.error as exc:
        try:
            verbindung.logout()
        except Exception:  # noqa: BLE001
            pass
        raise AnmeldungFehler(str(exc)[:200]) from exc
    return verbindung


def _ist_gmail(verbindung: imaplib.IMAP4_SSL) -> bool:
    return "X-GM-EXT-1" in (verbindung.capabilities or ())


def _ordner_waehlen(verbindung: imaplib.IMAP4_SSL, zugang: dict, gmail: bool) -> str:
    gewuenscht = str(zugang.get("ordner") or "").strip()
    if gewuenscht:
        return gewuenscht
    if gmail:
        _typ, liste = verbindung.list()
        for zeile in liste or []:
            text = zeile.decode("utf-8", errors="replace") if isinstance(zeile, bytes) else str(zeile)
            if "\\All" in text:
                treffer = re.search(r'"([^"]+)"\s*$', text) or re.search(r"(\S+)\s*$", text)
                if treffer:
                    return treffer.group(1)
    return "INBOX"


def zugang_pruefen(zugang: dict) -> dict:
    """Meldet sich an und wählt den Ordner. Liefert {gmail, ordner} oder wirft Anmeldung-/VerbindungFehler."""
    verbindung = _verbinden(zugang)
    try:
        gmail = _ist_gmail(verbindung)
        ordner = _ordner_waehlen(verbindung, zugang, gmail)
        typ, _ = verbindung.select('"' + ordner + '"', readonly=True)
        if typ != "OK":
            raise VerbindungFehler("Ordner „" + ordner + "“ nicht gefunden")
        return {"gmail": gmail, "ordner": ordner}
    finally:
        try:
            verbindung.logout()
        except Exception:  # noqa: BLE001
            pass


def mails_holen(
    zugang: dict,
    ab: date,
    bekannte: list[str],
    max_neu: int,
    text_len: int,
    nur_uids: list[str],
    tz: Any,
    parsen: bool,
    suche: str = "",
) -> dict:
    """Sucht die Dexcom-, Support- und DHL-Mails ab „ab“ und liest neue (nicht in „bekannte“).

    Liefert {"uids": [...], "neu": {uid: erkannte Felder bzw. Rohdaten}, "ordner", "gmail"}.
    """
    bek = set(bekannte or [])
    verbindung = _verbinden(zugang)
    try:
        gmail = _ist_gmail(verbindung)
        ordner = _ordner_waehlen(verbindung, zugang, gmail)
        typ, _ = verbindung.select('"' + ordner + '"', readonly=True)
        if typ != "OK":
            raise VerbindungFehler("Ordner „" + ordner + "“ nicht gefunden")
        if nur_uids:
            uids = [str(u) for u in nur_uids]
        else:
            suche = str(suche or "").replace('"', "").strip()
            if gmail:
                abfrage = suche or ("after:" + ab.strftime("%Y/%m/%d") + " " + GMAIL_SUCHE)
                if abfrage.isascii():
                    _typ, daten = verbindung.uid("SEARCH", "X-GM-RAW", '"' + abfrage + '"')
                else:
                    # Umlaute: als Literal mit Zeichensatz senden
                    verbindung.literal = abfrage.encode("utf-8")
                    _typ, daten = verbindung.uid("SEARCH", "CHARSET", "UTF-8", "X-GM-RAW")
            else:
                seit = f"{ab.day:02d}-{_MONATE[ab.month - 1]}-{ab.year}"
                von = " ".join('FROM "' + a + '"' for a in IMAP_ABSENDER)
                kriterien = "SINCE " + seit + " " + "OR " * (len(IMAP_ABSENDER) - 1) + von
                if suche and suche.isascii():
                    _typ, daten = verbindung.uid("SEARCH", kriterien + ' TEXT "' + suche + '"')
                elif suche:
                    verbindung.literal = suche.encode("utf-8")
                    _typ, daten = verbindung.uid("SEARCH", "CHARSET", "UTF-8", kriterien, "TEXT")
                else:
                    _typ, daten = verbindung.uid("SEARCH", kriterien)
            uids = [u.decode() for u in ((daten[0] or b"").split() if daten else [])]
        neu: dict[str, Any] = {}
        nur_kopf = (not parsen) and text_len <= 0
        teil = "(BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])" if nur_kopf else "(BODY.PEEK[])"
        for uid in reversed(uids):
            if uid in bek or len(neu) >= max_neu:
                continue
            _typ, antwort = verbindung.uid("FETCH", uid, teil)
            roh = None
            for stueck in antwort or []:
                if isinstance(stueck, tuple) and len(stueck) > 1:
                    roh = stueck[1]
            if roh is None:
                continue
            msg = email.message_from_bytes(roh)
            name, adr = parseaddr(_dek(msg.get("From", "")))
            try:
                datum = parsedate_to_datetime(msg.get("Date")).astimezone(tz).isoformat(timespec="minutes")
            except Exception:  # noqa: BLE001
                datum = ""
            m = {"uid": uid, "datum": datum, "von": (name + " <" + adr + ">").strip(), "betreff": _dek(msg.get("Subject", ""))}
            if not nur_kopf:
                m["text"] = _text_aus(msg)[: max(text_len, 0) or 8000]
            neu[uid] = _mail_lesen(m, tz) if parsen else m
        return {"uids": uids, "neu": neu, "ordner": ordner, "gmail": gmail}
    finally:
        try:
            verbindung.logout()
        except Exception:  # noqa: BLE001
            pass
