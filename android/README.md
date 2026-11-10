# OSINT Workbench Mobile

Native Android companion for OSINT Workbench. Version 0.2.0 adds local diagnostic capture and a Termux loopback bridge to GitHub Issues.

## Included

- International phone parsing and validation using Google's libphonenumber metadata.
- E.164, international and national formats, numbering region, calling code and line type.
- Manually opened Google query links; no search is run by the app.
- Local case storage, case review, deletion and Android share-sheet export.
- Unhandled exception capture with Android/app/device context and stack trace.
- Persistent local diagnostic queue; failed delivery is retained and retried on app launch.
- Termux bridge for sending reports to GitHub Issues and retrieving open issue lists.

## Privacy boundary

- INTERNET permission is used only for the loopback Termux bridge at 127.0.0.1.
- Cleartext HTTP is allowed only for 127.0.0.1; other network destinations require HTTPS.
- Diagnostic reports contain technical exception metadata only. Phone numbers, case notes, SQLite records, contacts and search queries are excluded.
- Case data remains in the app's local SQLite database and is not synchronized.
- No contacts, call logs, SMS, location or account permissions are requested.
- Search queries are disclosed only after the user taps a generated link and the external browser opens it.

## Termux bridge

See termux-bridge/README.md. Termux requires Python and GitHub CLI authenticated to drvladcepeche-maker. The bridge binds only to loopback and creates GitHub Issues for incoming technical reports. Shizuku is not required for the basic bridge; it can be used separately for local process management.

## Updates

The package ID and debug signing certificate are kept stable for test updates. VersionCode is incremented so the APK can be installed over the previous test APK without deleting its local data. Keep the same signing key for future test builds.

## Build

Requirements: Android SDK Platform 36, Android Build Tools 36.0.0, Android Studio JBR, and network access for Gradle/Maven dependencies on the first build.

Run from Windows:

    build-apk.bat

Output:

    ../release/OSINT-Workbench-Mobile-0.2.0.apk

The APK is debug-signed and suitable for sideload testing. A production Play Store release needs a dedicated signing key.
