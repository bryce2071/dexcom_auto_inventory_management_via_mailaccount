"""Konstanten der Integration Dexcom Sensorbestand."""

from __future__ import annotations

DOMAIN = "dexcom_bestand"
NAME = "Dexcom Sensorbestand"
VERSION = "1.2.1"

# Daten: <config>/dexcom/ (wie in der früheren Pyscript-Fassung)
ORDNER = "dexcom"
DATEINAME = "dexcom.json"
MAILDATEINAME = "mails.json"
FOTOORDNER = "fotos"
FOTO_MAX = 6_000_000
SICHERUNGEN = 14

# Anzeige (gleiche Entitäts-IDs wie vorher)
SENSOR_BESTAND = "sensor.dexcom_bestand"
SENSOR_ENDE = "sensor.dexcom_sensor_ende"
SENSOR_LIEFERUNG = "sensor.dexcom_lieferung"
SIGNAL_AKTUALISIERT = f"{DOMAIN}_aktualisiert"

# Karte und Seitenleiste
STATIC_URL = "/dexcom_bestand_dateien"
KARTE_DATEI = "dexcom-karte.js"
KARTE_URL = f"{STATIC_URL}/{KARTE_DATEI}?v={VERSION}"
PANEL_PFAD = "dexcom-bestand"
PANEL_ELEMENT = "dexcom-panel"

# Einrichtung (Optionen des Eintrags)
CONF_MAIL = "mail"  # "imap:<entry_id>" | "eigen" | "keine"
MAIL_EIGEN = "eigen"
MAIL_KEINE = "keine"
CONF_SERVER = "server"
CONF_PORT = "port"
CONF_BENUTZER = "benutzer"
CONF_PASSWORT = "passwort"
CONF_ORDNER = "ordner"
CONF_MAILS_AB = "mails_ab"
CONF_SENSORENDE = "sensorende"
CONF_NOTIFY = "notify"
OPT_SEITENLEISTE = "seitenleiste"
OPT_TITEL = "titel"
OPT_LINK = "link"
STANDARD_TITEL = "Dexcom"
STANDARD_LINK = f"/{PANEL_PFAD}"
STANDARD_SERVER = "imap.gmail.com"
STANDARD_PORT = 993

# Startwerte aus der Einrichtung (nur für ein neues System ohne Daten)
CONF_ANFANG = "anfang"
CONF_BESTAND_G6 = "bestand_g6"
CONF_BESTAND_G7 = "bestand_g7"
CONF_MODELL_LIEFERUNG = "modell_lieferung"
CONF_QUARTAL_ANZAHL = "quartal_anzahl"

# Sugar Sense (liefert das Sensorende) – Hinweis im Einrichtungsdialog, falls nicht installiert
SUGARSENSE_DOMAIN = "sugarsense"
SUGARSENSE_REPO = "https://github.com/sugarsense/ha-sugarsense"

# Dienste (gleiche Felder und Antworten wie die Pyscript-Dienste dexcom_*)
DIENSTE = (
    "liste",
    "sensor",
    "foto",
    "reklamation",
    "fall",
    "lieferung",
    "loeschen",
    "inventur",
    "rezept",
    "einstellungen",
    "gmail",
    "pruefen",
    "test_push",
    "mails",
)

# Uhrzeiten
UHR_SICHERUNG = "03:30"
MAIL_ZEITEN = ("07:35", "12:35", "18:35")
START_VERZOEGERUNG = 60  # Sekunden nach dem Start, bis Mails und Sensorende geprüft werden
