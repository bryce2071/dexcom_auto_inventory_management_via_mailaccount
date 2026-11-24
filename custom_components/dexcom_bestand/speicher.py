"""Dateizugriffe des Dexcom-Sensorbestands.

Alle Funktionen sind blockierend und laufen über ``hass.async_add_executor_job``.
Verhalten wie in der früheren Pyscript-Fassung: atomares Schreiben (erst ``.tmp``, dann
umbenennen), tägliche Sicherung ``sicherung-JJJJ-MM-TT.json``, bei einer unlesbaren Datei wird
diese beiseitegelegt und die letzte Sicherung geladen. Etikett-Fotos liegen als JPEG im Unterordner
``fotos`` (nicht unter ``www``, also nicht ohne Anmeldung abrufbar).
"""

from __future__ import annotations

import base64
import json
import os
import time
from typing import Any


def datei_lesen(pfad: str) -> tuple[Any, str | None]:
    """Liest eine JSON-Datei. Liefert (daten, fehler); fehlt die Datei: (None, None)."""
    if not os.path.exists(pfad):
        return None, None
    try:
        with open(pfad, encoding="utf-8") as datei:
            return json.load(datei), None
    except Exception as exc:  # noqa: BLE001 - jede Art von defekter Datei abfangen
        return None, str(exc)


def datei_da(pfad: str) -> bool:
    return os.path.exists(pfad)


def datei_schreiben(pfad: str, text: str) -> bool:
    """Schreibt atomar: erst in eine temporäre Datei, dann umbenennen."""
    os.makedirs(os.path.dirname(pfad), exist_ok=True)
    tmp = pfad + ".tmp"
    with open(tmp, "w", encoding="utf-8") as datei:
        datei.write(text)
        datei.flush()
        os.fsync(datei.fileno())
    os.replace(tmp, pfad)
    return True


def datei_sichern(ordner: str, pfad: str, tag: str, behalten: int) -> int:
    """Legt die Tagessicherung an (einmal je Tag) und entfernt alte. Liefert die Zahl der entfernten."""
    if not os.path.exists(pfad):
        return 0
    ziel = os.path.join(ordner, "sicherung-" + tag + ".json")
    if not os.path.exists(ziel):
        with open(pfad, encoding="utf-8") as quelle, open(ziel, "w", encoding="utf-8") as kopie:
            kopie.write(quelle.read())
    alle = sorted(n for n in os.listdir(ordner) if n.startswith("sicherung-") and n.endswith(".json"))
    weg = 0
    while len(alle) > behalten:
        os.remove(os.path.join(ordner, alle.pop(0)))
        weg += 1
    return weg


def letzte_sicherung(ordner: str) -> Any:
    """Liefert den Inhalt der neuesten lesbaren Sicherung oder None."""
    if not os.path.isdir(ordner):
        return None
    alle = sorted(n for n in os.listdir(ordner) if n.startswith("sicherung-") and n.endswith(".json"))
    for name in reversed(alle):
        try:
            with open(os.path.join(ordner, name), encoding="utf-8") as datei:
                return json.load(datei)
        except Exception:  # noqa: BLE001 - defekte Sicherung überspringen
            continue
    return None


def datei_beiseite(pfad: str, zusatz: str) -> None:
    """Benennt eine unlesbare Datei um (``….defekt-<zusatz>``)."""
    if os.path.exists(pfad):
        os.replace(pfad, pfad + ".defekt-" + zusatz)


# ---------------------------------------------------------------------------
# Etikett-Fotos
# ---------------------------------------------------------------------------

def foto_schreiben(ordner: str, fid: str, b64: str, max_bytes: int) -> int:
    """Speichert ein Base64-Bild (JPEG/PNG/WebP) als <fid>.jpg. Liefert die Größe in Bytes."""
    os.makedirs(ordner, exist_ok=True)
    daten = base64.b64decode(b64)
    if len(daten) > max_bytes:
        raise ValueError("Foto zu groß (" + str(len(daten) // 1024) + " KB)")
    if not (
        daten[:3] == b"\xff\xd8\xff"
        or daten[:8] == b"\x89PNG\r\n\x1a\n"
        or (daten[:4] == b"RIFF" and daten[8:12] == b"WEBP")
    ):
        raise ValueError("Das ist kein JPEG-, PNG- oder WebP-Bild")
    pfad = os.path.join(ordner, fid + ".jpg")
    with open(pfad + ".tmp", "wb") as datei:
        datei.write(daten)
    os.replace(pfad + ".tmp", pfad)
    return len(daten)


def foto_lesen(ordner: str, fid: str) -> str | None:
    pfad = os.path.join(ordner, fid + ".jpg")
    if not os.path.exists(pfad):
        return None
    with open(pfad, "rb") as datei:
        return base64.b64encode(datei.read()).decode("ascii")


def foto_da(ordner: str, fid: str) -> bool:
    return os.path.exists(os.path.join(ordner, fid + ".jpg"))


def foto_loeschen(ordner: str, fid: str) -> bool:
    pfad = os.path.join(ordner, fid + ".jpg")
    if os.path.exists(pfad):
        os.remove(pfad)
        return True
    return False


def fotos_aufraeumen(ordner: str, tage: float) -> list[str]:
    """Löscht Fotos, die älter als „tage“ sind (nach Dateidatum). Liefert die gelöschten Foto-IDs."""
    if not os.path.isdir(ordner):
        return []
    grenze = time.time() - float(tage) * 86400
    weg = []
    for name in os.listdir(ordner):
        pfad = os.path.join(ordner, name)
        if os.path.isfile(pfad) and os.path.getmtime(pfad) < grenze:
            os.remove(pfad)
            weg.append(name.split(".")[0])
    return weg
