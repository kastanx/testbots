@echo off
rem Double-click this. Routes the tablet's internet through this PC's connection
rem over the USB cable, so the tablet's own wifi is out of the path entirely.
rem
rem Leave this window OPEN for the whole session - closing it cuts the tablet's
rem internet (its wifi is meant to be off).

setlocal
title greenbot - USB tether

rem gnirehtet must run from its own folder: `run` looks for gnirehtet.apk in the
rem working directory when it needs to install the client.
set "GN=%USERPROFILE%\Downloads\gnirehtet-rust-win64-v2.5.1\gnirehtet-rust-win64"

if not exist "%GN%\gnirehtet.exe" (
    echo gnirehtet not found at:
    echo   %GN%
    echo.
    echo Download gnirehtet-rust-win64 from
    echo   https://github.com/Genymobile/gnirehtet/releases
    echo and extract it into your Downloads folder.
    pause
    exit /b 1
)

rem A relay left over from a previous run holds port 31416 and the next start
rem dies with a bare winsock 10048, which says nothing useful.
netstat -ano | findstr /r /c:"LISTENING" | findstr ":31416" >nul
if not errorlevel 1 (
    echo Port 31416 is already in use - a relay is still running.
    echo Close that window first, or run:  taskkill /f /im gnirehtet.exe
    echo.
    pause
    exit /b 1
)

pushd "%GN%"

echo Checking for a connected device ...
adb devices -l | findstr /r /c:"device$" /c:"device " >nul
if errorlevel 1 (
    echo.
    echo No authorised device. Plug the tablet in over USB, unlock it, and
    echo accept the debugging prompt. Then run this again.
    popd
    pause
    exit /b 1
)

echo.
echo Starting relay. Accept the VPN prompt on the tablet if it appears,
echo then turn the tablet's wifi OFF.
echo Press Ctrl+C to stop.
echo.

gnirehtet.exe run
set "RC=%ERRORLEVEL%"
popd

echo.
echo tether stopped (code %RC%)
pause
exit /b %RC%
