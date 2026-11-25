# Dexcom Sensorbestand für Home Assistant

Behält deine Dexcom-CGM-Sensoren im Blick: wie viele noch im Haus sind, wie lange der aktuelle
Sensor läuft, wann die nächste Lieferung kommt, welche Reklamation noch auf Ersatz wartet und wann
das Folgerezept fällig ist. Lieferungen, Versand, DHL-Meldungen und Support-Fälle liest die
Integration selbst aus deinem Postfach – nur lesend.

*English: Keeps track of your Dexcom CGM sensors in Home Assistant – stock, current sensor, deliveries
(read from your mailbox), complaints/replacements and prescription reminders. German user interface;
mail recognition is tuned to German Dexcom, Dexcom webshop and DHL mails.*

## Funktionen

- **Bestand** je Modell (G6, G7, G7 15 Tage, ONE+): Inventur + Lieferungen − gesetzte Sensoren,
  mit „reicht bis“.
- **Aktueller Sensor:** Tag x von 10 (bzw. 15), Restzeit, Ende inkl. Nachlaufzeit. Ein **Sensorwechsel
  wird automatisch erkannt**, wenn eine CGM-Integration das Sitzungsende liefert (z. B. Sugar Sense).
- **Etikett-Foto:** „Neuer Sensor“ öffnet die Kamera; der Data-Matrix-Code auf dem Etikett wird im
  Browser gelesen und füllt GTIN, REF, LOT, Herstell- und Verfallsdatum und Seriennummer aus. Das Foto
  bleibt 7 Tage gespeichert (einstellbar) und liegt nicht öffentlich unter `www`.
- **Lieferungen aus den Mails:** Ankündigungen (geplanter Versand, Folgerezept), Versand mit
  Versorgungszeitraum, Webshop-Bestellungen, DHL-Status (unterwegs, kommt heute mit Zeitfenster,
  verspätet, zugestellt) und Ersatzlieferungen. Alles lässt sich korrigieren oder von Hand ergänzen.
- **Transmitter (G6):** Vorrat (jede G6-Quartalslieferung bringt einen mit, jeder neue geht ab), laufender
  Transmitter mit Seriennummer, „neuer Sensor nur bis“ (mit weniger als einer Sensorlaufzeit Rest startet
  keine Sitzung mehr) und dem Sensorwechsel, bei dem ein neuer fällig ist. Liefert eine CGM-Integration das
  Transmitter-Ende (z. B. YourLoops/DBLG1), wird ein neuer Transmitter automatisch eingetragen. Hinweis, wenn
  ein gelieferter Transmitter bald aktiviert werden muss (Dexcom: innerhalb von 5 Monaten nach Versand).
  „Neuer Transmitter“ öffnet die Kamera: die Codes auf der Verpackung (oben nur die Seriennummer, unten der
  UDI-Code) füllen Seriennummer, LOT und Verfallsdatum aus; eine Transmitter-Packung im Sensor-Dialog wird
  erkannt und kann gleich als Transmitter eingetragen werden.
  Beim G7 steckt der Transmitter im Sensor – dann bleibt dieser Teil ausgeblendet.
- **Reklamationen:** Sensor oder Transmitter als reklamiert markieren, Support-Fälle aus den Mails
  (Fallnummer, Antwort „Ersatz verschickt“) zuordnen und überwachen, bis der Ersatz da ist. Ein Ersatzpaket
  für einen Transmitter zählt als Transmitter.
- **Benachrichtigungen** aufs Handy (Home-Assistant-App): Sensorwechsel fällig (mit Hinweis, wenn auch der
  Transmitter dran ist), neuer Sensor bzw. Transmitter erkannt, Transmitter wechseln bzw. keiner mehr im Vorrat,
  Lieferung überfällig bzw. Bestand knapp, Ersatz fehlt, Folgerezept fällig – mit Ruhezeit in der Nacht.
  Antippen öffnet die Übersicht.
- **Alles korrigierbar:** Sensoren (alle Etikett-Daten, gesetzt, entfernt), Lieferungen (Art, Anzahl, Modell, Versand,
  Versorgungszeitraum, Sendungsnummer, Zustellung), die angekündigte Lieferung („ist angekommen“, eigene Frist,
  ausblenden), die Antwort von Dexcom zu einem Fall, der Folgerezept-Termin, Transmitter und der Bestand (Inventur).
- **Eigene Seite in der Seitenleiste** („Dexcom“) und eine Karte für eigene Dashboards.

## Voraussetzungen

- Home Assistant 2025.1 oder neuer.
- Ein Postfach, in dem die Dexcom-Mails ankommen: Gmail (mit App-Passwort), jedes andere
  IMAP-Postfach oder eine schon eingerichtete IMAP-Integration. Ohne Postfach geht es auch –
  Lieferungen trägst du dann von Hand ein.
