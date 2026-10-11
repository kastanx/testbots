@echo off
rem Builds the web pages if needed and starts the local server on http://localhost:8765/
cd /d "%~dp0"
if not exist web\dist\index.html (
  echo Building the web pages...
  pushd web
  call npm run build || (popd & pause & exit /b 1)
  popd
)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8765/"
.venv\Scripts\python.exe serve.py --port 8765
pause
