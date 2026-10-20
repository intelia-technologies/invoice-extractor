@echo off
REM Invoice Extractor - one-click installer for Windows.
REM Optional arguments: [1password^|bitwarden] [vault name]
setlocal
cd /d "%~dp0"

echo ===================================================
echo   Invoice Extractor - Installer (Windows)
echo ===================================================

REM 0. Node.js 18+ is required.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Installing it with winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo Could not install Node.js automatically. Install it from https://nodejs.org and run this installer again.
    pause
    exit /b 1
  )
  echo Node.js installed. Close this window and run install.bat again so Windows picks up the new PATH.
  pause
  exit /b 0
)

REM 1. Choose the password manager.
set "MANAGER=%~1"
if "%MANAGER%"=="" (
  echo.
  echo Which password manager stores your billing logins?
  echo   1^) 1Password
  echo   2^) Bitwarden
  set /p CHOICE="Choose 1 or 2 [1]: "
)
if "%MANAGER%"=="" (
  if "%CHOICE%"=="2" (set "MANAGER=bitwarden") else (set "MANAGER=1password")
)
set "VAULT=%~2"
if "%VAULT%"=="" set "VAULT=Personal"

REM 2. Install dependencies (npm packages, Chromium, password manager CLI, Chrome connector).
node bin\invoice-extractor.mjs doctor --fix --manager %MANAGER%

REM 3. Link the agent Skill for Claude Code / OMP / Antigravity.
if not exist "%USERPROFILE%\.claude\skills" mkdir "%USERPROFILE%\.claude\skills"
if not exist "%USERPROFILE%\.gemini\config\skills" mkdir "%USERPROFILE%\.gemini\config\skills"
if not exist "%USERPROFILE%\.claude\skills\invoice-extractor" mklink /J "%USERPROFILE%\.claude\skills\invoice-extractor" "%CD%\skills\invoice-extractor" >nul
if not exist "%USERPROFILE%\.gemini\config\skills\invoice-extractor" mklink /J "%USERPROFILE%\.gemini\config\skills\invoice-extractor" "%CD%\skills\invoice-extractor" >nul

REM 4. Connect the password manager and register the MCP server in Claude Desktop.
if /i "%MANAGER%"=="bitwarden" (
  node bin\invoice-extractor.mjs setup --manager bitwarden
) else (
  node bin\invoice-extractor.mjs setup --manager 1password --mode desktop --vault "%VAULT%"
)

echo.
echo Done. Last step: open chrome://extensions, enable Developer mode,
echo click "Load unpacked" and select this folder:
echo    %CD%
echo.
echo Then ask your agent or Claude Desktop:
echo    "Sync my providers and download this month's invoices"
pause
