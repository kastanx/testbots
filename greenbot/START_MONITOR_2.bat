@echo off
rem Same as START MONITOR.bat, but the panel stays visible to screen capture so
rem you can see it over Remote Desktop.
rem
rem The trade-off: the panel then appears in the frames the service analyses.
rem It is docked to the right edge, well outside the centre crop the classifier
rem actually looks at, so location detection is unaffected - but its green
rem buttons can register as a green blob. Use this to watch and configure
rem remotely, and switch back for real runs.
rem
rem The panel also has a toggle for this in its status bar, and the choice is
rem remembered - so you only need this launcher once.

setlocal
set "HERE=%~dp0"
set "PY=%HERE%.venv\Scripts\python.exe"
set "ELECTRON=%HERE%..\node_modules\.bin\electron.cmd"

if not exist "%ELECTRON%" (
    echo Electron not found at %ELECTRON%
    pause
    exit /b 1
)

pushd "%HERE%"

"%PY%" -c "import socket,sys; s=socket.socket(); s.settimeout(0.4); sys.exit(0 if s.connect_ex(('127.0.0.1',8765))==0 else 1)"
if errorlevel 1 (
    echo starting inference service ...
    start "greenbot service" /min "%PY%" server\main.py
    for /l %%i in (1,1,40) do (
        "%PY%" -c "import socket,sys; s=socket.socket(); s.settimeout(0.4); sys.exit(0 if s.connect_ex(('127.0.0.1',8765))==0 else 1)" && goto :ready
        timeout /t 1 /nobreak >nul
    )
    echo service did not come up on 127.0.0.1:8765
    popd
    pause
    exit /b 1
)

:ready
echo opening monitor (visible to screen capture) ...
call "%ELECTRON%" monitor --visible-in-capture
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
    echo.
    echo monitor exited with code %RC%
    pause
)
exit /b %RC%
