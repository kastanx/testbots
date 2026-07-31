@echo off
rem Runs any of this project's python scripts with the venv interpreter.
rem
rem A bare `python` on this machine hits the Windows Store stub ("Python nebyl
rem nalezen") because Python 3.11 was installed to user scope and is not on PATH.
rem This avoids having to remember that, and works from any directory.
rem
rem   run.bat tools\pick_review.py --frames 2
rem   run.bat ml\prepare_dataset.py --val-newest 1
rem   run.bat server\main.py

setlocal
set "HERE=%~dp0"
set "PY=%HERE%.venv\Scripts\python.exe"

if not exist "%PY%" (
    echo No venv at %PY%
    echo Run:  powershell -ExecutionPolicy Bypass -File "%HERE%setup.ps1"
    exit /b 1
)

pushd "%HERE%"
"%PY%" %*
set "RC=%ERRORLEVEL%"
popd

rem Hold the window open only when something went wrong. A CMDCMDLINE check
rem cannot tell a double-click from a PowerShell invocation - both spawn
rem `cmd /c ...run.bat`, so it would pause on every successful run too.
if not "%RC%"=="0" (
    echo.
    echo exited with code %RC%
    pause
)
exit /b %RC%
