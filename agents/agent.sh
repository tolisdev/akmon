#!/bin/sh
# Lightweight POSIX Linux Monitoring Agent for akMon
# Usage: TOKEN="your_token" SERVER_URL="http://your-server:3000" ./agent.sh

TOKEN="${TOKEN:-$1}"
SERVER_URL="${SERVER_URL:-$2}"

if [ -z "$TOKEN" ] || [ -z "$SERVER_URL" ]; then
  echo "Usage: TOKEN=<token> SERVER_URL=<server_url> ./agent.sh"
  exit 1
fi

# Load averages (1m, 5m, 15m)
if [ -f /proc/loadavg ]; then
  LOAD_1=$(awk '{print $1}' /proc/loadavg)
  LOAD_5=$(awk '{print $2}' /proc/loadavg)
  LOAD_15=$(awk '{print $3}' /proc/loadavg)
else
  LOAD_1=0; LOAD_5=0; LOAD_15=0
fi

# Memory Info (MB)
if [ -f /proc/meminfo ]; then
  MEM_TOTAL_KB=$(awk '/MemTotal:/ {print $2}' /proc/meminfo)
  MEM_AVAIL_KB=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
  if [ -z "$MEM_AVAIL_KB" ]; then
    MEM_FREE_KB=$(awk '/MemFree:/ {print $2}' /proc/meminfo)
    MEM_BUFF_KB=$(awk '/Buffers:/ {print $2}' /proc/meminfo)
    MEM_CACHED_KB=$(awk '/^Cached:/ {print $2}' /proc/meminfo)
    MEM_AVAIL_KB=$((MEM_FREE_KB + MEM_BUFF_KB + MEM_CACHED_KB))
  fi
  RAM_TOTAL=$((MEM_TOTAL_KB / 1024))
  RAM_AVAIL=$((MEM_AVAIL_KB / 1024))
  RAM_USED=$((RAM_TOTAL - RAM_AVAIL))
else
  RAM_TOTAL=0; RAM_USED=0
fi

# Disk Usage percentage for root /
DISK_PCT=$(df -k / | awk 'NR==2 {print $5}' | tr -d '%')
if [ -z "$DISK_PCT" ]; then DISK_PCT=0; fi

PAYLOAD=$(cat <<EOF
{
  "token": "$TOKEN",
  "load": [$LOAD_1, $LOAD_5, $LOAD_15],
  "ram_used": $RAM_USED,
  "ram_total": $RAM_TOTAL,
  "disk_pct": $DISK_PCT,
  "os_info": "$(uname -s -r 2>/dev/null || echo Linux)"
}
EOF
)

curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$SERVER_URL/api/v1/agent"
