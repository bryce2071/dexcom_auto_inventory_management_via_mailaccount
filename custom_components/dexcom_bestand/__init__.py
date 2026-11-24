"""Dexcom Sensorbestand – Bestand, Lieferungen und Reklamationen von Dexcom-CGM-Sensoren.

Aufbau
- Daten: <config>/dexcom/dexcom.json (Sensoren, Lieferungs-Korrekturen, Inventur, Rezept,
  Einstellungen, gesendete Meldungen, Papierkorb), Mail-Zwischenspeicher mails.json,
  Etikett-Fotos im Unterordner fotos, tägliche Sicherung sicherung-JJJJ-MM-TT.json (14 Tage).
- Mails: liest Ankündigungen, Versand, Webshop, DHL und Support-Fälle selbst aus dem Postfach
  (eigene IMAP-Zugangsdaten oder die einer IMAP-Integration), nur lesend.
- Sensorwechsel: optional über den Sensorende-Sensor einer CGM-Integration (z. B. Sugar Sense).
- Anzeige: sensor.dexcom_bestand, sensor.dexcom_sensor_ende, sensor.dexcom_lieferung.
- Karte: custom:dexcom-karte (wird automatisch geladen), optional eigener Eintrag in der Seitenleiste.
- Dienste: dexcom_bestand.liste, sensor, foto, reklamation, fall, lieferung, loeschen, inventur,
  rezept, einstellungen, gmail, pruefen, test_push, mails.
"""

from __future__ import annotations

import logging
from pathlib import Path

import voluptuous as vol

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import ConfigEntryNotReady, ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import (
    DIENSTE,
    DOMAIN,
    KARTE_URL,
    OPT_SEITENLEISTE,
    OPT_TITEL,
    PANEL_ELEMENT,
    PANEL_PFAD,
    STANDARD_TITEL,
    STATIC_URL,
)
from .kern import DexcomKern

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.SENSOR]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

# Die Karte schickt ganze Objekte; geprüft wird in der Logik selbst.
_DIENST_SCHEMA = vol.Schema({}, extra=vol.ALLOW_EXTRA)

type DexcomConfigEntry = ConfigEntry[DexcomKern]


def pyscript_fassung_aktiv(hass: HomeAssistant) -> bool:
    """True, solange die frühere Pyscript-Fassung (pyscript/dexcom.py) läuft."""
    return hass.services.has_service("pyscript", "dexcom_liste")


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Dienste einmalig anmelden (sie greifen auf den geladenen Eintrag zu)."""

    async def _ausfuehren(call: ServiceCall) -> ServiceResponse:
        kern: DexcomKern | None = None
        for eintrag in hass.config_entries.async_entries(DOMAIN):
            if eintrag.state is ConfigEntryState.LOADED:
                kern = eintrag.runtime_data
        if kern is None:
            raise ServiceValidationError("Dexcom Sensorbestand ist nicht eingerichtet oder noch nicht geladen.")
        return await kern.async_dienst(call.service, dict(call.data))

    for name in DIENSTE:
        hass.services.async_register(
            DOMAIN,
            name,
            _ausfuehren,
            schema=_DIENST_SCHEMA,
            supports_response=SupportsResponse.ONLY if name in ("liste", "mails") else SupportsResponse.OPTIONAL,
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: DexcomConfigEntry) -> bool:
    """Daten laden, Karte bereitstellen, Sensoren anlegen."""
    if pyscript_fassung_aktiv(hass):
        raise ConfigEntryNotReady("Die Pyscript-Fassung (pyscript/dexcom.py) läuft noch – bitte zuerst entfernen.")
    kern = DexcomKern(hass, entry)
    await kern.async_start()
    entry.runtime_data = kern
    # Zeitplan und Auslöser wieder abmelden – beim Entladen und falls der Start unten scheitert
    entry.async_on_unload(kern.async_stop)
    entry.async_on_unload(lambda: _frontend_abmelden(hass))
    await _frontend_anmelden(hass, entry)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_optionen_geaendert))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: DexcomConfigEntry) -> bool:
    """Entladen (z. B. nach geänderten Optionen)."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _optionen_geaendert(hass: HomeAssistant, entry: DexcomConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def _frontend_anmelden(hass: HomeAssistant, entry: DexcomConfigEntry) -> None:
    """Karte ausliefern, auf allen Dashboards laden und optional die Seitenleiste ergänzen."""
    merker = hass.data.setdefault(DOMAIN, {})
    if not merker.get("statisch"):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(Path(__file__).parent / "frontend"), True)]
        )
        merker["statisch"] = True
    frontend.add_extra_js_url(hass, KARTE_URL)
    merker["karte"] = True
    if entry.options.get(OPT_SEITENLEISTE, True):
        await panel_custom.async_register_panel(
            hass,
            frontend_url_path=PANEL_PFAD,
            webcomponent_name=PANEL_ELEMENT,
            sidebar_title=entry.options.get(OPT_TITEL) or STANDARD_TITEL,
            sidebar_icon="mdi:needle",
            module_url=KARTE_URL,
            embed_iframe=False,
            require_admin=False,
        )
        merker["panel"] = True


def _frontend_abmelden(hass: HomeAssistant) -> None:
    merker = hass.data.setdefault(DOMAIN, {})
    if merker.pop("panel", False):
        frontend.async_remove_panel(hass, PANEL_PFAD)
    if merker.pop("karte", False):
        frontend.remove_extra_js_url(hass, KARTE_URL)
