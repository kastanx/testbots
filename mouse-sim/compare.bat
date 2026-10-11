@echo off
rem The compare page: your movement vs replay vs the stroke model. Opens http://localhost:8771/
cd /d "%~dp0"
.venv\Scripts\python.exe compare.py --open
pause
