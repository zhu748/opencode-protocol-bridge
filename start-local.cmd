@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Service exited with code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
