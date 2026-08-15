#!/bin/bash
# 🔄 akMon 1-Click Automated Updater
# Usage: ./docker-update.sh

set -e

INSTALL_DIR="/opt/akmon"
if [ -d "$INSTALL_DIR" ]; then
    cd "$INSTALL_DIR"
fi

echo "================================================="
echo "  Pulling latest akMon updates & rebuilding..."
echo "================================================="

git pull origin main
docker compose up -d --build --remove-orphans

echo "================================================="
echo "  ✅ akMon successfully updated!"
echo "================================================="
