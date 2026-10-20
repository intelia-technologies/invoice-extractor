@echo off
REM Instalador 1-Clic de Invoice Extractor para Windows
cd /d "%~dp0"

echo ===================================================
echo   Invoice Extractor — Instalador Automatico (1Password)
echo ===================================================

node bin\invoice-extractor.mjs doctor --fix

set "VAULT=%~1"
if "%VAULT%"=="" set "VAULT=Personal"

node bin\invoice-extractor.mjs setup --vault "%VAULT%"

echo.
echo Instalacion completada. Ya puedes abrir Claude Desktop o tu agente y pedir:
echo "Sincroniza mis proveedores de 1Password y bajame las facturas del mes"
pause
