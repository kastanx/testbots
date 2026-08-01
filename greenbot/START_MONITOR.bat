@echo off
rem Double-click this. Starts the inference service if it is not already up,
rem then opens the always-on-top monitor panel.
setlocal
set "HERE=%~dp0"
set "PY=%HERE%.venv\Scripts\python.exe"
set "ELECTRON=%HERE%..\node_modules\.bin\electron.cmd"

rem Remote dashboard. Uncomment both and fill them in after deploying it; the
rem token must match INGEST_TOKEN on Vercel. Left commented, nothing is sent.
rem set "GREENBOT_DASH_URL=https://your-app.vercel.app"
rem set "GREENBOT_DASH_TOKEN="

if not exist "%PY%" (
    echo No virtualenv at %PY%
    echo Run setup.ps1 first.
    pause
    exit /b 1
)
if not exist "%ELECTRON%" (
    echo Electron not found at %ELECTRON%
    echo Run:  npm install --prefix "%HERE%"
    pause
    exit /b 1
)

pushd "%HERE%"

rem Reuse a running service rather than fighting it for the port.
"%PY%" -c "import socket,sys; s=socket.socket(); s.settimeout(0.4); sys.exit(0 if s.connect_ex(('127.0.0.1',8765))==0 else 1)"
if errorlevel 1 (
    echo starting inference service ...
    start "greenbot service" /min "%PY%" server\main.py
    rem Models take a few seconds to load; poll rather than guess.
    for /l %%i in (1,1,40) do (
        "%PY%" -c "import socket,sys; s=socket.socket(); s.settimeout(0.4); sys.exit(0 if s.connect_ex(('127.0.0.1',8765))==0 else 1)" && goto :ready
        timeout /t 1 /nobreak >nul
    )
    echo service did not come up on 127.0.0.1:8765
    popd
    pause
    exit /b 1
) else (
    echo service already running
)

:ready
echo opening monitor ...
call "%ELECTRON%" monitor
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
    echo.
    echo monitor exited with code %RC%
    pause
)
exit /b %RC%
