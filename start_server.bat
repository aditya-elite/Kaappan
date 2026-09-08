@echo off
title Privacy Agent Decision Server (SIH26171)
echo ========================================================
echo Starting Privacy Agent Decision Server on http://127.0.0.1:8000
echo ========================================================
cd /d "%~dp0server"
where python >nul 2>nul
if %ERRORLEVEL% equ 0 (
    python run_server.py
) else (
    py run_server.py
)
pause
