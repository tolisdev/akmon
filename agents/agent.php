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

// Parse System Total & Used RAM from /proc/meminfo if available
$ramUsed = 0;
$ramTotal = 0;

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
    'disk_pct' => $diskPct,
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
