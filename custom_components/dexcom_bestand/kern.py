"""Laufzeit des Dexcom-Sensorbestands: Daten, Mails, Sensorwechsel, Meldungen, Fotos, Zeitplan, Dienste.

Entspricht dem Pyscript-Teil der früheren Fassung (Laden, Speichern, Auslöser, Dienste);
die reine Logik liegt unverändert in ``logik.py``, Datei- und Mailzugriffe in ``speicher.py``
und ``mail.py`` (blockierend, über den Executor).
"""

from __future__ import annotations

import asyncio
import copy
import logging
from datetime import date, datetime, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import (
    async_call_later,
    async_track_state_change_event,
    async_track_time_change,
)
from homeassistant.helpers.start import async_at_started
from homeassistant.util import dt as dt_util

from . import logik as L
from . import mail, speicher
from .const import (
    CONF_ANFANG,
    CONF_BENUTZER,
    CONF_MAIL,
    CONF_ORDNER,
    CONF_PASSWORT,
    CONF_PORT,
    CONF_SENSORENDE,
    CONF_SERVER,
    DATEINAME,
    FOTO_MAX,
    FOTOORDNER,
    MAIL_EIGEN,
    MAIL_KEINE,
    MAIL_ZEITEN,
    MAILDATEINAME,
    ORDNER,
    OPT_LINK,
    SICHERUNGEN,
    SIGNAL_AKTUALISIERT,
    STANDARD_LINK,
    STANDARD_PORT,
    START_VERZOEGERUNG,
    UHR_SICHERUNG,
)

_LOGGER = logging.getLogger(__name__)

LEER = (None, "", "unknown", "unavailable")


def einstellungen_zusammen(entry: ConfigEntry) -> dict[str, Any]:
    """Daten und Optionen des Eintrags (Optionen haben Vorrang)."""
    return {**entry.data, **entry.options}


