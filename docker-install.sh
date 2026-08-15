#!/bin/bash
# 🚀 akMon Automated Docker + Cloudflare Tunnel Installer
# Usage: curl -sSL https://raw.githubusercontent.com/Akeryn-Studio/akMon/main/docker-install.sh | bash

set -e

echo "================================================="
echo "  akMon Automated Docker & Cloudflared Installer "
echo "================================================="

# Check/Install Docker
if ! command -v docker &> /dev/null; then
    echo "[1/4] Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo systemctl enable --now docker
else
    echo "[1/4] Docker is already installed."
fi

# Check/Install Docker Compose
if ! docker compose version &> /dev/null; then
    echo "[2/4] Installing Docker Compose..."
    sudo apt-get update && sudo apt-get install -y docker-compose-plugin || true
fi

# Clone or pull latest repository
INSTALL_DIR="/opt/akmon"
if [ ! -d "$INSTALL_DIR" ]; then
    echo "[3/4] Cloning akMon repository to $INSTALL_DIR..."
    sudo git clone https://github.com/Akeryn-Studio/akMon.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
else
    echo "[3/4] Repository exists at $INSTALL_DIR. Pulling latest code..."
    cd "$INSTALL_DIR"
    sudo git pull origin main
fi

# Prompt for credentials if not already set in environment
if [ -z "$TUNNEL_TOKEN" ]; then
    read -p "Enter Cloudflare Tunnel Token (leave blank if not using Cloudflare Tunnel): " TUNNEL_TOKEN
fi

if [ -z "$ADMIN_PASSWORD" ]; then
    read -p "Enter Admin Password for akMon Dashboard [default: admin123]: " ADMIN_PASSWORD
    ADMIN_PASSWORD=${ADMIN_PASSWORD:-admin123}
fi

# Write .env file
echo "[4/4] Writing configuration to .env..."
sudo tee .env > /dev/null <<EOF
TUNNEL_TOKEN=${TUNNEL_TOKEN}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF

# Build & launch containers
echo "Starting akMon + Cloudflared via Docker Compose..."
sudo docker compose up -d --build

echo "================================================="
echo "  ✅ akMon Installation Complete!"
echo "  Local Dashboard: http://localhost:3000/admin"
echo "  Admin Password: ${ADMIN_PASSWORD}"
if [ -n "$TUNNEL_TOKEN" ]; then
    echo "  Cloudflare Tunnel: Active & Connected"
fi
echo "================================================="
