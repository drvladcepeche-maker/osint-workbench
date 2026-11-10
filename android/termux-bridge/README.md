# Termux bridge

The APK queues technical errors locally. When this bridge is running, it sends reports to Termux; GitHub CLI creates Issues in drvladcepeche-maker/osint-workbench. The app can also request the list of open Issues.

One-time Termux setup:
    pkg update
    pkg install python gh
    gh auth login
Authenticate as drvladcepeche-maker. Then copy bridge.py to ~/osint-workbench-bridge/bridge.py and run:
    mkdir -p ~/osint-workbench-bridge
    cd ~/osint-workbench-bridge
    python bridge.py

Keep the process running. The server binds only to 127.0.0.1 and is not exposed to Wi-Fi or the Internet. Shizuku is not required for the basic loopback bridge; it may be used separately to keep Termux alive. The APK does not silently execute shell commands or request Shizuku privileges.

Only technical exception metadata is sent: app version, Android version, device model, event, stack trace and timestamp. Phone numbers, case notes, SQLite records, contacts and search queries are never included. Reports remain queued if Termux is unavailable and are retried on app launch or a new diagnostic event.
