@echo off
setlocal
set "ROOT=%~dp0"
set "JAVA_HOME=%ProgramFiles%\Android\Android Studio\jbr"
set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%PATH%"
if not exist "%JAVA_HOME%\bin\java.exe" (
  echo Android Studio JBR not found: "%JAVA_HOME%"
  exit /b 2
)
if not exist "%ANDROID_HOME%\platforms\android-36\android.jar" (
  echo Android SDK Platform 36 not found: "%ANDROID_HOME%"
  exit /b 3
)
cd /d "%ROOT%"
call gradlew.bat assembleDebug > "%ROOT%build-apk.log" 2>&1
if errorlevel 1 (
  type "%ROOT%build-apk.log"
  exit /b 1
)
if not exist "%ROOT%..\release" mkdir "%ROOT%..\release"
copy /y "app\build\outputs\apk\debug\app-debug.apk" "%ROOT%..\release\OSINT-Workbench-Mobile-0.1.0.apk" >nul
if errorlevel 1 exit /b 4
echo APK ready: "%ROOT%..\release\OSINT-Workbench-Mobile-0.1.0.apk"
for %%I in ("%ROOT%..\release\OSINT-Workbench-Mobile-0.1.0.apk") do echo Size: %%~zI bytes
endlocal
