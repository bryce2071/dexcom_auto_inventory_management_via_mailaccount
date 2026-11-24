"""Sensoren des Dexcom-Sensorbestands (gleiche Entitäts-IDs wie die frühere Pyscript-Fassung).

- ``sensor.dexcom_bestand``: Sensoren im Haus; Attribut ``version`` zählt jede Änderung hoch
  (daran erkennt die Karte, dass sie neu laden muss), dazu Bestand je Modell, Reichweite,
  aktueller Sensor, Lieferstatus, offene Reklamationen, Folgerezept und Hinweise.
- ``sensor.dexcom_sensor_ende``: Ende des aktuellen Sensors (Zeitstempel).
- ``sensor.dexcom_lieferung``: nächste Lieferung (–, angekündigt, überfällig, versendet, unterwegs, kommt heute …).
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DOMAIN, NAME, SENSOR_BESTAND, SENSOR_ENDE, SENSOR_LIEFERUNG, SIGNAL_AKTUALISIERT, VERSION
from .kern import DexcomKern


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    kern: DexcomKern = entry.runtime_data
    reg = er.async_get(hass)
    for entity_id in (SENSOR_BESTAND, SENSOR_ENDE, SENSOR_LIEFERUNG):
        # Zustände der früheren Pyscript-Fassung haben keinen Registry-Eintrag. Ohne Aufräumen
        # bekäme die neue Entität sonst eine andere ID (…_2).
        if reg.async_get(entity_id) is None and hass.states.get(entity_id) is not None:
            hass.states.async_remove(entity_id)
    async_add_entities([BestandSensor(kern, entry), EndeSensor(kern, entry), LieferungSensor(kern, entry)])


class _Basis(SensorEntity):
    """Gemeinsame Grundlage: kein Abfragen, Aktualisierung über das Signal des Kerns."""

    _attr_should_poll = False
    _attr_has_entity_name = False

    def __init__(self, kern: DexcomKern, entry: ConfigEntry, entity_id: str, schluessel: str) -> None:
        self._kern = kern
        self.entity_id = entity_id
        self._attr_unique_id = f"{entry.entry_id}_{schluessel}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=NAME,
            manufacturer=NAME,
            model="Sensorbestand",
            entry_type=DeviceEntryType.SERVICE,
            sw_version=VERSION,
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL_AKTUALISIERT, self._aktualisiert))

    @callback
    def _aktualisiert(self) -> None:
        self.async_write_ha_state()


class BestandSensor(_Basis):
    """Sensoren im Haus (Inventur + Lieferungen − gesetzte Sensoren)."""

    _attr_name = "Dexcom Bestand"
    _attr_icon = "mdi:package-variant"
    _attr_native_unit_of_measurement = "Sensoren"
    _unrecorded_attributes = frozenset({"version", "aktueller_sensor", "warnungen"})

    def __init__(self, kern: DexcomKern, entry: ConfigEntry) -> None:
        super().__init__(kern, entry, SENSOR_BESTAND, "bestand")

    @property
    def native_value(self) -> int | None:
        return self._kern.anzeige.get("bestand")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return dict(self._kern.anzeige.get("bestand_attr") or {})


class EndeSensor(_Basis):
    """Ende des aktuellen Sensors."""

    _attr_name = "Dexcom Sensorende"
    _attr_icon = "mdi:timer-sand"
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(self, kern: DexcomKern, entry: ConfigEntry) -> None:
        super().__init__(kern, entry, SENSOR_ENDE, "sensor_ende")

    @property
    def native_value(self):
        wert = self._kern.anzeige.get("ende")
        return dt_util.parse_datetime(wert) if wert else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return dict(self._kern.anzeige.get("ende_attr") or {})


class LieferungSensor(_Basis):
    """Nächste Lieferung."""

    _attr_name = "Dexcom Lieferung"
    _attr_icon = "mdi:truck-delivery-outline"
    _unrecorded_attributes = frozenset({"naechste", "unterwegs"})

    def __init__(self, kern: DexcomKern, entry: ConfigEntry) -> None:
        super().__init__(kern, entry, SENSOR_LIEFERUNG, "lieferung")

    @property
    def native_value(self) -> str | None:
        return self._kern.anzeige.get("lieferung")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return dict(self._kern.anzeige.get("lieferung_attr") or {})