- Optional für die automatische Erkennung des Sensorwechsels: eine CGM-Integration mit einem
  Zeitstempel-Sensor für das Ende der Sensorsitzung, z. B.
  [Sugar Sense](https://github.com/sugarsense/ha-sugarsense) (im Marketplace).
- Optional für den G6-Transmitter: ein Zeitstempel-Sensor mit dem Transmitter-Ende und eine Entität mit der
  Transmitter-ID (Attribut `transmitter_id` oder Zustand), z. B. aus einer YourLoops/DBLG1-Anbindung.
- Optional für Benachrichtigungen: die Home-Assistant-App auf dem Handy.

## Installation

1. **Einstellungen → Marketplace → Über Link hinzufügen** und
   `https://github.com/bryce2071/dexcom_auto_inventory_management_via_mailaccount` eintragen (Typ
   *Integration*), dann **Dexcom Sensorbestand** installieren und Home Assistant neu starten.
2. **Einstellungen → Geräte & Dienste → Integration hinzufügen → Dexcom Sensorbestand**.
3. Der Einrichtungsdialog fragt alles Nötige ab:
   - **Postfach:** eine vorhandene IMAP-Integration, eigene Zugangsdaten oder ohne Postfach – dazu,
     ab welchem Datum Mails berücksichtigt werden.
   - **Zugangsdaten** (bei eigenen Zugangsdaten): Server, Port, Benutzer, Passwort, optional Ordner.
     Die Anmeldung wird sofort geprüft.
   - **Sensorwechsel und Benachrichtigungen:** den Sensorende-Sensor deiner CGM-Integration (Sugar Sense
     wird erkannt und vorausgewählt; fehlt eine passende Integration, zeigt der Dialog, wo es sie gibt),
     optional Transmitter-Ende und Transmitter-ID (G6), das Handy für Push-Meldungen und ob die Seite in der
     Seitenleiste erscheinen soll.
   - **Startbestand:** wie viele G6- und G7-Sensoren gerade im Haus sind, welches Modell neue
     Lieferungen haben und wie viele Sensoren eine Quartalslieferung enthält.
4. Fertig: In der Seitenleiste erscheint **Dexcom**.

Postfach, Sensorende, Handy, Mail-Zeitraum, Seitenleiste und das Ziel der Benachrichtigungen lassen
sich jederzeit unter **Integration → Konfigurieren** ändern. Alles Weitere (Laufzeiten je Modell,
welche Meldungen kommen, Ruhezeit, Vorlauf, Aufbewahrung der Fotos, Inventur) steht in der Karte unter
**Einstellungen**.

### Gmail: App-Passwort

Gmail lässt sich mit dem normalen Passwort nicht per IMAP lesen. Stattdessen:
Google-Konto → **Sicherheit** → *Bestätigung in zwei Schritten* einschalten → **App-Passwörter** →
neues App-Passwort anlegen (Name z. B. „Home Assistant“) und das 16-stellige Passwort im Dialog
eintragen. Server `imap.gmail.com`, Port `993`. Bei Gmail sucht die Integration automatisch in
„Alle Nachrichten“, Mails in Archiv und Labels werden also mitgefunden.

### Karte auf einem eigenen Dashboard

Die Karte wird automatisch geladen und steht in der Kartenauswahl („Dexcom-Karte“):

```yaml
type: custom:dexcom-karte
tab: sensoren   # optional: sensoren | lieferungen | reklamationen
```

Liegt die Karte auf einem eigenen Dashboard, unter *Konfigurieren* den Pfad dorthin als Ziel der
Benachrichtigungen eintragen (z. B. `/mein-dashboard/diabetes`).

## Sensoren

| Entität | Zustand | Attribute |
|---|---|---|
| `sensor.dexcom_bestand` | Sensoren im Haus | `je_modell`, `inventur_seit`, `reicht_bis`, `aktueller_sensor`, `lieferung`, `offene_reklamationen`, `folgerezept_bis`, `warnungen`, `transmitter_bestand`, `transmitter` (Seriennummer, gestartet, Ende, `neu_bis`, `wechsel_am`, Status, Tag), `version` |
| `sensor.dexcom_sensor_ende` | Ende des aktuellen Sensors (Zeitstempel) | `modell`, `gesetzt`, `status`, `tag` |
| `sensor.dexcom_lieferung` | –, angekündigt, überfällig, versendet, unterwegs, kommt heute, verzögert, abholbereit | `text`, `naechste`, `unterwegs` |

Beispiel – Erinnerung, wenn der Vorrat knapp wird:

```yaml
triggers:
  - trigger: numeric_state
    entity_id: sensor.dexcom_bestand
    below: 3
actions:
  - action: notify.mobile_app_mein_handy
    data:
      message: "Nur noch {{ states('sensor.dexcom_bestand') }} Dexcom-Sensoren im Haus."
```

## Dienste

| Dienst | Zweck |
|---|---|
| `dexcom_bestand.liste` | alle Daten für die Karte (Antwort) |
| `dexcom_bestand.sensor` | Sensor eintragen (ohne `id`) oder ändern (mit `id`) |
| `dexcom_bestand.foto` | Etikett-Foto hochladen, holen oder löschen |
| `dexcom_bestand.reklamation` | Sensor oder Transmitter reklamieren, Ersatz erhalten, abschließen, aufheben |
| `dexcom_bestand.fall` | Support-Fall aus den Mails einem Sensor oder Transmitter zuordnen, Antwort korrigieren, abschließen |
| `dexcom_bestand.lieferung` | Lieferung korrigieren oder von Hand eintragen; angekündigte Lieferung ausblenden oder Frist ändern |
| `dexcom_bestand.loeschen` | Sensor in den Papierkorb (oder zurück) |
| `dexcom_bestand.inventur` | Bestand zu einem Zeitpunkt setzen (optional auch die Transmitter) |
| `dexcom_bestand.transmitter` | G6-Transmitter eintragen, ändern, löschen oder den Vorrat zählen |
| `dexcom_bestand.rezept` | Folgerezept als verschickt markieren oder den Termin von Hand setzen |
| `dexcom_bestand.einstellungen` | Einstellungen ändern |
| `dexcom_bestand.gmail` | Postfach jetzt prüfen (sonst 07:35, 12:35 und 18:35 Uhr sowie bei neuen Mails laut IMAP-Integration) |
| `dexcom_bestand.pruefen` | fällige Benachrichtigungen anzeigen (Probelauf) oder senden |
| `dexcom_bestand.test_push` | Test-Benachrichtigung ans Handy |
| `dexcom_bestand.mails` | passende Mails im Postfach ansehen (zur Fehlersuche) |

## Datenschutz

- Mails werden **nur gelesen**: Der Ordner wird schreibgeschützt geöffnet und Mails mit `BODY.PEEK`
  abgerufen – nichts wird als gelesen markiert, verschoben oder gelöscht. Gesucht wird nur nach
  Mails von dexcom.com, dem Dexcom-Support und DHL-Mails zu Dexcom-Sendungen.
- Die Zugangsdaten liegen wie bei anderen Integrationen in der Home-Assistant-Konfiguration.
- Es gibt keinen Cloud-Dienst außer deinem eigenen Postfach.

## Daten und Sicherung

- Alles liegt in `/config/dexcom/`: `dexcom.json` (Sensoren, Inventur, Korrekturen, Einstellungen),
  `mails.json` (erkannte Mails) und `fotos/` – und ist damit in jedem Home-Assistant-Backup enthalten.
- Jede Nacht um 03:30 Uhr entsteht zusätzlich `sicherung-JJJJ-MM-TT.json` (14 Tage). Ist die
  Datendatei einmal unlesbar, wird sie als `dexcom.json.defekt-…` beiseitegelegt und die letzte
  Sicherung geladen.

## Umstieg von der Pyscript-Fassung

Wer den Sensorbestand vorher als Pyscript (`pyscript/dexcom.py`) betrieben hat:

1. `pyscript/dexcom.py` entfernen oder umbenennen (z. B. in `dexcom.py.alt`) und Pyscript neu laden –
   solange die Datei läuft, wartet die Integration.
2. Die alte Dashboard-Ressource `/local/dexcom-karte.js` entfernen (Einstellungen → Dashboards → ⋮ →
   Ressourcen); `www/dexcom-karte.js` und `www/dexcom-dm.js` werden nicht mehr gebraucht.
3. Integration hinzufügen. Sensoren, Inventur, Korrekturen, Einstellungen und Mails aus
   `/config/dexcom/` werden übernommen, die Entitäts-IDs bleiben gleich; der Schritt „Startbestand“
   entfällt.
4. Automationen, die `pyscript.dexcom_*` aufrufen, auf `dexcom_bestand.*` umstellen
   (z. B. `pyscript.dexcom_inventur` → `dexcom_bestand.inventur`).

## Hinweise

- Kein Produkt von Dexcom und kein Medizinprodukt – die Anzeige ersetzt keine Herstellerangaben und
  ist keine Grundlage für Therapieentscheidungen. Dexcom, G6 und G7 sind Marken von DexCom, Inc.
- Die Mail-Erkennung ist auf die deutschen Mails von Dexcom, dem Dexcom-Webshop und DHL abgestimmt.

## Lizenz

MIT
