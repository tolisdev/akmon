<?php
/**
 * Lightweight PHP Shared-Hosting Monitoring Agent for akMon
 * Can be run via CLI cron: php agent.php <token> <server_url>
 * Or web request with GET params: agent.php?token=XXX&server=http://...
 */

$token = $argv[1] ?? $_GET['token'] ?? getenv('TOKEN');
$serverUrl = $argv[2] ?? $_GET['server'] ?? getenv('SERVER_URL');

if (!$token || !$serverUrl) {
    http_response_code(400);
    die(json_encode(['error' => 'Missing token or serverUrl']));
}

$load = function_exists('sys_getloadavg') ? sys_getloadavg() : [0, 0, 0];

$diskTotal = function_exists('disk_total_space') ? @disk_total_space('/') : 0;
$diskFree = function_exists('disk_free_space') ? @disk_free_space('/') : 0;
$diskPct = ($diskTotal > 0) ? round((($diskTotal - $diskFree) / $diskTotal) * 100, 1) : 0;

$phpMemoryPeak = memory_get_peak_usage(true);
$phpMemoryMb = round($phpMemoryPeak / 1024 / 1024, 2);

$payload = json_encode([
    'token' => $token,
    'load' => $load,
    'ram_used' => $phpMemoryMb,
    'ram_total' => 0,
    'disk_pct' => $diskPct,
    'php_memory' => $phpMemoryMb . ' MB',
    'php_ver' => PHP_VERSION,
    'os_info' => PHP_OS
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
