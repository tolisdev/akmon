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

# Detailed CPU Breakdown via /proc/stat
CPU_USER=0; CPU_SYS=0; CPU_IDLE=100; CPU_IOWAIT=0; CPU_STEAL=0
if [ -f /proc/stat ]; then
  CPU1=$(awk '/^cpu / {print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat 2>/dev/null)
  sleep 0.2
  CPU2=$(awk '/^cpu / {print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat 2>/dev/null)
  
  if [ -n "$CPU1" ] && [ -n "$CPU2" ]; then
    U1=$(echo "$CPU1" | awk '{print $1+$2}')
    S1=$(echo "$CPU1" | awk '{print $3+$6+$7}')
    I1=$(echo "$CPU1" | awk '{print $4}')
    W1=$(echo "$CPU1" | awk '{print $5}')
    ST1=$(echo "$CPU1" | awk '{print $8}')

    U2=$(echo "$CPU2" | awk '{print $1+$2}')
    S2=$(echo "$CPU2" | awk '{print $3+$6+$7}')
    I2=$(echo "$CPU2" | awk '{print $4}')
    W2=$(echo "$CPU2" | awk '{print $5}')
    ST2=$(echo "$CPU2" | awk '{print $8}')

    DU=$((U2 - U1))
    DS=$((S2 - S1))
    DI=$((I2 - I1))
    DW=$((W2 - W1))
    DST=$((ST2 - ST1))
    TOTAL=$((DU + DS + DI + DW + DST))

    if [ "$TOTAL" -gt 0 ]; then
      CPU_USER=$((DU * 100 / TOTAL))
      CPU_SYS=$((DS * 100 / TOTAL))
      CPU_IDLE=$((DI * 100 / TOTAL))
      CPU_IOWAIT=$((DW * 100 / TOTAL))
      CPU_STEAL=$((DST * 100 / TOTAL))
    fi
  fi
fi

# Network Traffic (Rx / Tx in KB/s) via /proc/net/dev
NET_RX_KBPS=0; NET_TX_KBPS=0
if [ -f /proc/net/dev ]; then
  NET1=$(awk 'NR>2 {if ($1 != "lo:") {rx+=$2; tx+=$10}} END {print rx,tx}' /proc/net/dev 2>/dev/null)
  sleep 0.3
  NET2=$(awk 'NR>2 {if ($1 != "lo:") {rx+=$2; tx+=$10}} END {print rx,tx}' /proc/net/dev 2>/dev/null)
  
  if [ -n "$NET1" ] && [ -n "$NET2" ]; then
    RX1=$(echo "$NET1" | awk '{print $1}')
    TX1=$(echo "$NET1" | awk '{print $2}')
    RX2=$(echo "$NET2" | awk '{print $1}')
    TX2=$(echo "$NET2" | awk '{print $2}')
    
    DRX=$(( (RX2 - RX1) * 10 / 3 / 1024 ))
    DTX=$(( (TX2 - TX1) * 10 / 3 / 1024 ))
    if [ "$DRX" -ge 0 ]; then NET_RX_KBPS=$DRX; fi
    if [ "$DTX" -ge 0 ]; then NET_TX_KBPS=$DTX; fi
  fi
fi

# Memory Info & Swap (MB)
RAM_TOTAL=0; RAM_USED=0; SWAP_TOTAL=0; SWAP_USED=0
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

  SWAP_TOTAL_KB=$(awk '/SwapTotal:/ {print $2}' /proc/meminfo)
  SWAP_FREE_KB=$(awk '/SwapFree:/ {print $2}' /proc/meminfo)
  if [ -n "$SWAP_TOTAL_KB" ] && [ "$SWAP_TOTAL_KB" -gt 0 ]; then
    SWAP_TOTAL=$((SWAP_TOTAL_KB / 1024))
    SWAP_FREE=$((SWAP_FREE_KB / 1024))
    SWAP_USED=$((SWAP_TOTAL - SWAP_FREE))
  fi
fi

# Disk Usage percentage for root /
DISK_PCT=$(df -k / 2>/dev/null | awk 'NR==2 {print $5}' | tr -d '%')
if [ -z "$DISK_PCT" ]; then DISK_PCT=0; fi

PAYLOAD=$(cat <<EOF
{
  "token": "$TOKEN",
  "load": [$LOAD_1, $LOAD_5, $LOAD_15],
  "ram_used": $RAM_USED,
  "ram_total": $RAM_TOTAL,
  "swap_used": $SWAP_USED,
  "swap_total": $SWAP_TOTAL,
  "disk_pct": $DISK_PCT,
  "net_rx_kbps": $NET_RX_KBPS,
  "net_tx_kbps": $NET_TX_KBPS,
  "cpu_user": $CPU_USER,
  "cpu_system": $CPU_SYS,
  "cpu_idle": $CPU_IDLE,
  "cpu_iowait": $CPU_IOWAIT,
  "cpu_steal": $CPU_STEAL,
  "os_info": "$(uname -s -r 2>/dev/null || echo Linux)"
}
EOF
)

curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$SERVER_URL/api/v1/agent"
