# OSINT Workbench Mobile

Native Android companion for OSINT Workbench. This first mobile release focuses on
local phone-number parsing, transparent manual search-link generation, and a local
SQLite case notebook. It is a companion MVP, not feature parity with the Windows desktop
client; mobile cases are stored locally and do not sync with Windows yet.

## Included

- International phone parsing and validation using Google's libphonenumber metadata.
- E.164, international and national formats, numbering region, calling code and line type.
- Manually opened Google query links; no search is run by the app.
- Local case storage, case review, deletion and Android share-sheet export.
- Russian interface and dark OSINT Workbench palette.

## Privacy boundary

- The Android manifest intentionally declares **no INTERNET permission**.
- No contacts, call logs, SMS, location or account permissions are requested.
- Parsing and case storage happen on the device.
- A search query is disclosed only after the user taps a generated link and the external
  browser opens it. Search results are not fetched or interpreted by the app.
- Numbering region and line type are not treated as subscriber identity, carrier ownership
  or physical location.

## Build

Requirements: Android SDK Platform 36, Android Build Tools 36.0.0, Android Studio JBR,
and network access for Gradle/Maven dependencies on the first build.

Run from Windows:

    build-apk.bat

Or:

    gradlew.bat assembleDebug

Output:

    app/build/outputs/apk/debug/app-debug.apk

The debug APK is signed with the local Android debug key and is suitable for sideloading
and testing. A production Play Store or public release needs a dedicated signing key.
