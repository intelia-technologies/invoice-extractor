#!/usr/bin/env bash
# Instalador 1-Clic de Invoice Extractor para macOS y Linux
set -euo pipefail

cd "$(dirname "$0")"

echo "==================================================="
echo "  Invoice Extractor — Instalador Automático (1Password)"
echo "==================================================="

# 1. Instalar dependencias y navegador de automatización
node bin/invoice-extractor.mjs doctor --fix

# 2. Enlazar Skill para Claude Code / OMP / Antigravity
mkdir -p "$HOME/.claude/skills" "$HOME/.gemini/config/skills"
ln -sfn "$(pwd)/skills/invoice-extractor" "$HOME/.claude/skills/invoice-extractor"
ln -sfn "$(pwd)/skills/invoice-extractor" "$HOME/.gemini/config/skills/invoice-extractor"

# 3. Ejecutar asistente de configuración (conecta Vault de 1Password y registra MCP en Claude Desktop)
node bin/invoice-extractor.mjs setup --vault "${1:-Personal}"

echo ""
echo "✅ Instalación completada. Ya puedes pedirle a tu agente o a Claude Desktop:"
echo "   'Sincroniza mis proveedores de 1Password y bájame las facturas del mes'"
