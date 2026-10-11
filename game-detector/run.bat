@echo off
rem Runs a module of this project with its own Python, from any folder. Examples:
rem   run.bat detector.main --source synth --weights runs\detect\synth\weights\best.engine
rem   run.bat tools.capture_frames --session s01
cd /d "%~dp0"
".venv\Scripts\python.exe" -m %*
