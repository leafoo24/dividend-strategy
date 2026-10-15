@echo off
setlocal
rem Use batch file location (absolute at runtime) so cmd.exe encoding does not break Chinese paths in this file.
cd /d "%~dp0" || (
  echo Failed to cd to script directory.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo npm not found. Install Node.js and add it to PATH.
  pause
  exit /b 1
)

echo Starting Vite dev server...
echo Working directory: %CD%
echo.
call npm run dev
echo.
echo Dev server stopped.
pause
