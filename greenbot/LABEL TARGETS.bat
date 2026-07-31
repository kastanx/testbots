@echo off
rem Double-click this. It opens the target labelling window - no terminal,
rem no python on PATH, no arguments to remember.
setlocal
set "HERE=%~dp0"
set "PY=%HERE%.venv\Scripts\python.exe"

if not exist "%PY%" (
    echo No virtualenv at %PY%
    echo Run setup.ps1 first.
    pause
    exit /b 1
)

pushd "%HERE%"
"%PY%" tools\label_targets.py %*
set "RC=%ERRORLEVEL%"
popd

echo.
if not "%RC%"=="0" echo exited with code %RC%
pause
exit /b %RC%