class DexcomKern:
    """Hält Daten und Mail-Zwischenspeicher im Speicher und erledigt alles für Karte, Sensoren und Dienste."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        opt = einstellungen_zusammen(entry)
        self.mail_quelle: str = str(opt.get(CONF_MAIL) or MAIL_KEINE)
        self.sensorende: str = str(opt.get(CONF_SENSORENDE) or "")
        self.link: str = str(opt.get(OPT_LINK) or STANDARD_LINK)
        self.ordner = hass.config.path(ORDNER)
        self.pfad = hass.config.path(ORDNER, DATEINAME)
        self.mailpfad = hass.config.path(ORDNER, MAILDATEINAME)
        self.fotoordner = hass.config.path(ORDNER, FOTOORDNER)
        self.daten: dict[str, Any] = L._normalisieren({})
        self.mails: dict[str, Any] = {"mails": {}, "stand": "", "treffer": 0, "fehler": ""}
        self.anzeige: dict[str, Any] = {}
        self._neu = False
        self._schreiben = asyncio.Lock()
        self._mail_sperre = asyncio.Lock()
        self._pruefen_laeuft = False
        self._mail_timer = None
        self._abmelden: list = []

    # ------------------------------------------------------------------ Hilfen

    @staticmethod
    def _tz():
        holen = getattr(dt_util, "get_default_time_zone", None)
        return holen() if holen else dt_util.DEFAULT_TIME_ZONE

    async def _ex(self, funktion, *args):
        return await self.hass.async_add_executor_job(funktion, *args)

    def _auswerten(self, jetzt: datetime | None = None) -> dict:
        return L._auswerten(self.daten, self.mails["mails"], jetzt or dt_util.now(), self._tz())

    # ------------------------------------------------------------------ Start/Stopp

    async def async_start(self) -> None:
        """Daten laden, Startwerte übernehmen, Anzeige setzen, Zeitplan und Auslöser anmelden."""
        await self._async_laden()
        await self._async_mails_laden()
        self._anfang_anwenden()
        await self.async_speichern()
        self.veroeffentlichen()
        jetzt = dt_util.now()
        if jetzt.strftime("%H:%M") > UHR_SICHERUNG:
            # Fiel die nächtliche Sicherung z. B. in einen Neustart, wird sie jetzt nachgeholt
            await self._async_sichern(jetzt.date().isoformat())
        self._abmelden.append(
            async_track_time_change(self.hass, self._async_takt, minute=list(range(0, 60, 5)), second=0)
        )
        if self.sensorende:
            self._abmelden.append(
                async_track_state_change_event(self.hass, [self.sensorende], self._async_sensorende)
            )
        if self.mail_quelle.startswith("imap:"):
            self._abmelden.append(self.hass.bus.async_listen("imap_content", self._async_imap_ereignis))
        self._abmelden.append(async_at_started(self.hass, self._async_gestartet))
        _LOGGER.info("Dexcom: %d Sensoren geladen", len(self.daten["sensoren"]))

    async def async_stop(self) -> None:
        """Abmelden und auf einen laufenden Schreibvorgang warten."""
        for abmelden in self._abmelden:
            abmelden()
        self._abmelden.clear()
        if self._mail_timer:
            self._mail_timer()
            self._mail_timer = None
        async with self._schreiben:
            pass

    async def _async_gestartet(self, _hass: HomeAssistant) -> None:
        self._abmelden.append(async_call_later(self.hass, START_VERZOEGERUNG, self._async_nach_start))

    async def _async_nach_start(self, _jetzt: datetime) -> None:
        """Kurz nach dem Start: alte Fotos löschen, Mails lesen, Sensorende prüfen, Meldungen senden."""
        await self._async_fotos_pflegen()
        if self.mail_quelle != MAIL_KEINE:
            try:
                await self.async_gmail()
            except Exception as exc:  # noqa: BLE001
                _LOGGER.warning("Dexcom: Mails beim Start: %s", exc)
        if self.sensorende:
            zustand = self.hass.states.get(self.sensorende)
            try:
                await self._async_sitzung_pruefen(zustand.state if zustand else None)
            except Exception as exc:  # noqa: BLE001
                _LOGGER.warning("Dexcom: Sitzungsprüfung beim Start: %s", exc)
        await self.async_pruefen()

    # ------------------------------------------------------------------ Laden und Speichern

    async def _async_laden(self) -> None:
        self._neu = not await self._ex(speicher.datei_da, self.pfad)
        daten, fehler = await self._ex(speicher.datei_lesen, self.pfad)
        if fehler:
            _LOGGER.error("Dexcom: %s ist nicht lesbar (%s) – nehme die letzte Sicherung", self.pfad, fehler)
            await self._ex(speicher.datei_beiseite, self.pfad, dt_util.now().strftime("%Y%m%d-%H%M%S"))
            daten = await self._ex(speicher.letzte_sicherung, self.ordner)
        d = L._normalisieren(daten or {})
        if not d["einstellungen"].get("start"):
            d["einstellungen"]["start"] = dt_util.now().date().isoformat()
        self.daten = d

    async def _async_mails_laden(self) -> None:
        m, fehler = await self._ex(speicher.datei_lesen, self.mailpfad)
        if fehler:
            _LOGGER.warning("Dexcom: %s nicht lesbar (%s) – lese die Mails neu", self.mailpfad, fehler)
        m = m if isinstance(m, dict) else {}
        self.mails = {
            "mails": dict(m.get("mails") or {}),
            "stand": m.get("stand") or "",
            "treffer": m.get("treffer") or 0,
            "fehler": m.get("fehler") or "",
        }

    def _anfang_anwenden(self) -> None:
        """Werte aus dem Einrichtungsdialog einmalig übernehmen (Bestand nur, wenn es noch keinen gibt)."""
        anfang = self.entry.data.get(CONF_ANFANG) or {}
        einst = self.daten["einstellungen"]
        if not anfang or einst.get("eingerichtet") == self.entry.entry_id:
            return
        neu = {k: anfang[k] for k in ("notify", "gmail_ab", "modell_lieferung", "quartal_anzahl") if anfang.get(k) not in (None, "")}
        if not self._neu and self.daten.get("inventur"):
            # vorhandene Daten (z. B. aus der Pyscript-Fassung): nur Handy und Mail-Zeitraum übernehmen
            neu = {k: v for k, v in neu.items() if k in ("notify", "gmail_ab")}
        self.daten["einstellungen"] = L._einst_sauber(neu, einst)
        if anfang.get("bestand") is not None and (self._neu or not self.daten.get("inventur")):
            bestand = {}
            for modell, anzahl in (anfang.get("bestand") or {}).items():
                m = L._modell_norm(modell)
                if m:
                    bestand[m] = int(anzahl or 0)
            zeit = L._zeit(anfang.get("zeit"), self._tz()) or dt_util.now()
            self.daten["inventur"] = {"zeit": L._iso(zeit), "bestand": bestand or {"G6": 0, "G7": 0}, "erstellt": L._iso(dt_util.now())}
        self.daten["einstellungen"]["eingerichtet"] = self.entry.entry_id
        self.daten["zaehler"] = int(self.daten.get("zaehler") or 0) + 1

    async def async_speichern(self) -> bool:
        async with self._schreiben:
            try:
                await self._ex(speicher.datei_schreiben, self.pfad, L._als_text(self.daten))
                return True
            except Exception as exc:  # noqa: BLE001
                _LOGGER.error("Dexcom: Speichern fehlgeschlagen: %s", exc)
                return False

    async def _async_mails_speichern(self) -> None:
        try:
            await self._ex(speicher.datei_schreiben, self.mailpfad, L._als_text(self.mails))
        except Exception as exc:  # noqa: BLE001
            _LOGGER.error("Dexcom: Mail-Zwischenspeicher nicht geschrieben: %s", exc)

    async def _async_sichern(self, tag: str) -> None:
        try:
            await self._ex(speicher.datei_sichern, self.ordner, self.pfad, tag, SICHERUNGEN)
        except Exception as exc:  # noqa: BLE001
            _LOGGER.warning("Dexcom: Sicherung fehlgeschlagen: %s", exc)

    async def async_geaendert(self) -> bool:
        self.daten["zaehler"] = int(self.daten.get("zaehler") or 0) + 1
        ok = await self.async_speichern()
        self.veroeffentlichen()
        return ok

    async def async_einstellungen_setzen(self, neu: dict) -> None:
        """Einstellungen ändern (z. B. Handy aus den Optionen der Integration)."""
        self.daten["einstellungen"] = L._einst_sauber(neu, self.daten["einstellungen"])
        await self.async_geaendert()

    # ------------------------------------------------------------------ Anzeige

    @callback
    def veroeffentlichen(self, a: dict | None = None) -> dict:
        """Auswertung neu berechnen und die Sensoren benachrichtigen."""
        if a is None:
            a = self._auswerten()
        d = self.daten
        best = a["bestand"]
        akt = a["aktuell"]
        n = a["abl"]["naechste"]
        offen = len([f for f in a["abl"]["faelle"] if not f["historisch"] and f["status"] in ("offen", "zugesagt", "unterwegs")])
        lief_status = "–"
        lief_text = ""
        unterwegs = [x for x in a["abl"]["lieferungen"] if x["id"] in a["unterwegs"]]
        if unterwegs:
            x = unterwegs[-1]
            lief_status = {"versendet": "versendet", "unterwegs": "unterwegs", "heute": "kommt heute", "verzoegert": "verzögert",
                           "abholbereit": "abholbereit"}.get(x["status"], x["status"])
            lief_text = ("Ersatz" if x["art"] == "ersatz" else "Lieferung") + " " + lief_status + (", erwartet " + x["erwartet"] if x.get("erwartet") else "")
        elif n:
            lief_status = "überfällig" if n["status"] == "ueberfaellig" else "angekündigt"
            lief_text = "Zustellung bis " + (n.get("frist") or "?")
        self.anzeige = {
            "bestand": best["gesamt"] if best else None,
            "bestand_attr": {
                "version": d["zaehler"],
                "je_modell": best["je_modell"] if best else {},
                "inventur_seit": best["seit"] if best else None,
                "reicht_bis": L._iso(a["reicht_bis"]),
                "aktueller_sensor": ({"modell": akt.get("modell"), "gesetzt": akt.get("gesetzt"), "ende": akt.get("ende"),
                                      "status": akt.get("status"), "tag": akt.get("tag"), "lot": akt.get("lot")} if akt else None),
                "lieferung": lief_status,
                "offene_reklamationen": offen,
                "folgerezept_bis": a["folgerezept"]["bis"] if a["folgerezept"] else None,
                "warnungen": [w["text"] for w in a["warnungen"]],
            },
            "ende": akt["ende"] if (akt and akt.get("ende")) else None,
            "ende_attr": {
                "modell": akt.get("modell") if akt else None,
                "gesetzt": akt.get("gesetzt") if akt else None,
                "status": akt.get("status") if akt else None,
                "tag": akt.get("tag") if akt else None,
            },
            "lieferung": lief_status,
            "lieferung_attr": {"text": lief_text, "naechste": n, "unterwegs": a["unterwegs"]},
        }
        async_dispatcher_send(self.hass, SIGNAL_AKTUALISIERT)
        return a

    # ------------------------------------------------------------------ Benachrichtigungen

    async def _async_push(self, titel: str, text: str, tag: str) -> bool:
        dienst = str(self.daten["einstellungen"].get("notify") or "").replace("notify.", "").strip()
        if not dienst:
            return False
        if not self.hass.services.has_service("notify", dienst):
            _LOGGER.warning("Dexcom: Benachrichtigungsdienst notify.%s gibt es nicht", dienst)
            return False
        daten: dict[str, Any] = {"title": titel, "message": text}
        if dienst.startswith("mobile_app_"):
            daten["data"] = {"clickAction": self.link, "url": self.link, "tag": tag, "group": "dexcom", "channel": "Dexcom",
                             "notification_icon": "mdi:needle"}
        try:
            await self.hass.services.async_call("notify", dienst, daten, blocking=True)
            return True
        except Exception as exc:  # noqa: BLE001 - fehlendes Handy darf nichts blockieren
            _LOGGER.warning("Dexcom: Benachrichtigung über notify.%s ging nicht: %s", dienst, exc)
            return False

    def _gemeldet(self, m: dict, jetzt: datetime) -> None:
        d = self.daten
        d["gemeldet"][m["key"]] = L._iso(jetzt)
        for k in m.get("auch") or []:
            d["gemeldet"][k] = L._iso(jetzt)
        grenze = jetzt - timedelta(days=200)
        alt = [k for k, v in d["gemeldet"].items() if (L._zeit(v, self._tz()) or jetzt) < grenze]
        for k in alt:
            d["gemeldet"].pop(k, None)
        d["meldungen"].append({"z": L._iso(jetzt), "art": m["art"], "titel": m["titel"], "text": m["text"]})
        d["meldungen"] = d["meldungen"][-L.MELDUNGEN_MAX:]

    async def async_pruefen(self, probelauf: bool = False) -> list:
        """Fällige Meldungen bestimmen und (ohne Probelauf) senden."""
        if self._pruefen_laeuft and not probelauf:
            return []
        self._pruefen_laeuft = True
        try:
            jetzt = dt_util.now()
            a = self._auswerten(jetzt)
            faellig = L._meldungen_faellig(a, self.daten, jetzt, self._tz())
            if probelauf or not faellig:
                return faellig
            for m in faellig:
                if await self._async_push(m["titel"], m["text"], m["tag"]):
                    self._gemeldet(m, jetzt)
                    _LOGGER.info("Dexcom: Meldung „%s“ gesendet", m["titel"])
            await self.async_speichern()
            return faellig
        finally:
            self._pruefen_laeuft = False

    # ------------------------------------------------------------------ Fotos

    async def _async_fotos_pflegen(self) -> int:
        try:
            weg = await self._ex(speicher.fotos_aufraeumen, self.fotoordner, self.daten["einstellungen"].get("foto_tage", 7))
        except Exception as exc:  # noqa: BLE001
            _LOGGER.warning("Dexcom: Fotos aufräumen fehlgeschlagen: %s", exc)
            return 0
        if weg and L._fotos_entfernen(self.daten, set(weg)):
            await self.async_geaendert()
        if weg:
            _LOGGER.info("Dexcom: %d alte Fotos gelöscht", len(weg))
        return len(weg)

    # ------------------------------------------------------------------ Mails

    def zugang(self) -> dict | None:
        """Zugangsdaten zum Postfach: aus einer IMAP-Integration oder aus der Einrichtung."""
        q = self.mail_quelle
        if q.startswith("imap:"):
            eintrag = self.hass.config_entries.async_get_entry(q.split(":", 1)[1])
            if eintrag is None:
                return None
            d = eintrag.data
            return {"server": d.get("server"), "port": int(d.get("port") or STANDARD_PORT), "benutzer": d.get("username"),
                    "passwort": d.get("password"), "ordner": ""}
        if q == MAIL_EIGEN:
            opt = einstellungen_zusammen(self.entry)
            return {"server": opt.get(CONF_SERVER), "port": int(opt.get(CONF_PORT) or STANDARD_PORT),
                    "benutzer": opt.get(CONF_BENUTZER), "passwort": opt.get(CONF_PASSWORT), "ordner": opt.get(CONF_ORDNER) or ""}
        return None

    def _mails_ab(self) -> date:
        return L._datum(self.daten["einstellungen"].get("gmail_ab")) or (dt_util.now().date() - timedelta(days=365))

    async def async_gmail(self, neu: bool = False) -> dict:
        """Neue Dexcom-, Support- und DHL-Mails lesen (mit „neu“ alle noch einmal)."""
        async with self._mail_sperre:
            mc = self.mails
            z = self.zugang()
            if z is None:
                mc["fehler"] = (
                    "Kein Postfach eingerichtet (Integration → Konfigurieren)."
                    if self.mail_quelle == MAIL_KEINE
                    else "Das gewählte Postfach (IMAP-Integration) gibt es nicht mehr."
                )
                return {"ok": False, "fehler": mc["fehler"]}
            bekannte = [] if neu else list(mc["mails"].keys())
            try:
                r = await self._ex(mail.mails_holen, z, self._mails_ab(), bekannte, 200, 8000, [], self._tz(), True)
            except mail.AnmeldungFehler:
                mc["fehler"] = "Anmeldung am Postfach fehlgeschlagen – Zugangsdaten prüfen (bei Gmail ein App-Passwort)."
                _LOGGER.warning("Dexcom: %s", mc["fehler"])
                self.veroeffentlichen()
                return {"ok": False, "fehler": mc["fehler"]}
            except Exception as exc:  # noqa: BLE001
                mc["fehler"] = "Postfach gerade nicht erreichbar (" + str(exc)[:120] + ")"
                _LOGGER.warning("Dexcom: %s", mc["fehler"])
                self.veroeffentlichen()
                return {"ok": False, "fehler": mc["fehler"]}
            if neu:
                mc["mails"] = {}
            mc["mails"].update(r["neu"])
            mc["stand"] = L._iso(dt_util.now())
            mc["treffer"] = len(r["uids"])
            mc["fehler"] = ""
            await self._async_mails_speichern()
            zaehl: dict[str, int] = {}
            for m in r["neu"].values():
                zaehl[m.get("typ")] = zaehl.get(m.get("typ"), 0) + 1
            if r["neu"] or neu:
                await self.async_geaendert()
            else:
                self.veroeffentlichen()
            return {"ok": True, "neu": len(r["neu"]), "treffer": len(r["uids"]), "erkannt": zaehl}

    async def _async_imap_ereignis(self, event: Event) -> None:
        """Neue Mail laut IMAP-Integration: eine Minute später nachsehen (mehrere Mails → ein Lauf)."""
        absender = str(event.data.get("sender") or "").lower()
        betreff = str(event.data.get("subject") or "").lower()
        if not ("dexcom" in absender or "custhelp" in absender or ("dhl" in absender and "dexcom" in betreff)):
            return
        if self._mail_timer:
            self._mail_timer()
        self._mail_timer = async_call_later(self.hass, 60, self._async_mail_nachsehen)

    async def _async_mail_nachsehen(self, _jetzt: datetime) -> None:
        self._mail_timer = None
        try:
            await self.async_gmail()
            await self.async_pruefen()
        except Exception as exc:  # noqa: BLE001
            _LOGGER.warning("Dexcom: Mails nach neuer Mail: %s", exc)

    # ------------------------------------------------------------------ Sensorwechsel

    async def _async_sensorende(self, event: Event) -> None:
        neu = event.data.get("new_state")
        alt = event.data.get("old_state")
        wert = neu.state if neu is not None else None
        if wert in LEER or (alt is not None and alt.state == wert):
            return
        try:
            await self._async_sitzung_pruefen(wert)
        except Exception as exc:  # noqa: BLE001
            _LOGGER.warning("Dexcom: Sitzungsprüfung fehlgeschlagen: %s", exc)

    async def _async_sitzung_pruefen(self, wert: Any) -> dict | None:
        d = self.daten
        if not d["einstellungen"].get("erkennung", True) or wert in LEER:
            return None
        jetzt = dt_util.now()
        tz = self._tz()
        a = self._auswerten(jetzt)
        je = a["bestand"]["je_modell"] if a["bestand"] else None
        vorher = a["aktuell"]
        erg = L._sitzung(d, wert, jetzt, tz, je)
        if not erg:
            return None
        await self.async_geaendert()
        _LOGGER.info("Dexcom: Sitzung %s (%s)", erg["aktion"], erg["id"])
        if erg["aktion"] == "neu" and d["einstellungen"]["melden"].get("neu_erkannt"):
            best = self._auswerten(jetzt)["bestand"]
            text = "Neuer " + erg["modell"] + "-Sensor erkannt (Start " + L._zeit(erg["start"], tz).strftime("%d.%m. %H:%M") + "). "
            if best is not None:
                text += "Bestand jetzt " + L._sensoren_txt(best["gesamt"]) + ". "
            if vorher and vorher.get("gehalten_h") is None and vorher.get("start"):
                gh = (L._zeit(erg["start"], tz) - L._zeit(vorher["start"], tz)).total_seconds() / 3600.0
                if gh < vorher.get("soll_h", 240) - 12:
                    text += "Der vorige Sensor hat nur " + L._tage_txt(gh) + " gehalten – in der Karte als reklamiert markieren. "
            text += "Etikett-Foto in der Dexcom-Karte aufnehmen, dann werden LOT usw. eingetragen."
            m = {"key": "neu:" + erg["id"], "art": "neu_erkannt", "titel": "Dexcom: neuer Sensor", "text": text}
            if await self._async_push(m["titel"], m["text"], "dexcom-neu"):
                self._gemeldet(m, jetzt)
                await self.async_speichern()
        return erg

    # ------------------------------------------------------------------ Zeitplan

    async def _async_takt(self, _jetzt: datetime) -> None:
        """Alle 5 Minuten: Meldungen; 00:00 Anzeige, 03:30 Sicherung und Fotos, mehrmals täglich Mails."""
        jetzt = dt_util.now()
        hhmm = jetzt.strftime("%H:%M")
        if hhmm == "00:00":
            self.veroeffentlichen()
        try:
            await self.async_pruefen()
        except Exception as exc:  # noqa: BLE001
            _LOGGER.warning("Dexcom: Prüfung fehlgeschlagen: %s", exc)
        if hhmm == UHR_SICHERUNG:
            await self._async_sichern(jetzt.date().isoformat())
            await self._async_fotos_pflegen()
        if hhmm in MAIL_ZEITEN and self.mail_quelle != MAIL_KEINE:
            try:
                await self.async_gmail()
                await self.async_pruefen()
            except Exception as exc:  # noqa: BLE001
                _LOGGER.warning("Dexcom: Mails (%s): %s", hhmm, exc)

    # ------------------------------------------------------------------ Dienste

    async def async_dienst(self, name: str, daten: dict) -> dict:
        """Führt einen Dienst aus (gleiche Felder und Antworten wie die Pyscript-Dienste dexcom_*)."""
        methode = getattr(self, "_dienst_" + name)
        return copy.deepcopy(await methode(dict(daten or {})))

    async def _dienst_liste(self, _p: dict) -> dict:
        jetzt = dt_util.now()
        a = self._auswerten(jetzt)
        mc = self.mails
        return L._ausgabe(a, self.daten, {"stand": mc["stand"], "treffer": mc["treffer"], "mails": len(mc["mails"]),
                                          "fehler": mc["fehler"]}, jetzt)

    async def _dienst_sensor(self, p: dict) -> dict:
        foto = p.get("foto")
        if foto:
            if not L._foto_id_ok(foto) or not await self._ex(speicher.foto_da, self.fotoordner, foto):
                return {"ok": False, "fehler": "Foto nicht gefunden."}
        felder = {k: p.get(k) for k in ("id", "modell", "ref", "lot", "hergestellt", "verwendbar_bis", "gtin", "code", "sn",
                                         "gesetzt", "entfernt", "notiz", "quelle", "aus_bestand", "foto")}
        d = self.daten
        jetzt = dt_util.now()
        tz = self._tz()
        a = self._auswerten(jetzt)
        je = a["bestand"]["je_modell"] if a["bestand"] else None
        erg = L._sensor_speichern(d, felder, jetzt, tz, je)
        if not erg.get("ok"):
            return erg
        if erg["aktion"] != "unveraendert":
            await self.async_geaendert()
        a = self._auswerten(jetzt)
        s = None
        for x in a["sensoren"]:
            if x["id"] == erg["id"]:
                s = x
        best = a["bestand"]
        teile = []
        if s:
            teile.append((s.get("modell") or "?") + "-Sensor vom " + L._zeit(s["gesetzt"], tz).strftime("%d.%m. %H:%M"))
            if s.get("lot"):
                teile.append("LOT " + s["lot"])
            if s.get("verwendbar_bis"):
                teile.append("verwendbar bis " + L._datum(s["verwendbar_bis"]).strftime("%d.%m.%Y"))
            if s.get("ende") and s["status"] in ("laeuft", "nachlauf"):
                teile.append("läuft bis " + L._zeit(s["ende"], tz).strftime("%d.%m. %H:%M"))
        text = ", ".join(teile)
        if best is not None:
            text += ". Bestand: " + L._sensoren_txt(best["gesamt"]) + "."
        erg.update({"sensor": s, "bestand": best, "text": text})
        return erg

    async def _dienst_foto(self, p: dict) -> dict:
        aktion = p.get("aktion") or "hochladen"
        d = self.daten
        jetzt = dt_util.now()
        if aktion == "hochladen":
            b64 = str(p.get("daten") or "")
            if "," in b64[:80]:
                b64 = b64.split(",", 1)[1]
            b64 = b64.strip()
            if len(b64) < 100:
                return {"ok": False, "fehler": "Kein Bild übergeben."}
            fid = L._neue_foto_id(jetzt)
            try:
                groesse = await self._ex(speicher.foto_schreiben, self.fotoordner, fid, b64, FOTO_MAX)
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "fehler": "Foto nicht gespeichert: " + str(exc)[:150]}
            return {"ok": True, "foto_id": fid, "bytes": groesse, "loeschen_nach_tagen": d["einstellungen"].get("foto_tage", 7)}
        if aktion == "holen":
            fid = p.get("foto_id")
            if not L._foto_id_ok(fid):
                return {"ok": False, "fehler": "Ungültige Foto-ID."}
            b64 = await self._ex(speicher.foto_lesen, self.fotoordner, fid)
            if b64 is None:
                return {"ok": False, "fehler": "Foto ist nicht mehr da (nach der Aufbewahrungszeit gelöscht)."}
            return {"ok": True, "foto_id": fid, "mime": "image/jpeg", "daten": b64}
        if aktion == "loeschen":
            ids = []
            if p.get("foto_id") and L._foto_id_ok(p.get("foto_id")):
                ids.append(p["foto_id"])
            if p.get("sensor_id"):
                for s in d["sensoren"]:
                    if s["id"] == p["sensor_id"] and (s.get("foto") or {}).get("id"):
                        ids.append(s["foto"]["id"])
            if not ids:
                return {"ok": False, "fehler": "Kein Foto angegeben."}
            for fid in ids:
                await self._ex(speicher.foto_loeschen, self.fotoordner, fid)
            if L._fotos_entfernen(d, set(ids)):
                await self.async_geaendert()
            return {"ok": True, "geloescht": ids}
        return {"ok": False, "fehler": "Unbekannte Aktion: " + str(aktion)}

    async def _dienst_reklamation(self, p: dict) -> dict:
        werte = {"am": p.get("am"), "ausfall_am": p.get("ausfall_am")}
        for k in ("fall", "grund", "notiz"):
            if p.get(k) is not None:
                werte[k] = p[k]
        erg = L._reklamation_aktion(self.daten, str(p.get("sensor_id") or ""), str(p.get("aktion") or "setzen"), werte,
                                    dt_util.now(), self._tz())
        if erg.get("ok"):
            await self.async_geaendert()
        return erg

    async def _dienst_fall(self, p: dict) -> dict:
        werte = {"sensor_id": p.get("sensor_id"), "am": p.get("am"), "notiz": p.get("notiz"), "fall_datum": p.get("fall_datum"),
                 "antwort": p.get("antwort")}
        erg = L._fall_aktion(self.daten, L._fall_norm(p.get("fall_id")), str(p.get("aktion") or ""), werte, dt_util.now(),
                             self._tz())
        if erg.get("ok"):
            await self.async_geaendert()
        return erg

    async def _dienst_lieferung(self, p: dict) -> dict:
        werte = {"id": p.get("id"), "aktion": p.get("aktion") or "speichern", "am": p.get("am")}
        for k in ("art", "anzahl", "modell", "zugestellt_am", "versendet", "notiz", "zeitraum_von", "zeitraum_bis", "sendungsnr"):
            if p.get(k) is not None:
                werte[k] = p[k]
        erg = L._lieferung_aktion(self.daten, werte, dt_util.now(), self._tz())
        if erg.get("ok"):
            await self.async_geaendert()
        return erg

    async def _dienst_loeschen(self, p: dict) -> dict:
        d = self.daten
        sid = str(p.get("sensor_id") or "")
        if p.get("wiederherstellen"):
            s = next((x for x in d["papierkorb"] if x["id"] == sid), None)
            if s is None:
                return {"ok": False, "fehler": "Nicht im Papierkorb."}
            d["papierkorb"] = [x for x in d["papierkorb"] if x["id"] != sid]
            s.pop("geloescht", None)
            d["sensoren"].append(s)
        else:
            s = next((x for x in d["sensoren"] if x["id"] == sid), None)
            if s is None:
                return {"ok": False, "fehler": "Sensor nicht gefunden."}
            d["sensoren"] = [x for x in d["sensoren"] if x["id"] != sid]
            s["geloescht"] = L._iso(dt_util.now())
            d["papierkorb"].append(s)
            d["papierkorb"] = d["papierkorb"][-L.PAPIERKORB:]
        await self.async_geaendert()
        return {"ok": True, "id": sid}

    async def _dienst_inventur(self, p: dict) -> dict:
        d = self.daten
        jetzt = dt_util.now()
        zeit = p.get("zeit")
        t = L._zeit(zeit, self._tz()) if zeit else jetzt
        if t is None:
            return {"ok": False, "fehler": "Zeitpunkt nicht lesbar."}
        b: dict[str, int] = {}
        if isinstance(p.get("bestand"), dict):
            for k, v in p["bestand"].items():
                m = L._modell_norm(k)
                if m:
                    b[m] = int(v)
        if p.get("modell") is not None and p.get("anzahl") is not None and L._modell_norm(p["modell"]):
            b[L._modell_norm(p["modell"])] = int(p["anzahl"])
        if not b:
            b = {"G6": 0, "G7": 0}
        d["inventur"] = {"zeit": L._iso(t), "bestand": b, "erstellt": L._iso(jetzt)}
        await self.async_geaendert()
        return {"ok": True, "inventur": d["inventur"], "bestand": self._auswerten(jetzt)["bestand"]}

    async def _dienst_rezept(self, p: dict) -> dict:
        d = self.daten
        jetzt = dt_util.now()
        if p.get("aktion") == "termin":
            erg = L._rezept_termin(d, p.get("bis"), jetzt)
            if erg.get("ok"):
                await self.async_geaendert()
            return erg
        rz = self._auswerten(jetzt)["folgerezept"]
        if p.get("aktion") == "offen":
            d["rezept"] = None
        else:
            if not rz:
                return {"ok": False, "fehler": "Kein Folgerezept-Termin aus den Mails bekannt."}
            t = L._zeit(p.get("am"), self._tz()) if p.get("am") else jetzt
            d["rezept"] = {"verschickt_fuer": rz["bis"], "verschickt_am": L._iso(t)}
        await self.async_geaendert()
        return {"ok": True, "rezept": d["rezept"]}

    async def _dienst_einstellungen(self, p: dict) -> dict:
        neu = p.get("einstellungen") if isinstance(p.get("einstellungen"), dict) else p
        await self.async_einstellungen_setzen(neu)
        return {"ok": True, "einstellungen": self.daten["einstellungen"]}

    async def _dienst_gmail(self, p: dict) -> dict:
        erg = await self.async_gmail(p.get("neu") is True)
        try:
            await self.async_pruefen()
        except Exception as exc:  # noqa: BLE001
            _LOGGER.warning("Dexcom: Prüfung nach den Mails: %s", exc)
        return erg

    async def _dienst_pruefen(self, p: dict) -> dict:
        probelauf = p.get("probelauf") is not False
        return {"ok": True, "probelauf": probelauf, "meldungen": await self.async_pruefen(probelauf)}

    async def _dienst_test_push(self, _p: dict) -> dict:
        ok = await self._async_push("🧪 Dexcom", "Test: So sehen Dexcom-Meldungen aus. Antippen öffnet die Übersicht.", "dexcom-test")
        return {"ok": ok}

    async def _dienst_mails(self, p: dict) -> dict:
        z = self.zugang()
        if z is None:
            return {"ok": False, "fehler": "Kein Postfach eingerichtet."}
        erkennen = p.get("erkennen") is True
        liste = [u.strip() for u in str(p.get("uids") or "").split(",") if u.strip()]
        text_len = int(p.get("text_len") or 0) if not erkennen else 8000
        try:
            r = await self._ex(mail.mails_holen, z, self._mails_ab(), [], int(p.get("max_n") or 40), text_len, liste,
                               self._tz(), erkennen, str(p.get("suche") or ""))
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "fehler": "Postfach nicht erreichbar: " + str(exc)[:150]}
        return {"ok": True, "treffer": len(r["uids"]), "ordner": r["ordner"], "gmail": r["gmail"], "mails": list(r["neu"].values())}
