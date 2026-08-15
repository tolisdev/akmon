<?php
/**
 * Lightweight PHP Shared-Hosting & Server Monitoring Agent for akMon
 * Usage via CLI: php agent.php <token> <server_url>
 * Or Web GET: agent.php?token=XXX&server=http://...
 */

$token = $argv[1] ?? $_GET['token'] ?? getenv('TOKEN');
$serverUrl = $argv[2] ?? $_GET['server'] ?? getenv('SERVER_URL');

if (!$token || !$serverUrl) {
    http_response_code(400);
    die(json_encode(['error' => 'Missing token or serverUrl']));
}

$load = function_exists('sys_getloadavg') ? sys_getloadavg() : [0, 0, 0];

// CPU breakdown via /proc/stat
$cpuUser = 0; $cpuSys = 0; $cpuIdle = 100; $cpuIowait = 0; $cpuSteal = 0;
if (@is_readable('/proc/stat')) {
    $stat1 = @file_get_contents('/proc/stat');
    usleep(150000);
    $stat2 = @file_get_contents('/proc/stat');
    if ($stat1 && $stat2) {
        preg_match('/^cpu\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m', $stat1, $c1);
        preg_match('/^cpu\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m', $stat2, $c2);
        if (!empty($c1) && !empty($c2)) {
            $u1 = (int)$c1[1] + (int)$c1[2]; $s1 = (int)$c1[3] + (int)$c1[6] + (int)$c1[7]; $i1 = (int)$c1[4]; $w1 = (int)$c1[5]; $st1 = (int)$c1[8];
            $u2 = (int)$c2[1] + (int)$c2[2]; $s2 = (int)$c2[3] + (int)$c2[6] + (int)$c2[7]; $i2 = (int)$c2[4]; $w2 = (int)$c2[5]; $st2 = (int)$c2[8];
            $du = $u2 - $u1; $ds = $s2 - $s1; $di = $i2 - $i1; $dw = $w2 - $w1; $dst = $st2 - $st1;
            $tot = $du + $ds + $di + $dw + $dst;
            if ($tot > 0) {
                $cpuUser = round(($du / $tot) * 100, 1);
                $cpuSys = round(($ds / $tot) * 100, 1);
                $cpuIdle = round(($di / $tot) * 100, 1);
                $cpuIowait = round(($dw / $tot) * 100, 1);
                $cpuSteal = round(($dst / $tot) * 100, 1);
            }
        }
    }
}

// Network Traffic (Rx/Tx KB/s) via /proc/net/dev
$netRxKbps = 0; $netTxKbps = 0;
if (@is_readable('/proc/net/dev')) {
    $dev1 = @file('/proc/net/dev');
    usleep(250000);
    $dev2 = @file('/proc/net/dev');
    if ($dev1 && $dev2) {
        $rx1 = 0; $tx1 = 0; $rx2 = 0; $tx2 = 0;
        for ($i = 2; $i < count($dev1); $i++) {
            $n1 = preg_split('/\s+/', trim($dev1[$i]));
            if (isset($n1[0]) && $n1[0] !== 'lo:') {
                $rx1 += (int)($n1[1] ?? 0);
                $tx1 += (int)($n1[9] ?? $n1[10] ?? 0);
            }
        }
        for ($i = 2; $i < count($dev2); $i++) {
            $n2 = preg_split('/\s+/', trim($dev2[$i]));
            if (isset($n2[0]) && $n2[0] !== 'lo:') {
                $rx2 += (int)($n2[1] ?? 0);
                $tx2 += (int)($n2[9] ?? $n2[10] ?? 0);
            }
        }
        $netRxKbps = max(0, round(($rx2 - $rx1) * 4 / 1024, 1));
        $netTxKbps = max(0, round(($tx2 - $tx1) * 4 / 1024, 1));
    }
}

// Parse System Total, Used RAM & Swap from /proc/meminfo if available
$ramUsed = 0; $ramTotal = 0; $swapUsed = 0; $swapTotal = 0;

if (@is_readable('/proc/meminfo')) {
    $memInfo = @file_get_contents('/proc/meminfo');
    if ($memInfo) {
        preg_match('/MemTotal:\s+(\d+)\s+kB/', $memInfo, $totalMatch);
        preg_match('/MemAvailable:\s+(\d+)\s+kB/', $memInfo, $availMatch);
        
        if (empty($availMatch)) {
            preg_match('/MemFree:\s+(\d+)\s+kB/', $memInfo, $freeMatch);
            preg_match('/Buffers:\s+(\d+)\s+kB/', $memInfo, $buffMatch);
            preg_match('/^Cached:\s+(\d+)\s+kB/m', $memInfo, $cachedMatch);
            $free = (int)($freeMatch[1] ?? 0);
            $buff = (int)($buffMatch[1] ?? 0);
            $cached = (int)($cachedMatch[1] ?? 0);
            $availKb = $free + $buff + $cached;
        } else {
            $availKb = (int)($availMatch[1] ?? 0);
        }

        $totalKb = (int)($totalMatch[1] ?? 0);
        if ($totalKb > 0) {
            $ramTotal = (int)round($totalKb / 1024);
            $ramUsed = (int)round(($totalKb - $availKb) / 1024);
        }

        preg_match('/SwapTotal:\s+(\d+)\s+kB/', $memInfo, $swapTotalMatch);
        preg_match('/SwapFree:\s+(\d+)\s+kB/', $memInfo, $swapFreeMatch);
        $sTotalKb = (int)($swapTotalMatch[1] ?? 0);
        $sFreeKb = (int)($swapFreeMatch[1] ?? 0);
        if ($sTotalKb > 0) {
            $swapTotal = (int)round($sTotalKb / 1024);
            $swapUsed = (int)round(($sTotalKb - $sFreeKb) / 1024);
        }
    }
}

// PHP Process Peak Memory Usage
$phpMemoryPeak = memory_get_peak_usage(true);
$phpMemoryMb = round($phpMemoryPeak / 1024 / 1024, 2);

// Disk Usage %
$diskTotal = function_exists('disk_total_space') ? @disk_total_space('/') : 0;
$diskFree = function_exists('disk_free_space') ? @disk_free_space('/') : 0;
$diskPct = ($diskTotal > 0) ? round((($diskTotal - $diskFree) / $diskTotal) * 100, 1) : 0;

$payload = json_encode([
    'token' => $token,
    'load' => $load,
    'ram_used' => $ramUsed,
    'ram_total' => $ramTotal,
    'swap_used' => $swapUsed,
    'swap_total' => $swapTotal,
    'disk_pct' => $diskPct,
    'net_rx_kbps' => $netRxKbps,
    'net_tx_kbps' => $netTxKbps,
    'cpu_user' => $cpuUser,
    'cpu_system' => $cpuSys,
    'cpu_idle' => $cpuIdle,
    'cpu_iowait' => $cpuIowait,
    'cpu_steal' => $cpuSteal,
    'php_memory' => $phpMemoryMb . ' MB',
    'php_ver' => PHP_VERSION,
    'os_info' => PHP_OS . ' (' . php_uname('r') . ')'
]);

$ch = curl_init(rtrim($serverUrl, '/') . '/api/v1/agent');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 5
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

echo json_encode(['ok' => $httpCode === 200, 'response' => $response]);
