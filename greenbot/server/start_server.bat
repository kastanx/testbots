@echo off
REM Start the v2 inference service. Double-clickable from Explorer: every path
REM below resolves from this file's own directory, not the caller's CWD.
REM
REM     start_server.bat
REM     start_server.bat config.test.yaml
setlocal
cd /d "%~dp0"

REM Calling the venv's python directly is the same thing as activating it, minus
REM a subshell that would swallow the exit code.
set "PY=%~dp0..\.venv\Scripts\python.exe"
if not exist "%PY%" (
    echo ERROR: no venv at "%PY%" - run setup.ps1 first.
    pause
    exit /b 1
)

if not "%~1"=="" set "GREENBOT_CONFIG=%~f1"
if "%GREENBOT_CONFIG%"=="" set "GREENBOT_CONFIG=%~dp0config.yaml"
if not exist "%GREENBOT_CONFIG%" (
    echo ERROR: no config at "%GREENBOT_CONFIG%".
    pause
    exit /b 1
)

REM Host and port live in config.yaml only - never hardcoded in two places.
set "HOSTPORT=%TEMP%\greenbot_hostport.txt"
"%PY%" -c "import os, yaml; c = yaml.safe_load(open(os.environ['GREENBOT_CONFIG'], encoding='utf-8')); print(c['host'], c['port'])" > "%HOSTPORT%"
if errorlevel 1 (
    echo ERROR: could not read host/port from "%GREENBOT_CONFIG%".
    del "%HOSTPORT%" >nul 2>&1
    pause
    exit /b 1
)
set "HOST="
set "PORT="
for /f "usebackq tokens=1,2" %%a in ("%HOSTPORT%") do (
    set "HOST=%%a"
    set "PORT=%%b"
)
del "%HOSTPORT%" >nul 2>&1
if "%PORT%"=="" (
    echo ERROR: "%GREENBOT_CONFIG%" has no host/port.
    pause
    exit /b 1
)

echo config:  %GREENBOT_CONFIG%
echo health:  http://%HOST%:%PORT%/health
echo analyze: http://%HOST%:%PORT%/analyze
echo.
"%PY%" -m uvicorn main:app --host %HOST% --port %PORT%
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo server exited with code %RC%
    rem Only hold the window open for a human who double-clicked this. When the
    rem Electron app spawns it and polls /health, an unconditional pause would
    rem leave an orphan cmd.exe alive forever on any startup failure.
    echo %CMDCMDLINE% | find /i "%~nx0" >nul
    if not errorlevel 1 pause
)
exit /b %RC%
