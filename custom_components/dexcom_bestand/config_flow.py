"""Einrichtung und Optionen des Dexcom-Sensorbestands.

Schritte der Einrichtung
1. Postfach: eine vorhandene IMAP-Integration, eigene Zugangsdaten (Anmeldung wird geprüft) oder keins.
2. Sensoren und Handy: Sensorende-Sensor einer CGM-Integration (Sugar Sense wird erkannt; fehlt eine
   passende Integration, zeigt der Dialog, wo es sie gibt), Benachrichtigungsdienst, Seitenleiste.
3. Startbestand – nur ohne vorhandene Daten (sonst werden <config>/dexcom/… übernommen).
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigEntryState, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.selector import (
    BooleanSelector,
    DateSelector,
    EntitySelector,
    EntitySelectorConfig,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)
from homeassistant.util import dt as dt_util

from . import mail, speicher
from .const import (
    CONF_ANFANG,
    CONF_BENUTZER,
    CONF_BESTAND_G6,
    CONF_BESTAND_G7,
    CONF_MAIL,
    CONF_MAILS_AB,
    CONF_MODELL_LIEFERUNG,
    CONF_NOTIFY,
    CONF_ORDNER,
    CONF_PASSWORT,
    CONF_PORT,
    CONF_QUARTAL_ANZAHL,
    CONF_SENSORENDE,
    CONF_SERVER,
    DATEINAME,
    DOMAIN,
    MAIL_EIGEN,
    MAIL_KEINE,
    NAME,
    OPT_LINK,
    OPT_SEITENLEISTE,
    OPT_TITEL,
    ORDNER,
    STANDARD_LINK,
    STANDARD_PORT,
    STANDARD_SERVER,
    STANDARD_TITEL,
    SUGARSENSE_DOMAIN,
    SUGARSENSE_REPO,
)

MODELLE = ["G6", "G7", "G7 15 Tage", "ONE+"]
ZUGANG_FELDER = (CONF_SERVER, CONF_PORT, CONF_BENUTZER, CONF_PASSWORT, CONF_ORDNER)


# ---------------------------------------------------------------------------
# Hilfen (gemeinsam für Einrichtung und Optionen)
# ---------------------------------------------------------------------------

def _pyscript_aktiv(hass: HomeAssistant) -> bool:
    return hass.services.has_service("pyscript", "dexcom_liste")


def _imap_eintraege(hass: HomeAssistant) -> list[ConfigEntry]:
    return list(hass.config_entries.async_entries("imap"))


def _mail_optionen(hass: HomeAssistant) -> list[SelectOptionDict]:
    optionen = [
        SelectOptionDict(value="imap:" + e.entry_id, label="IMAP-Integration: " + (e.title or e.data.get("username") or e.entry_id))
        for e in _imap_eintraege(hass)
    ]
    optionen.append(SelectOptionDict(value=MAIL_EIGEN, label="Eigene Zugangsdaten eingeben"))
    optionen.append(SelectOptionDict(value=MAIL_KEINE, label="Ohne Postfach (Lieferungen von Hand eintragen)"))
    return optionen


def _mail_standard(hass: HomeAssistant) -> str:
    eintraege = _imap_eintraege(hass)
    for e in eintraege:
        if "gmail" in str(e.data.get("server", "")).lower():
            return "imap:" + e.entry_id
    return "imap:" + eintraege[0].entry_id if eintraege else MAIL_EIGEN


def _zugang_aus_imap(hass: HomeAssistant, wert: str) -> dict | None:
    eintrag = hass.config_entries.async_get_entry(wert.split(":", 1)[1]) if wert.startswith("imap:") else None
    if eintrag is None:
        return None
    d = eintrag.data
    return {"server": d.get("server"), "port": int(d.get("port") or STANDARD_PORT), "benutzer": d.get("username"),
            "passwort": d.get("password"), "ordner": ""}


async def _zugang_testen(hass: HomeAssistant, zugang: dict) -> str | None:
    """Meldet sich am Postfach an. Liefert None oder den Fehlerschlüssel."""
    try:
        await hass.async_add_executor_job(mail.zugang_pruefen, zugang)
    except mail.AnmeldungFehler:
        return "anmeldung"
    except mail.VerbindungFehler:
        return "verbindung"
    except Exception:  # noqa: BLE001
        return "verbindung"
    return None


def _sensorende_vorschlag(hass: HomeAssistant) -> str | None:
    """Sensorende-Sensor von Sugar Sense, falls vorhanden."""
    reg = er.async_get(hass)
    for e in reg.entities.values():
        if e.platform == SUGARSENSE_DOMAIN and str(e.unique_id).endswith("_sensor_end") and not e.disabled_by:
            return e.entity_id
    return None


def _zeitstempel_sensoren_da(hass: HomeAssistant) -> bool:
    return any(
        s.entity_id.startswith("sensor.") and s.attributes.get("device_class") == "timestamp"
        and not s.entity_id.startswith("sensor.dexcom_")
        for s in hass.states.async_all("sensor")
    )


def _notify_dienste(hass: HomeAssistant) -> list[str]:
    dienste = sorted((hass.services.async_services().get("notify") or {}).keys())
    vorn = [d for d in dienste if d.startswith("mobile_app_")]
    rest = [d for d in dienste if not d.startswith("mobile_app_") and d not in ("notify", "send_message", "persistent_notification")]
    return vorn + rest


def _cgm_hinweis(hass: HomeAssistant) -> str:
    if _sensorende_vorschlag(hass):
        return "Gefunden: Sensorende von Sugar Sense – schon vorausgewählt."
    if _zeitstempel_sensoren_da(hass):
        return ("Wähle den Sensor, der das Ende der aktuellen Sensorsitzung als Zeitstempel liefert. Gibt es keinen, "
                "einfach leer lassen.")
    return (
        "**Keine passende CGM-Integration gefunden.** Für die automatische Erkennung des Sensorwechsels eignet sich "
        f"[Sugar Sense]({SUGARSENSE_REPO}) – installieren unter *Einstellungen → Marketplace* (Suche „Sugar Sense“), "
        "einrichten und danach hier unter *Konfigurieren* auswählen. Ohne sie das Feld leer lassen: Sensoren trägst du "
        "dann per Etikett-Foto oder von Hand ein."
    )


def _notify_hinweis(hass: HomeAssistant) -> str:
    if any(d.startswith("mobile_app_") for d in _notify_dienste(hass)):
        return ""
    return (" Für Push-Meldungen braucht es die Home-Assistant-App auf dem Handy (Companion-App); danach erscheint "
            "das Handy hier als mobile_app_…")


def _sensoren_schema(hass: HomeAssistant, werte: dict) -> vol.Schema:
    dienste = _notify_dienste(hass)
    return vol.Schema(
        {
            vol.Optional(CONF_SENSORENDE, description={"suggested_value": werte.get(CONF_SENSORENDE)}): EntitySelector(
                EntitySelectorConfig(domain="sensor", device_class="timestamp")
            ),
            vol.Optional(CONF_NOTIFY, description={"suggested_value": werte.get(CONF_NOTIFY)}): SelectSelector(
                SelectSelectorConfig(options=dienste, custom_value=True, mode=SelectSelectorMode.DROPDOWN)
            ),
            vol.Required(OPT_SEITENLEISTE, default=werte.get(OPT_SEITENLEISTE, True)): BooleanSelector(),
            vol.Required(OPT_TITEL, default=werte.get(OPT_TITEL) or STANDARD_TITEL): TextSelector(),
        }
    )


def _zugang_schema(werte: dict, passwort_noetig: bool) -> vol.Schema:
    pw = vol.Required(CONF_PASSWORT) if passwort_noetig else vol.Optional(CONF_PASSWORT)
    return vol.Schema(
        {
            vol.Required(CONF_SERVER, default=werte.get(CONF_SERVER) or STANDARD_SERVER): TextSelector(),
            vol.Required(CONF_PORT, default=int(werte.get(CONF_PORT) or STANDARD_PORT)): NumberSelector(
                NumberSelectorConfig(min=1, max=65535, mode=NumberSelectorMode.BOX)
            ),
            vol.Required(CONF_BENUTZER, description={"suggested_value": werte.get(CONF_BENUTZER) or None}): TextSelector(
                TextSelectorConfig(type=TextSelectorType.EMAIL)
            ),
            pw: TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD)),
            vol.Optional(CONF_ORDNER, description={"suggested_value": werte.get(CONF_ORDNER) or ""}): TextSelector(),
        }
    )


def _zugang_aus_eingabe(werte: dict) -> dict:
    return {"server": str(werte.get(CONF_SERVER) or "").strip(), "port": int(werte.get(CONF_PORT) or STANDARD_PORT),
            "benutzer": str(werte.get(CONF_BENUTZER) or "").strip(), "passwort": str(werte.get(CONF_PASSWORT) or ""),
            "ordner": str(werte.get(CONF_ORDNER) or "").strip()}


def _optionen_sauber(werte: dict) -> dict:
    """Optionen des Eintrags (Postfach, Sensorende, Seitenleiste, Link)."""
    link = str(werte.get(OPT_LINK) or "").strip() or STANDARD_LINK
    if not link.startswith("/"):
        link = "/" + link
    aus = {
        CONF_MAIL: werte.get(CONF_MAIL) or MAIL_KEINE,
        CONF_SENSORENDE: werte.get(CONF_SENSORENDE) or "",
        OPT_SEITENLEISTE: bool(werte.get(OPT_SEITENLEISTE, True)),
        OPT_TITEL: str(werte.get(OPT_TITEL) or "").strip() or STANDARD_TITEL,
        OPT_LINK: link,
    }
    if aus[CONF_MAIL] == MAIL_EIGEN:
        z = _zugang_aus_eingabe(werte)
        aus.update({CONF_SERVER: z["server"], CONF_PORT: z["port"], CONF_BENUTZER: z["benutzer"],
                    CONF_PASSWORT: z["passwort"], CONF_ORDNER: z["ordner"]})
    return aus


async def _vorhandene_daten(hass: HomeAssistant) -> dict | None:
    daten, _fehler = await hass.async_add_executor_job(speicher.datei_lesen, hass.config.path(ORDNER, DATEINAME))
    return daten if isinstance(daten, dict) else None


# ---------------------------------------------------------------------------
# Einrichtung
# ---------------------------------------------------------------------------

class DexcomConfigFlow(ConfigFlow, domain=DOMAIN):
    """Einrichtung in bis zu vier Schritten: Postfach, Zugangsdaten, Sensoren/Handy, Startbestand."""

    VERSION = 1

    def __init__(self) -> None:
        self._werte: dict[str, Any] = {}
        self._daten_da = False

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        fehler: dict[str, str] = {}
        if _pyscript_aktiv(self.hass):
            fehler["base"] = "pyscript_aktiv"
        elif user_input is not None:
            self._werte.update(user_input)
            quelle = user_input[CONF_MAIL]
            if quelle == MAIL_EIGEN:
                return await self.async_step_zugang()
            if quelle.startswith("imap:"):
                zugang = _zugang_aus_imap(self.hass, quelle)
                f = await _zugang_testen(self.hass, zugang) if zugang else "verbindung"
                if f is None:
                    return await self.async_step_sensoren()
                fehler["base"] = f
            else:
                return await self.async_step_sensoren()
        bisher = await _vorhandene_daten(self.hass)
        self._daten_da = bool(bisher and bisher.get("inventur"))
        ab = ((bisher or {}).get("einstellungen") or {}).get("gmail_ab") or (dt_util.now().date() - timedelta(days=365)).isoformat()
        schema = vol.Schema(
            {
                vol.Required(CONF_MAIL, default=self._werte.get(CONF_MAIL) or _mail_standard(self.hass)): SelectSelector(
                    SelectSelectorConfig(options=_mail_optionen(self.hass), mode=SelectSelectorMode.LIST)
                ),
                vol.Required(CONF_MAILS_AB, default=self._werte.get(CONF_MAILS_AB) or ab): DateSelector(),
            }
        )
        return self.async_show_form(
            step_id="user",
            data_schema=schema,
            errors=fehler,
            description_placeholders={
                "daten": "Vorhandene Daten in /config/dexcom werden übernommen." if self._daten_da else "",
            },
        )

    async def async_step_zugang(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        fehler: dict[str, str] = {}
        if user_input is not None:
            f = await _zugang_testen(self.hass, _zugang_aus_eingabe(user_input))
            if f is None:
                self._werte.update(user_input)
                return await self.async_step_sensoren()
            fehler["base"] = f
        return self.async_show_form(
            step_id="zugang", data_schema=_zugang_schema(user_input or self._werte, True), errors=fehler
        )

    async def async_step_sensoren(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            self._werte.update(user_input)
            if self._daten_da:
                return self._anlegen()
            return await self.async_step_bestand()
        werte = {CONF_SENSORENDE: _sensorende_vorschlag(self.hass), OPT_SEITENLEISTE: True, OPT_TITEL: STANDARD_TITEL}
        bisher = await _vorhandene_daten(self.hass)
        notify = ((bisher or {}).get("einstellungen") or {}).get("notify")
        dienste = _notify_dienste(self.hass)
        werte[CONF_NOTIFY] = notify or next((d for d in dienste if d.startswith("mobile_app_")), None)
        werte.update({k: v for k, v in self._werte.items() if k in (CONF_SENSORENDE, CONF_NOTIFY, OPT_SEITENLEISTE, OPT_TITEL)})
        return self.async_show_form(
            step_id="sensoren",
            data_schema=_sensoren_schema(self.hass, werte),
            description_placeholders={"cgm_hinweis": _cgm_hinweis(self.hass), "notify_hinweis": _notify_hinweis(self.hass)},
        )

    async def async_step_bestand(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            self._werte.update(user_input)
            return self._anlegen()
        schema = vol.Schema(
            {
                vol.Required(CONF_BESTAND_G6, default=0): NumberSelector(NumberSelectorConfig(min=0, max=100, mode=NumberSelectorMode.BOX)),
                vol.Required(CONF_BESTAND_G7, default=0): NumberSelector(NumberSelectorConfig(min=0, max=100, mode=NumberSelectorMode.BOX)),
                vol.Required(CONF_MODELL_LIEFERUNG, default="G7"): SelectSelector(
                    SelectSelectorConfig(options=MODELLE, mode=SelectSelectorMode.DROPDOWN)
                ),
                vol.Required(CONF_QUARTAL_ANZAHL, default=9): NumberSelector(NumberSelectorConfig(min=0, max=60, mode=NumberSelectorMode.BOX)),
            }
        )
        return self.async_show_form(step_id="bestand", data_schema=schema)

    def _anlegen(self) -> ConfigFlowResult:
        w = self._werte
        anfang: dict[str, Any] = {
            "zeit": dt_util.now().isoformat(timespec="seconds"),
            "notify": str(w.get(CONF_NOTIFY) or "").replace("notify.", "").strip(),
            "gmail_ab": w.get(CONF_MAILS_AB) or "",
        }
        if not self._daten_da:
            anfang.update({
                "bestand": {"G6": int(w.get(CONF_BESTAND_G6) or 0), "G7": int(w.get(CONF_BESTAND_G7) or 0)},
                "modell_lieferung": w.get(CONF_MODELL_LIEFERUNG) or "G7",
                "quartal_anzahl": int(w.get(CONF_QUARTAL_ANZAHL) or 9),
            })
        return self.async_create_entry(title=NAME, data={CONF_ANFANG: anfang}, options=_optionen_sauber(w))

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return DexcomOptionsFlow()


# ---------------------------------------------------------------------------
# Optionen (Integration → Konfigurieren)
# ---------------------------------------------------------------------------

class DexcomOptionsFlow(OptionsFlow):
    """Postfach, Sensorende, Handy, Mail-Zeitraum, Seitenleiste und Ziel der Benachrichtigungen ändern."""

    def __init__(self) -> None:
        self._werte: dict[str, Any] = {}

    def _kern(self):
        e = self.config_entry
        return e.runtime_data if e.state is ConfigEntryState.LOADED else None

    def _aktuell(self) -> dict[str, Any]:
        werte = dict(self.config_entry.options)
        kern = self._kern()
        einst = kern.daten["einstellungen"] if kern else {}
        werte.setdefault(CONF_NOTIFY, einst.get("notify") or "")
        werte.setdefault(CONF_MAILS_AB, einst.get("gmail_ab") or "")
        return werte

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        fehler: dict[str, str] = {}
        aktuell = self._aktuell()
        if user_input is not None:
            # Geleerte Felder (Sensorende, Handy) kommen nicht mit – dann bewusst leer statt alter Wert
            self._werte = {**aktuell, CONF_SENSORENDE: "", CONF_NOTIFY: "", CONF_MAILS_AB: "", **user_input}
            quelle = user_input[CONF_MAIL]
            if quelle == MAIL_EIGEN:
                return await self.async_step_zugang()
            if quelle.startswith("imap:"):
                zugang = _zugang_aus_imap(self.hass, quelle)
                f = await _zugang_testen(self.hass, zugang) if zugang else "verbindung"
                if f is None:
                    return await self._fertig()
                fehler["base"] = f
            else:
                return await self._fertig()
        werte = {**aktuell, **(user_input or {})}
        mail_wert = werte.get(CONF_MAIL) or MAIL_KEINE
        if mail_wert.startswith("imap:") and _zugang_aus_imap(self.hass, mail_wert) is None:
            mail_wert = _mail_standard(self.hass)
        schema = vol.Schema(
            {
                vol.Required(CONF_MAIL, default=mail_wert): SelectSelector(
                    SelectSelectorConfig(options=_mail_optionen(self.hass), mode=SelectSelectorMode.LIST)
                ),
                vol.Optional(CONF_MAILS_AB, description={"suggested_value": werte.get(CONF_MAILS_AB) or None}): DateSelector(),
                **_sensoren_schema(self.hass, werte).schema,
                vol.Required(OPT_LINK, default=werte.get(OPT_LINK) or STANDARD_LINK): TextSelector(),
            }
        )
        return self.async_show_form(
            step_id="init",
            data_schema=schema,
            errors=fehler,
            description_placeholders={"cgm_hinweis": _cgm_hinweis(self.hass), "notify_hinweis": _notify_hinweis(self.hass)},
        )

    async def async_step_zugang(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        fehler: dict[str, str] = {}
        if user_input is not None:
            eingabe = dict(user_input)
            if not eingabe.get(CONF_PASSWORT):
                eingabe[CONF_PASSWORT] = self.config_entry.options.get(CONF_PASSWORT) or ""
            f = await _zugang_testen(self.hass, _zugang_aus_eingabe(eingabe))
            if f is None:
                self._werte.update(eingabe)
                return await self._fertig()
            fehler["base"] = f
        werte = {**self._werte, **(user_input or {})}
        werte.pop(CONF_PASSWORT, None)
        return self.async_show_form(
            step_id="zugang", data_schema=_zugang_schema(werte, not self.config_entry.options.get(CONF_PASSWORT)), errors=fehler
        )

    async def _fertig(self) -> ConfigFlowResult:
        w = self._werte
        kern = self._kern()
        if kern is not None:
            neu = {"notify": str(w.get(CONF_NOTIFY) or "").replace("notify.", "").strip()}
            if w.get(CONF_MAILS_AB):
                neu["gmail_ab"] = w[CONF_MAILS_AB]
            await kern.async_einstellungen_setzen(neu)
        return self.async_create_entry(data=_optionen_sauber(w))
