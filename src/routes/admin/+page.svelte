<script>
	import { onMount } from 'svelte';
	import io from 'socket.io-client';

	let authenticated = $state(false);
	let passwordInput = $state('');
	let authError = $state('');
	let authToken = $state('');

	let authOptions = $state({ password_auth_enabled: true, oidc_enabled: false, logo_url: '' });
	let adminLogoLoaded = $state(false);

	let monitors = $state([]);
	let loading = $state(true);
	let showModal = $state(false);
	let editingMonitor = $state(null);
	let showAgentModal = $state(false);
	let selectedAgentMonitor = $state(null);

	// Action Menu State (Tight Fixed Positioning)
	let activeMenuId = $state(null);
	let menuPos = $state({ top: 0, right: 0 });

	// In-Depth Telemetry Modal State
	let showTelemetryModal = $state(false);
	let selectedTelemetryMonitor = $state(null);

	function openTelemetryModal(m) {
		if (!m) return;
		selectedTelemetryMonitor = m;
		showTelemetryModal = true;
	}

	function parseHeartbeatMetrics(hb) {
		if (!hb || !hb.msg) return null;
		try {
			return JSON.parse(hb.msg);
		} catch (e) {
			return null;
		}
	}

	function generateCpuPath(heartbeats = [], key = 'cpu_user', width = 500, height = 120) {
		if (!heartbeats || heartbeats.length === 0) return '';
		const points = heartbeats.map((hb, i) => {
			const m = parseHeartbeatMetrics(hb) || {};
			const val = Math.min(100, Math.max(0, m[key] || 0));
			const x = (i / (heartbeats.length - 1 || 1)) * width;
			const y = height - (val / 100) * (height - 10) - 5;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});
		return points.join(' ');
	}

	function generateLoadPath(heartbeats = [], loadIndex = 0, width = 500, height = 120) {
		if (!heartbeats || heartbeats.length === 0) return '';
		const loads = heartbeats.map((hb) => {
			const m = parseHeartbeatMetrics(hb) || {};
			return m.load ? (m.load[loadIndex] || 0) : 0;
		});
		const maxLoad = Math.max(...loads, 1);
		const points = heartbeats.map((hb, i) => {
			const m = parseHeartbeatMetrics(hb) || {};
			const val = m.load ? (m.load[loadIndex] || 0) : 0;
			const x = (i / (heartbeats.length - 1 || 1)) * width;
			const y = height - (val / maxLoad) * (height - 10) - 5;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});
		return points.join(' ');
	}

	function generateRamPath(heartbeats = [], width = 500, height = 120) {
		if (!heartbeats || heartbeats.length === 0) return '';
		const points = heartbeats.map((hb, i) => {
			const m = parseHeartbeatMetrics(hb) || {};
			const pct = m.ram_total > 0 ? (m.ram_used / m.ram_total) * 100 : 0;
			const x = (i / (heartbeats.length - 1 || 1)) * width;
			const y = height - (pct / 100) * (height - 10) - 5;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});
		return points.join(' ');
	}

	function generateNetPath(heartbeats = [], key = 'net_rx_kbps', width = 500, height = 120) {
		if (!heartbeats || heartbeats.length === 0) return '';
		const maxSpeed = Math.max(...heartbeats.map((hb) => (parseHeartbeatMetrics(hb) || {})[key] || 0), 10);
		const points = heartbeats.map((hb, i) => {
			const m = parseHeartbeatMetrics(hb) || {};
			const val = m[key] || 0;
			const x = (i / (heartbeats.length - 1 || 1)) * width;
			const y = height - (val / maxSpeed) * (height - 10) - 5;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});
		return points.join(' ');
	}

	function generateSwapPath(heartbeats = [], width = 500, height = 120) {
		if (!heartbeats || heartbeats.length === 0) return '';
		const points = heartbeats.map((hb, i) => {
			const m = parseHeartbeatMetrics(hb) || {};
			const pct = m.swap_total > 0 ? (m.swap_used / m.swap_total) * 100 : 0;
			const x = (i / (heartbeats.length - 1 || 1)) * width;
			const y = height - (pct / 100) * (height - 10) - 5;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});
		return points.join(' ');
	}

	function formatSpeed(kbps = 0) {
		if (kbps >= 1024 * 1024) return (kbps / 1024 / 1024).toFixed(1) + ' GB/s';
		if (kbps >= 1024) return (kbps / 1024).toFixed(1) + ' MB/s';
		return Math.round(kbps) + ' KB/s';
	}

	// Settings State (Clean Boolean Checkbox State)
	let showSettingsModal = $state(false);
	let settingsLoading = $state(false);
	let settingsMessage = $state('');
	let settingsError = $state('');
	let testStatus = $state({ pushover: '', email: '' });

	let settingsForm = $state({
		password_auth_enabled: true,
		pushover_enabled: true,
		smtp_enabled: false,
		oidc_enabled: false,
		logo_url: '',
		pushover_user_key: '',
		pushover_api_token: '',
		pushover_sound_down: 'siren',
		pushover_sound_up: 'magic',
		smtp_host: '',
		smtp_port: '587',
		smtp_secure: 'false',
		smtp_user: '',
		smtp_pass: '',
		smtp_from: '',
		smtp_to: '',
		oidc_issuer: '',
		oidc_client_id: '',
		oidc_client_secret: '',
		oidc_redirect_uri: ''
	});

	// Monitor Form State
	let formName = $state('');
	let formType = $state('http');
	let formGroupName = $state('Websites');
	let formUrl = $state('');
	let formKeyword = $state('');
	let formInterval = $state(60);
	let formMaxRetries = $state(3);
	let formPushoverPriority = $state(1);
	let formIsPublic = $state(true);
	let formError = $state('');

	function parseDate(dateStr) {
		if (!dateStr) return null;
		let str = String(dateStr).trim();
		if (!str.endsWith('Z') && !str.includes('+') && !str.includes('GMT')) {
			str = str.replace(' ', 'T') + 'Z';
		}
		const d = new Date(str);
		return isNaN(d.getTime()) ? new Date(dateStr) : d;
	}

	// Helper for Relative Time
	function formatRelativeTime(dateStr) {
		if (!dateStr) return 'Never';
		const date = parseDate(dateStr);
		if (!date) return '—';
		const now = new Date();
		const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

		if (isNaN(diffSec) || diffSec < 0) return 'Just now';
		if (diffSec < 5) return 'Just now';
		if (diffSec < 60) return `${diffSec}s ago`;
		if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
		if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
		return `${Math.floor(diffSec / 86400)}d ago`;
	}

	function formatExactTime(dateStr) {
		if (!dateStr) return '';
		const d = parseDate(dateStr);
		return !d || isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
	}

	function toggleRowMenu(id, e) {
		e?.stopPropagation();
		if (activeMenuId === id) {
			activeMenuId = null;
			return;
		}

		const rect = e.currentTarget.getBoundingClientRect();
		menuPos = {
			top: Math.round(rect.bottom + 2),
			right: Math.round(window.innerWidth - rect.right)
		};
		activeMenuId = id;
	}

	function closeAllMenus() {
		activeMenuId = null;
	}

	// Automatically adjust default group and priority when type changes
	$effect(() => {
		if (!editingMonitor) {
			if (formType === 'http') {
				formGroupName = 'Websites';
				formPushoverPriority = 1;
			} else if (formType === 'ping') {
				formGroupName = 'Servers';
				formPushoverPriority = 2;
			} else if (formType === 'agent_linux' || formType === 'agent_php') {
				formGroupName = 'Servers';
				formPushoverPriority = 2;
			}
		}
	});

	// SVG Sparkline Helper
	function generateSparklinePoints(heartbeats = [], width = 100, height = 24) {
		if (!heartbeats || heartbeats.length === 0) return '';
		const pings = heartbeats.map((h) => h.ping_ms || 0);
		const maxPing = Math.max(...pings, 1);
		const minPing = Math.min(...pings, 0);

		const points = heartbeats.map((hb, i) => {
			const x = (i / (heartbeats.length - 1 || 1)) * width;
			const ping = hb.ping_ms || 0;
			const y = height - ((ping - minPing) / (maxPing - minPing || 1)) * (height - 4) - 2;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});

		return points.join(' ');
	}

	async function fetchAuthOptions() {
		try {
			const res = await fetch('/api/v1/auth/options');
			if (res.ok) {
				const data = await res.json();
				authOptions = data;
			}
		} catch (e) {
			console.error('Failed to fetch auth options', e);
		}
	}

	async function login() {
		authError = '';
		try {
			const res = await fetch('/api/v1/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ password: passwordInput })
			});
			const data = await res.json();
			if (data.ok) {
				authToken = data.token;
				localStorage.setItem('akmon_auth_token', authToken);
				authenticated = true;
				loadMonitors();
			} else {
				authError = data.error || 'Invalid password';
			}
		} catch (e) {
			authError = 'Login request failed';
		}
	}

	function logout() {
		authToken = '';
		localStorage.removeItem('akmon_auth_token');
		authenticated = false;
		fetchAuthOptions();
	}

	async function loadMonitors() {
		loading = true;
		try {
			const res = await fetch('/api/v1/monitors', {
				headers: { Authorization: `Bearer ${authToken}` }
			});
			if (res.status === 401) {
				authenticated = false;
				fetchAuthOptions();
				return;
			}
			const data = await res.json();
			if (data.monitors) {
				monitors = data.monitors;
			}
			fetchShareToken();
		} catch (e) {
			console.error('Failed to load monitors', e);
		} finally {
			loading = false;
		}
	}

	async function openSettingsModal() {
		settingsMessage = '';
		settingsError = '';
		settingsLoading = true;
		showSettingsModal = true;
		try {
			const res = await fetch('/api/v1/settings', {
				headers: { Authorization: `Bearer ${authToken}` }
			});
			if (res.ok) {
				const data = await res.json();
				if (data.settings) {
					const s = data.settings;
					Object.assign(settingsForm, {
						password_auth_enabled: s.password_auth_enabled !== 'false',
						pushover_enabled: s.pushover_enabled !== 'false',
						smtp_enabled: s.smtp_enabled === 'true',
						oidc_enabled: s.oidc_enabled === 'true',
						logo_url: s.logo_url || '',
						pushover_user_key: s.pushover_user_key || '',
						pushover_api_token: s.pushover_api_token || '',
						pushover_sound_down: s.pushover_sound_down || 'siren',
						pushover_sound_up: s.pushover_sound_up || 'magic',
						smtp_host: s.smtp_host || '',
						smtp_port: s.smtp_port || '587',
						smtp_secure: s.smtp_secure || 'false',
						smtp_user: s.smtp_user || '',
						smtp_pass: s.smtp_pass || '',
						smtp_from: s.smtp_from || '',
						smtp_to: s.smtp_to || '',
						oidc_issuer: s.oidc_issuer || '',
						oidc_client_id: s.oidc_client_id || '',
						oidc_client_secret: s.oidc_client_secret || '',
						oidc_redirect_uri: s.oidc_redirect_uri || ''
					});
				}
			}
			await fetchShareToken();
		} catch (e) {
			settingsError = 'Failed to load system settings';
		} finally {
			settingsLoading = false;
		}
	}

	// Secret Share Access Token State
	let shareToken = $state('');
	let shareTokenCopied = $state(false);

	async function fetchShareToken() {
		try {
			const res = await fetch('/api/v1/settings/share-token', {
				headers: { Authorization: `Bearer ${authToken}` }
			});
			if (res.ok) {
				const data = await res.json();
				shareToken = data.token || '';
			}
		} catch (e) {
			console.error(e);
		}
	}

	async function regenerateShareToken() {
		if (!confirm('Are you sure you want to generate a new 64-character secret share token? Existing secret links will no longer work.')) return;
		try {
			const res = await fetch('/api/v1/settings/share-token/regenerate', {
				method: 'POST',
				headers: { Authorization: `Bearer ${authToken}` }
			});
			if (res.ok) {
				const data = await res.json();
				shareToken = data.token || '';
			}
		} catch (e) {
			console.error(e);
		}
	}

	function getPrivateShareUrl() {
		const origin = typeof window !== 'undefined' ? window.location.origin : 'http://your-vps-ip:3000';
		return `${origin}/?token=${shareToken}`;
	}

	async function copyShareLink() {
		if (!shareToken) {
			await fetchShareToken();
		}
		const url = getPrivateShareUrl();
		if (navigator.clipboard) {
			navigator.clipboard.writeText(url);
			shareTokenCopied = true;
			setTimeout(() => (shareTokenCopied = false), 2500);
		}
	}

	// Custom Client Status Pages State
	let showStatusPagesModal = $state(false);
	let statusPagesTab = $state('create');
	let statusPagesList = $state([]);
	let newPageTitle = $state('');
	let selectedMonitorIdsForPage = $state([]);
	let statusPageCreateError = $state('');
	let statusPageCopiedId = $state(null);

	async function loadStatusPages() {
		try {
			const res = await fetch('/api/v1/status-pages', {
				headers: { Authorization: `Bearer ${authToken}` }
			});
			if (res.ok) {
				const data = await res.json();
				statusPagesList = data.pages || [];
			}
		} catch (e) {
			console.error(e);
		}
	}

	function openStatusPagesModal() {
		newPageTitle = '';
		selectedMonitorIdsForPage = monitors.map((m) => m.id);
		statusPageCreateError = '';
		statusPagesTab = 'create';
		showStatusPagesModal = true;
		loadStatusPages();
	}

	function toggleMonitorSelectionForPage(id) {
		if (selectedMonitorIdsForPage.includes(id)) {
			selectedMonitorIdsForPage = selectedMonitorIdsForPage.filter((mId) => mId !== id);
		} else {
			selectedMonitorIdsForPage = [...selectedMonitorIdsForPage, id];
		}
	}

	async function createClientStatusPage() {
		statusPageCreateError = '';
		if (!newPageTitle.trim()) {
			statusPageCreateError = 'Please enter a title for the client status page';
			return;
		}
		if (selectedMonitorIdsForPage.length === 0) {
			statusPageCreateError = 'Please select at least one monitor to include';
			return;
		}

		try {
			const res = await fetch('/api/v1/status-pages', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${authToken}`
				},
				body: JSON.stringify({
					title: newPageTitle.trim(),
					monitor_ids: selectedMonitorIdsForPage
				})
			});
			const data = await res.json();
			if (res.ok && data.page) {
				newPageTitle = '';
				loadStatusPages();
				statusPagesTab = 'manage';
			} else {
				statusPageCreateError = data.error || 'Failed to create custom status page';
			}
		} catch (e) {
			statusPageCreateError = e.message || 'Request error';
		}
	}

	async function deleteClientStatusPage(id) {
		if (!confirm('Are you sure you want to delete this custom client status page? The link sent to clients will be revoked immediately.')) return;
		try {
			await fetch(`/api/v1/status-pages/${id}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${authToken}` }
			});
			loadStatusPages();
		} catch (e) {
			console.error(e);
		}
	}

	function getCustomPageUrl(pageId) {
		const origin = typeof window !== 'undefined' ? window.location.origin : 'http://your-vps-ip:3000';
		return `${origin}/status-page/${pageId}`;
	}

	function copyCustomPageUrl(pageId) {
		const url = getCustomPageUrl(pageId);
		if (navigator.clipboard) {
			navigator.clipboard.writeText(url);
			statusPageCopiedId = pageId;
			setTimeout(() => (statusPageCopiedId = null), 2500);
		}
	}

	async function saveSettings() {
		settingsMessage = '';
		settingsError = '';
		try {
			const payload = {
				...settingsForm,
				password_auth_enabled: settingsForm.password_auth_enabled ? 'true' : 'false',
				pushover_enabled: settingsForm.pushover_enabled ? 'true' : 'false',
				smtp_enabled: settingsForm.smtp_enabled ? 'true' : 'false',
				oidc_enabled: settingsForm.oidc_enabled ? 'true' : 'false'
			};

			const res = await fetch('/api/v1/settings', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${authToken}`
				},
				body: JSON.stringify(payload)
			});

			if (res.ok) {
				settingsMessage = 'Settings saved successfully!';
				fetchAuthOptions();
			} else {
				settingsError = 'Failed to save settings';
			}
		} catch (e) {
			settingsError = e.message || 'Request error';
		}
	}

	async function testNotification(type) {
		testStatus = { ...testStatus, [type]: 'Sending test...' };
		try {
			const res = await fetch('/api/v1/notifications/test', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${authToken}`
				},
				body: JSON.stringify({ type })
			});
			const data = await res.json();
			if (data.ok) {
				testStatus = { ...testStatus, [type]: '✅ Test alert delivered!' };
			} else {
				testStatus = { ...testStatus, [type]: `❌ Failed: ${data.reason || data.error || 'Check credentials'}` };
			}
		} catch (e) {
			testStatus = { ...testStatus, [type]: `❌ Error: ${e.message}` };
		}
	}

	onMount(() => {
		fetchAuthOptions();
		const savedToken = localStorage.getItem('akmon_auth_token');
		if (savedToken) {
			authToken = savedToken;
			authenticated = true;
			loadMonitors();
		} else {
			loading = false;
		}

		const socketInstance = io(window.location.origin);
		socketInstance.on('heartbeat', (hb) => {
			const idx = monitors.findIndex((m) => m.id === hb.monitor_id);
			if (idx !== -1) {
				monitors[idx].latest_status = hb.status;
				monitors[idx].latest_ping = hb.ping_ms;
				monitors[idx].latest_msg = hb.msg;
				monitors[idx].last_check = hb.created_at;

				if (hb.ssl_days !== undefined) {
					monitors[idx].ssl_days = hb.ssl_days;
				}

				const recent = [...(monitors[idx].recent_heartbeats || [])];
				recent.push(hb);
				if (recent.length > 60) recent.shift();
				monitors[idx].recent_heartbeats = recent;
			}
		});

		socketInstance.on('agent_update', ({ monitor_id, metrics }) => {
			const idx = monitors.findIndex((m) => m.id === monitor_id);
			if (idx !== -1) {
				monitors[idx].agent_metrics = metrics;
				monitors[idx].last_check = new Date().toISOString();
			}
		});

		window.addEventListener('click', closeAllMenus);
		window.addEventListener('scroll', closeAllMenus, true);

		return () => {
			socketInstance.disconnect();
			window.removeEventListener('click', closeAllMenus);
			window.removeEventListener('scroll', closeAllMenus, true);
		};
	});

	function openCreateModal() {
		editingMonitor = null;
		formName = '';
		formType = 'http';
		formGroupName = 'Websites';
		formUrl = 'https://';
		formKeyword = '';
		formInterval = 60;
		formMaxRetries = 3;
		formPushoverPriority = 1;
		formIsPublic = true;
		formError = '';
		showModal = true;
	}

	function openEditModal(m) {
		editingMonitor = m;
		formName = m.name;
		formType = m.type;
		formGroupName = m.group_name || 'Default';
		formUrl = m.url || '';
		formKeyword = m.keyword || '';
		formInterval = m.interval_sec || 60;
		formMaxRetries = m.max_retries !== undefined && m.max_retries !== null ? m.max_retries : 3;
		formPushoverPriority = m.pushover_priority !== undefined ? m.pushover_priority : (m.type === 'http' ? 1 : 2);
		formIsPublic = m.is_public !== 0;
		formError = '';
		activeMenuId = null;
		showModal = true;
	}

	async function saveMonitor() {
		formError = '';
		if (!formName) {
			formError = 'Monitor name is required';
			return;
		}

		const payload = {
			name: formName,
			type: formType,
			group_name: formGroupName,
			url: formUrl,
			keyword: formKeyword,
			interval_sec: parseInt(formInterval, 10),
			max_retries: parseInt(formMaxRetries, 10),
			pushover_priority: parseInt(formPushoverPriority, 10),
			is_public: formIsPublic ? 1 : 0
		};

		try {
			const url = editingMonitor ? `/api/v1/monitors/${editingMonitor.id}` : '/api/v1/monitors';
			const method = editingMonitor ? 'PUT' : 'POST';

			const res = await fetch(url, {
				method,
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${authToken}`
				},
				body: JSON.stringify(payload)
			});

			if (res.ok) {
				showModal = false;
				loadMonitors();
			} else {
				const data = await res.json();
				formError = data.error || 'Failed to save monitor';
			}
		} catch (e) {
			formError = e.message || 'Request error';
		}
	}

	async function toggleActive(m) {
		activeMenuId = null;
		try {
			await fetch(`/api/v1/monitors/${m.id}/toggle`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${authToken}` }
			});
			loadMonitors();
		} catch (e) {
			console.error(e);
		}
	}

	async function toggleMaintenanceMode(m) {
		activeMenuId = null;
		try {
			await fetch(`/api/v1/monitors/${m.id}/maintenance`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${authToken}` }
			});
			loadMonitors();
		} catch (e) {
			console.error(e);
		}
	}

	async function toggleVisibilityMode(m) {
		activeMenuId = null;
		try {
			await fetch(`/api/v1/monitors/${m.id}/visibility`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${authToken}` }
			});
			loadMonitors();
		} catch (e) {
			console.error(e);
		}
	}

	async function clearHistory(m) {
		activeMenuId = null;
		if (!confirm(`Clear all heartbeat history for "${m.name}"? This will reset health bars and latency logs.`)) return;
		try {
			await fetch(`/api/v1/monitors/${m.id}/history`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${authToken}` }
			});
			loadMonitors();
		} catch (e) {
			console.error(e);
		}
	}

	async function deleteMon(m) {
		activeMenuId = null;
		if (!confirm(`Delete monitor "${m.name}"?`)) return;
		try {
			await fetch(`/api/v1/monitors/${m.id}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${authToken}` }
			});
			loadMonitors();
		} catch (e) {
			console.error(e);
		}
	}

	function openAgentInstall(m) {
		activeMenuId = null;
		selectedAgentMonitor = m;
		showAgentModal = true;
	}

	function getLinuxCommand(m) {
		const origin = typeof window !== 'undefined' ? window.location.origin : 'http://your-vps-ip:3000';
		return `curl -sSL ${origin}/agents/agent.sh | TOKEN="${m.token}" SERVER_URL="${origin}" sh`;
	}

	function getPhpSnippet(m) {
		const origin = typeof window !== 'undefined' ? window.location.origin : 'http://your-vps-ip:3000';
		return `TOKEN="${m.token}" SERVER_URL="${origin}" php agent.php`;
	}
</script>

<!-- Authentication Screen -->
{#if !authenticated}
	<div class="min-h-screen flex items-center justify-center p-4">
		<div class="w-full max-w-sm bg-[#18181b] border border-[#27272a] p-6 rounded-xl shadow-2xl space-y-6">
			<div class="flex items-center gap-3">
				<!-- Zero-Shift Preloader Logo Container -->
				<div class="relative flex items-center min-w-[32px] h-8">
					{#if authOptions.logo_url && !adminLogoLoaded}
						<div class="animate-pulse bg-zinc-800/80 border border-zinc-700/50 rounded w-24 h-8 flex items-center justify-center text-[9px] font-mono text-zinc-400 px-1.5">
							<span class="inline-block animate-spin w-2.5 h-2.5 border border-emerald-500 border-t-transparent rounded-full mr-1 flex-shrink-0"></span>
							<span>Loading...</span>
						</div>
					{/if}

					{#if authOptions.logo_url && authOptions.logo_url.trim() !== ''}
						<img
							src={authOptions.logo_url}
							alt="Logo"
							onload={() => (adminLogoLoaded = true)}
							onerror={() => (adminLogoLoaded = true)}
							class="h-8 w-auto max-w-[140px] object-contain rounded transition-opacity duration-300 {adminLogoLoaded ? 'opacity-100' : 'opacity-0 absolute inset-0 pointer-events-none'}"
						/>
					{:else}
						<div class="w-8 h-8 rounded bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-mono text-xs font-bold flex-shrink-0">
							AK
						</div>
					{/if}
				</div>

				<div>
					<h2 class="text-base font-bold text-white tracking-wide">Admin Dashboard</h2>
					<p class="text-xs text-zinc-400">akMon System Management</p>
				</div>
			</div>

			{#if authOptions.password_auth_enabled}
				<form onsubmit={(e) => { e.preventDefault(); login(); }} class="space-y-4">
					{#if authError}
						<div class="p-2.5 rounded bg-rose-950/80 border border-rose-500/40 text-rose-300 text-xs font-mono">
							{authError}
						</div>
					{/if}

					<div>
						<label for="admin-pass" class="block text-xs font-mono text-zinc-400 mb-1">ADMIN PASSWORD</label>
						<input
							id="admin-pass"
							type="password"
							bind:value={passwordInput}
							placeholder="Enter password..."
							class="w-full px-3 py-2 bg-[#09090b] border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-emerald-500 font-mono"
						/>
					</div>

					<button
						type="submit"
						class="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-black font-semibold rounded text-xs uppercase tracking-wider transition-colors"
					>
						Authenticate
					</button>
				</form>

				<div class="relative flex py-1 items-center">
					<div class="flex-grow border-t border-zinc-800"></div>
					<span class="flex-shrink mx-3 text-[10px] font-mono text-zinc-500 uppercase">OR OIDC</span>
					<div class="flex-grow border-t border-zinc-800"></div>
				</div>
			{:else}
				<div class="p-3 rounded bg-amber-950/40 border border-amber-500/30 text-amber-300 text-xs font-mono text-center">
					🔒 Password authentication is disabled. Please authenticate via PocketID OIDC below.
				</div>
			{/if}

			<!-- PocketID OIDC Button -->
			<a
				href="/api/v1/auth/oidc/login"
				class="w-full py-2.5 bg-indigo-600/90 hover:bg-indigo-500 border border-indigo-400/30 text-white font-semibold rounded text-xs flex items-center justify-center gap-2 transition-colors shadow"
			>
				<span>🆔</span> Login with PocketID
			</a>
		</div>
	</div>
{:else}
	<!-- Admin Dashboard Header -->
	<div class="w-full border-b border-[#27272a] bg-[#09090b]/90 backdrop-blur sticky top-0 z-30">
		<div class="max-w-7xl mx-auto px-4 py-3 sm:py-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
			<div class="flex items-center justify-between sm:justify-start gap-3">
				<div class="flex items-center gap-3">
					<a href="/" class="text-xs text-zinc-400 hover:text-white transition-colors flex items-center gap-1 font-mono">
						<span>←</span> Public Status
					</a>
					<div class="h-4 w-px bg-zinc-800"></div>
					{#if authOptions.logo_url && authOptions.logo_url.trim() !== ''}
						<img src={authOptions.logo_url} alt="Logo" class="h-6 sm:h-7 w-auto max-w-[120px] object-contain rounded" />
					{/if}
					<h1 class="text-sm sm:text-base font-bold text-white tracking-wide flex items-center gap-2">
						<span class="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0"></span>
						<span class="truncate">Management</span>
					</h1>
				</div>

				<button
					onclick={logout}
					class="sm:hidden px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded text-xs font-mono"
				>
					Logout
				</button>
			</div>

			<div class="grid grid-cols-3 sm:flex items-center gap-2">
				<button
					onclick={openStatusPagesModal}
					class="px-2.5 sm:px-3 py-1.5 bg-indigo-950/80 hover:bg-indigo-900 border border-indigo-500/40 text-indigo-200 rounded text-xs flex items-center justify-center gap-1.5 transition-colors font-mono shadow truncate"
				>
					<span>🔗</span> <span class="hidden sm:inline">Share</span> Client Page
				</button>
				<button
					onclick={openSettingsModal}
					class="px-2.5 sm:px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 rounded text-xs flex items-center justify-center gap-1.5 transition-colors font-mono truncate"
				>
					⚙️ Settings
				</button>
				<button
					onclick={openCreateModal}
					class="px-2.5 sm:px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-black font-semibold rounded text-xs flex items-center justify-center gap-1.5 transition-colors shadow truncate"
				>
					<span>+</span> Add <span class="hidden sm:inline">Monitor</span>
				</button>
				<button
					onclick={logout}
					class="hidden sm:block px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded text-xs transition-colors font-mono"
				>
					Logout
				</button>
			</div>
		</div>
	</div>

	<main class="max-w-7xl mx-auto px-4 py-8 w-full space-y-8">
		<!-- Summary Cards -->
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
			<div class="p-4 rounded-xl bg-[#18181b] border border-[#27272a]">
				<span class="text-[11px] font-mono uppercase text-zinc-400">Total Monitors</span>
				<div class="text-2xl font-bold font-mono text-white mt-1">{monitors.length}</div>
			</div>
			<div class="p-4 rounded-xl bg-[#18181b] border border-[#27272a]">
				<span class="text-[11px] font-mono uppercase text-emerald-400">Operational</span>
				<div class="text-2xl font-bold font-mono text-emerald-400 mt-1">
					{monitors.filter((m) => m.latest_status === 1).length}
				</div>
			</div>
			<div class="p-4 rounded-xl bg-[#18181b] border border-[#27272a]">
				<span class="text-[11px] font-mono uppercase text-rose-400">Offline</span>
				<div class="text-2xl font-bold font-mono text-rose-400 mt-1">
					{monitors.filter((m) => m.latest_status === 0).length}
				</div>
			</div>
			<div class="p-4 rounded-xl bg-[#18181b] border border-[#27272a]">
				<span class="text-[11px] font-mono uppercase text-amber-400">Degraded</span>
				<div class="text-2xl font-bold font-mono text-amber-400 mt-1">
					{monitors.filter((m) => m.latest_status === 2).length}
				</div>
			</div>
		</div>

		<!-- High Density Monitors Table -->
		<div class="rounded-xl bg-[#18181b] border border-[#27272a] shadow-sm">
			<div class="px-5 py-4 border-b border-[#27272a] flex items-center justify-between">
				<h2 class="text-sm font-semibold text-white tracking-wide">Monitors & Services</h2>
				<div class="flex items-center gap-3">
					<span class="text-xs font-mono text-zinc-400">{monitors.length} Active Services</span>
					<button
						onclick={openStatusPagesModal}
						class="px-3 py-1 bg-indigo-950/80 hover:bg-indigo-900 border border-indigo-500/40 text-indigo-300 rounded text-xs font-mono font-semibold flex items-center gap-1.5 transition-colors shadow"
					>
						<span>🔗</span> Share Custom Client Page
					</button>
				</div>
			</div>

			<!-- Mobile Touch-Optimized Cards (< 768px) -->
			<div class="block md:hidden divide-y divide-[#27272a]/80">
				{#if loading}
					<div class="p-8 text-center text-zinc-500 font-mono text-xs">Loading monitor telemetry...</div>
				{:else if monitors.length === 0}
					<div class="p-8 text-center text-zinc-500 font-mono text-xs">No monitors configured yet. Click "+ Add Monitor" above.</div>
				{:else}
					{#each monitors as m (m.id)}
						<div class="p-4 space-y-3 hover:bg-zinc-800/20 transition-colors">
							<div class="flex items-start justify-between gap-2">
								<div class="space-y-1">
									<div class="flex items-center gap-2 flex-wrap">
										<span class="font-bold text-white text-sm font-sans">{m.name}</span>
										{#if m.is_public === 0}
											<span class="px-1.5 py-0.5 text-[9px] font-mono rounded bg-zinc-800 border border-zinc-700 text-zinc-400 font-bold">🔒 PRIVATE</span>
										{/if}
									</div>
									<div class="text-xs text-zinc-400 font-mono truncate max-w-[220px]">{m.url || 'Agent Ingestion'}</div>
								</div>

								<button
									onclick={(e) => toggleRowMenu(m.id, e)}
									class="w-8 h-8 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 flex items-center justify-center font-bold text-base transition-colors flex-shrink-0"
									title="Actions menu"
								>
									⋮
								</button>
							</div>

							<div class="flex items-center justify-between gap-2 pt-1 border-t border-zinc-800/60 font-mono text-xs">
								<div class="flex items-center gap-2 flex-wrap">
									{#if m.active === 2}
										<span class="px-2 py-0.5 rounded bg-amber-950/80 border border-amber-500/40 text-amber-300 text-[10px] font-bold">🛠️ MAINTENANCE</span>
									{:else if m.active === 0}
										<span class="px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 text-[10px]">PAUSED</span>
									{:else if m.latest_status === 1}
										<span class="px-2 py-0.5 rounded bg-emerald-950/80 border border-emerald-500/30 text-emerald-400 text-[10px] font-bold flex items-center gap-1">
											<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> UP
										</span>
									{:else if m.latest_status === 2}
										<span class="px-2 py-0.5 rounded bg-amber-950/80 border border-amber-500/30 text-amber-400 text-[10px] font-bold flex items-center gap-1">
											<span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span> DEGRADED
										</span>
									{:else}
										<span class="px-2 py-0.5 rounded bg-rose-950/80 border border-rose-500/40 text-rose-400 text-[10px] font-bold flex items-center gap-1">
											<span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> DOWN
										</span>
									{/if}
									<span class="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-[10px] uppercase text-zinc-400">{m.type}</span>
									<span class="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 text-[10px]">{m.group_name || 'Default'}</span>
								</div>

								<div class="flex items-center gap-3">
									{#if m.latest_ping > 0}
										<span class="text-zinc-300">{m.latest_ping}ms</span>
									{/if}
									<span class="font-bold text-white">{m.uptime_pct}%</span>
								</div>
							</div>
						</div>
					{/each}
				{/if}
			</div>

			<!-- Desktop Data Table (>= 768px) -->
			<div class="hidden md:block overflow-x-auto">
				<table class="w-full text-left border-collapse">
					<thead>
						<tr class="bg-[#09090b]/50 border-b border-[#27272a] text-[11px] font-mono text-zinc-400 uppercase">
							<th class="py-3 px-4">Status</th>
							<th class="py-3 px-4">Name / Target</th>
							<th class="py-3 px-4">Group</th>
							<th class="py-3 px-4">Type</th>
							<th class="py-3 px-4 text-center">SSL</th>
							<th class="py-3 px-4">Last Check / Ping</th>
							<th class="py-3 px-4 text-center">Prio</th>
							<th class="py-3 px-4">Latency</th>
							<th class="py-3 px-4">Latency Trend</th>
							<th class="py-3 px-4">Uptime</th>
							<th class="py-3 px-4 text-right">Actions</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-[#27272a]/60 text-xs font-mono">
						{#if loading}
							<tr>
								<td colspan="10" class="p-8 text-center text-zinc-500">Loading monitor telemetry...</td>
							</tr>
						{:else if monitors.length === 0}
							<tr>
								<td colspan="10" class="p-8 text-center text-zinc-500">No monitors configured yet. Click "+ Add Monitor" above.</td>
							</tr>
						{:else}
							{#each monitors as m (m.id)}
								<tr class="hover:bg-zinc-800/30 transition-colors">
									<!-- Status Badge -->
									<td class="py-3 px-4">
										{#if m.active === 2}
											<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-950/80 border border-amber-500/40 text-amber-300 text-[10px] font-bold">
												🛠️ MAINTENANCE
											</span>
										{:else if m.active === 0}
											<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 text-[10px]">PAUSED</span>
										{:else if m.latest_status === 1}
											<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-950/80 border border-emerald-500/30 text-emerald-400 text-[10px] font-bold">
												<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> UP
											</span>
										{:else if m.latest_status === 2}
											<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-950/80 border border-amber-500/30 text-amber-400 text-[10px] font-bold">
												<span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span> DEGRADED
											</span>
										{:else}
											<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-rose-950/80 border border-rose-500/40 text-rose-400 text-[10px] font-bold">
												<span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> DOWN
											</span>
										{/if}
									</td>

									<!-- Name & Target -->
									<td class="py-3 px-4">
										<div class="font-semibold text-white font-sans flex items-center gap-1.5">
											{m.name}
											{#if m.is_public === 0}
												<span class="px-1.5 py-0.5 text-[9px] font-mono rounded bg-zinc-800 border border-zinc-700 text-zinc-400 font-bold" title="Hidden from Public Status Page">🔒 PRIVATE</span>
											{/if}
										</div>
										<div class="text-[11px] text-zinc-500 truncate max-w-xs">{m.url || 'Agent Ingestion'}</div>
									</td>

									<!-- Group Name -->
									<td class="py-3 px-4">
										<span class="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 text-[10px] font-semibold">
											{m.group_name || 'Default'}
										</span>
									</td>

									<!-- Type -->
									<td class="py-3 px-4">
										<span class="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700/80 text-[10px] uppercase text-zinc-300">
											{m.type}
										</span>
									</td>

									<!-- SSL Status Dot -->
									<td class="py-3 px-4 text-center">
										{#if m.url && m.url.startsWith('https://')}
											{#if m.ssl_days !== null && m.ssl_days !== undefined}
												{#if m.ssl_days > 14}
													<span
														class="inline-block w-3 h-3 rounded-full bg-emerald-500 hover:scale-125 transition-transform cursor-help"
														title="SSL Valid: {m.ssl_days} days remaining (Issuer: {m.ssl_issuer || 'Verified'})"
													></span>
												{:else if m.ssl_days > 0}
													<span
														class="inline-block w-3 h-3 rounded-full bg-amber-400 animate-pulse hover:scale-125 transition-transform cursor-help"
														title="SSL Warning: Only {m.ssl_days} days remaining! (Issuer: {m.ssl_issuer || 'Warning'})"
													></span>
												{:else}
													<span
														class="inline-block w-3 h-3 rounded-full bg-rose-500 hover:scale-125 transition-transform cursor-help"
														title="SSL Alert: Expired or Invalid! ({m.ssl_days} days)"
													></span>
												{/if}
											{:else}
												<span class="inline-block w-3 h-3 rounded-full bg-zinc-700 animate-pulse cursor-help" title="Checking TLS Certificate..."></span>
											{/if}
										{:else}
											<span class="inline-block w-2 h-2 rounded-full bg-zinc-800 cursor-help" title="HTTP / Non-SSL Monitor"></span>
										{/if}
									</td>

									<!-- Last Check / Ping Time -->
									<td class="py-3 px-4">
										{#if m.last_check}
											<div class="text-zinc-200 font-bold text-[11px]">{formatRelativeTime(m.last_check)}</div>
											<div class="text-[10px] text-zinc-500">{formatExactTime(m.last_check)}</div>
										{:else}
											<span class="text-zinc-600 text-[10px]">Never</span>
										{/if}
									</td>

									<!-- Pushover Priority (Compact Number Badge) -->
									<td class="py-3 px-4 text-center">
										{#if m.pushover_priority === 2}
											<span
												class="inline-flex items-center justify-center w-6 h-6 rounded bg-rose-950/80 border border-rose-500/40 text-rose-300 font-bold text-[11px] cursor-help"
												title="Priority 2 (Emergency Server: Continuous Alarm until Ack)"
											>2</span>
										{:else if m.pushover_priority === 1}
											<span
												class="inline-flex items-center justify-center w-6 h-6 rounded bg-amber-950/80 border border-amber-500/40 text-amber-300 font-bold text-[11px] cursor-help"
												title="Priority 1 (High Website: Bypasses Quiet Hours)"
											>1</span>
										{:else if m.pushover_priority === 0}
											<span
												class="inline-flex items-center justify-center w-6 h-6 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold text-[11px] cursor-help"
												title="Priority 0 (Normal Alert)"
											>0</span>
										{:else if m.pushover_priority === -1}
											<span
												class="inline-flex items-center justify-center w-6 h-6 rounded bg-zinc-900 border border-zinc-800 text-zinc-500 font-bold text-[11px] cursor-help"
												title="Priority -1 (Low Quiet Alert)"
											>-1</span>
										{:else}
											<span
												class="inline-flex items-center justify-center w-6 h-6 rounded bg-zinc-900 border border-zinc-800 text-zinc-600 font-bold text-[11px] cursor-help"
												title="Priority -2 (Lowest Silent Alert)"
											>-2</span>
										{/if}
									</td>

									<!-- Latency -->
									<td class="py-3 px-4 text-zinc-300">
										{m.latest_ping > 0 ? `${m.latest_ping}ms` : '—'}
									</td>

									<!-- Latency Trend Sparkline -->
									<td class="py-3 px-4">
										{#if m.recent_heartbeats && m.recent_heartbeats.length > 1}
											<svg class="w-24 h-6 overflow-visible" viewBox="0 0 100 24">
												<polyline
													fill="none"
													stroke="#10b981"
													stroke-width="1.5"
													points={generateSparklinePoints(m.recent_heartbeats)}
												/>
											</svg>
										{:else}
											<span class="text-zinc-600 text-[10px]">No data</span>
										{/if}
									</td>

									<!-- Uptime % -->
									<td class="py-3 px-4 font-semibold text-zinc-200">
										{m.uptime_pct}%
									</td>

									<!-- Actions Dropdown Toggle Button -->
									<td class="py-3 px-4 text-right">
										<button
											onclick={(e) => toggleRowMenu(m.id, e)}
											class="w-7 h-7 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 hover:text-white flex items-center justify-center transition-colors ml-auto text-sm font-bold"
											title="Actions menu"
										>
											⋮
										</button>
									</td>
								</tr>
							{/each}
						{/if}
					</tbody>
				</table>
			</div>
		</div>

		<!-- Snug Fixed Position Dropdown Overlay -->
		{#if activeMenuId}
			{@const activeMonitor = monitors.find((m) => m.id === activeMenuId)}
			{#if activeMonitor}
				<div
					class="fixed w-44 bg-[#09090b] border border-[#27272a] rounded-lg shadow-2xl z-50 overflow-hidden py-1 text-left m-0"
					style="top: {menuPos.top}px; right: {menuPos.right}px;"
				>
					{#if activeMonitor.type === 'agent_linux' || activeMonitor.type === 'agent_php'}
						<button
							onclick={() => openAgentInstall(activeMonitor)}
							class="w-full px-3 py-1.5 text-left hover:bg-zinc-800 text-zinc-200 text-xs flex items-center gap-2 transition-colors font-mono"
						>
							<span>🔑</span> Setup Token
						</button>
					{/if}

					<button
						onclick={() => toggleActive(activeMonitor)}
						class="w-full px-3 py-1.5 text-left hover:bg-zinc-800 text-zinc-200 text-xs flex items-center gap-2 transition-colors font-mono"
					>
						<span>{activeMonitor.active === 1 ? '⏸️' : '▶️'}</span> {activeMonitor.active === 1 ? 'Pause Service' : 'Resume Service'}
					</button>

					<button
						onclick={() => toggleMaintenanceMode(activeMonitor)}
						class="w-full px-3 py-1.5 text-left hover:bg-zinc-800 text-amber-300 text-xs flex items-center gap-2 transition-colors font-mono"
					>
						<span>🛠️</span> {activeMonitor.active === 2 ? 'Exit Maintenance' : 'Set Maintenance'}
					</button>

					<button
						onclick={() => toggleVisibilityMode(activeMonitor)}
						class="w-full px-3 py-1.5 text-left hover:bg-zinc-800 text-zinc-300 text-xs flex items-center gap-2 transition-colors font-mono"
					>
						<span>{activeMonitor.is_public === 0 ? '👁️' : '🔒'}</span> {activeMonitor.is_public === 0 ? 'Make Public' : 'Make Private'}
					</button>

					<button
						onclick={() => {
							copyShareLink();
							activeMenuId = null;
						}}
						class="w-full px-3 py-1.5 text-left hover:bg-zinc-800 text-emerald-400 text-xs flex items-center gap-2 transition-colors font-mono"
					>
						<span>🔗</span> Copy Secret Link
					</button>

					<button
						onclick={() => openEditModal(activeMonitor)}
						class="w-full px-3 py-1.5 text-left hover:bg-zinc-800 text-zinc-200 text-xs flex items-center gap-2 transition-colors font-mono"
					>
						<span>✏️</span> Edit Monitor
					</button>

					<button
						onclick={() => clearHistory(activeMonitor)}
						class="w-full px-3 py-1.5 text-left hover:bg-zinc-800 text-amber-300 text-xs flex items-center gap-2 transition-colors font-mono border-t border-zinc-800/80"
					>
						<span>🧹</span> Clear History
					</button>

					<button
						onclick={() => deleteMon(activeMonitor)}
						class="w-full px-3 py-1.5 text-left hover:bg-rose-950/80 text-rose-400 text-xs flex items-center gap-2 transition-colors font-mono border-t border-zinc-800/80"
					>
						<span>🗑️</span> Delete Service
					</button>
				</div>
			{/if}
		{/if}

		<!-- Agent Telemetry Cards Section -->
		{#if monitors.some((m) => m.type === 'agent_linux' || m.type === 'agent_php')}
			<div class="space-y-4">
				<div class="flex items-center justify-between">
					<h2 class="text-sm font-semibold text-white tracking-wide flex items-center gap-2">
						<span>🖥️</span> Agent Server Telemetry
					</h2>
				</div>

				<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
					{#each monitors.filter((m) => m.type === 'agent_linux' || m.type === 'agent_php') as m (m.id)}
						{@const metrics = m.agent_metrics}
						<button
							type="button"
							onclick={() => openTelemetryModal(m)}
							class="p-5 rounded-xl bg-[#18181b] border border-[#27272a] hover:border-emerald-500/40 transition-all cursor-pointer space-y-4 group relative text-left w-full"
						>
							<div class="flex items-center justify-between pb-3 border-b border-[#27272a]">
								<div>
									<h3 class="font-semibold text-sm text-white group-hover:text-emerald-400 transition-colors">{m.name}</h3>
									<span class="text-[10px] font-mono text-zinc-400">{metrics?.os_info || m.type}</span>
								</div>
								<div class="text-right">
									<div class="flex items-center justify-end gap-1.5">
										<span class="w-2 h-2 rounded-full {m.latest_status === 1 ? 'bg-emerald-500' : 'bg-rose-500'}"></span>
										<span class="text-xs font-mono font-bold text-white">{m.latest_status === 1 ? 'UP' : 'DOWN'}</span>
									</div>
									<div class="text-[10px] font-mono text-emerald-400 mt-0.5">
										Last ping: <strong class="text-white">{formatRelativeTime(m.last_check)}</strong>
									</div>
								</div>
							</div>

							{#if metrics}
								<!-- Detailed CPU Metrics Breakdown (User, Sys, IOWait, Steal) -->
								<div class="grid grid-cols-4 gap-1 text-[10px] font-mono p-2 rounded bg-[#09090b] border border-zinc-800 text-center">
									<div>
										<span class="block text-zinc-500 text-[9px]">USER</span>
										<span class="text-emerald-400 font-bold">{metrics.cpu_user ?? 0}%</span>
									</div>
									<div>
										<span class="block text-zinc-500 text-[9px]">SYS</span>
										<span class="text-indigo-400 font-bold">{metrics.cpu_system ?? 0}%</span>
									</div>
									<div>
										<span class="block text-zinc-500 text-[9px]">IOWAIT</span>
										<span class="text-rose-400 font-bold">{metrics.cpu_iowait ?? 0}%</span>
									</div>
									<div>
										<span class="block text-zinc-500 text-[9px] font-bold text-amber-400">STEAL</span>
										<span class="text-amber-300 font-bold">{metrics.cpu_steal ?? 0}%</span>
									</div>
								</div>

								<!-- RAM Usage Bar -->
								{#if metrics.ram_total > 0}
									{@const ramPct = Math.min(100, Math.round((metrics.ram_used / metrics.ram_total) * 100))}
									<div>
										<div class="flex justify-between text-xs font-mono mb-1">
											<span class="text-zinc-400">RAM Usage</span>
											<span class="text-zinc-200">{metrics.ram_used} / {metrics.ram_total} MB ({ramPct}%)</span>
										</div>
										<div class="w-full h-2 rounded bg-zinc-800 overflow-hidden">
											<div
												class="h-full transition-all duration-300 {ramPct > 85 ? 'bg-rose-500' : ramPct > 70 ? 'bg-amber-500' : 'bg-emerald-500'}"
												style="width: {ramPct}%;"
											></div>
										</div>
									</div>
								{/if}

								<!-- Disk Fill Bar -->
								<div>
									<div class="flex justify-between text-xs font-mono mb-1">
										<span class="text-zinc-400">Disk Fill (/)</span>
										<span class="text-zinc-200">{metrics.disk_pct}%</span>
									</div>
									<div class="w-full h-2 rounded bg-zinc-800 overflow-hidden">
										<div
											class="h-full transition-all duration-300 {metrics.disk_pct > 90 ? 'bg-rose-500' : metrics.disk_pct > 75 ? 'bg-amber-500' : 'bg-emerald-500'}"
											style="width: {metrics.disk_pct}%;"
										></div>
									</div>
								</div>

								<!-- Action Footer Trigger -->
								<div class="pt-2 border-t border-[#27272a] text-[11px] font-mono text-zinc-400 flex items-center justify-between">
									<span>Click for full CPU graphs & history</span>
									<span class="text-emerald-400 group-hover:translate-x-0.5 transition-transform">📊 Graphs →</span>
								</div>
							{:else}
								<div class="p-4 text-center text-xs text-zinc-500 font-mono">
									Awaiting agent telemetry payload...
								</div>
							{/if}
						</button>
					{/each}
				</div>
			</div>
		{/if}
	</main>
{/if}

<!-- Create / Edit Monitor Modal -->
{#if showModal}
	<div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
		<div class="w-full max-w-md bg-[#18181b] border border-[#27272a] p-6 rounded-xl shadow-2xl space-y-4">
			<div class="flex items-center justify-between pb-3 border-b border-[#27272a]">
				<h3 class="text-sm font-bold text-white tracking-wide">
					{editingMonitor ? 'Edit Monitor' : 'Create New Monitor'}
				</h3>
				<button onclick={() => (showModal = false)} class="text-zinc-500 hover:text-white">✕</button>
			</div>

			{#if formError}
				<div class="p-2.5 rounded bg-rose-950/80 border border-rose-500/40 text-rose-300 text-xs font-mono">
					{formError}
				</div>
			{/if}

			<div class="space-y-3 text-xs font-mono">
				<div>
					<label for="mon-name" class="block text-zinc-400 mb-1">MONITOR NAME</label>
					<input
						id="mon-name"
						type="text"
						bind:value={formName}
						placeholder="e.g. Production Web Server"
						class="w-full px-3 py-2 bg-[#09090b] border border-zinc-700 rounded text-white focus:outline-none focus:border-emerald-500 font-sans text-sm"
					/>
				</div>

				<div>
					<label for="mon-group" class="block text-zinc-400 mb-1">GROUP SECTION</label>
					<input
						id="mon-group"
						type="text"
						bind:value={formGroupName}
						placeholder="e.g. Websites, Servers, Mail Services, Databases"
						class="w-full px-3 py-2 bg-[#09090b] border border-zinc-700 rounded text-white focus:outline-none focus:border-emerald-500 font-sans text-sm"
					/>
					<div class="flex gap-1.5 mt-1.5">
						<button type="button" onclick={() => (formGroupName = 'Websites')} class="px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] rounded">Websites</button>
						<button type="button" onclick={() => (formGroupName = 'Servers')} class="px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] rounded">Servers</button>
						<button type="button" onclick={() => (formGroupName = 'Mail Services')} class="px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] rounded">Mail Services</button>
						<button type="button" onclick={() => (formGroupName = 'Databases')} class="px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] rounded">Databases</button>
					</div>
				</div>

				<div>
					<label for="mon-type" class="block text-zinc-400 mb-1">MONITOR TYPE</label>
					<select
						id="mon-type"
						bind:value={formType}
						class="w-full px-3 py-2 bg-[#09090b] border border-zinc-700 rounded text-white focus:outline-none focus:border-emerald-500"
					>
						<option value="http">HTTP / HTTPS Keyword Check</option>
						<option value="ping">Ping (ICMP Host Check)</option>
						<option value="agent_linux">Linux Agent Push (agent.sh)</option>
						<option value="agent_php">PHP Agent Push (agent.php)</option>
					</select>
				</div>

				<div>
					<label for="mon-prio" class="block text-zinc-400 mb-1">PUSHOVER NOTIFICATION PRIORITY</label>
					<select
						id="mon-prio"
						bind:value={formPushoverPriority}
						class="w-full px-3 py-2 bg-[#09090b] border border-zinc-700 rounded text-white focus:outline-none focus:border-emerald-500 font-sans"
					>
						<option value="1">🔔 Priority 1 (High - Websites, Bypasses Quiet Hours)</option>
						<option value="2">🚨 Priority 2 (Emergency - Servers, Continuous Alarm until Ack)</option>
						<option value="0">Priority 0 (Normal)</option>
						<option value="-1">🔕 Priority -1 (Low - Quiet)</option>
						<option value="-2">Priority -2 (Lowest - Silent)</option>
					</select>
				</div>

				{#if formType === 'http' || formType === 'ping'}
					<div>
						<label for="mon-url" class="block text-zinc-400 mb-1">TARGET URL OR IP</label>
						<input
							id="mon-url"
							type="text"
							bind:value={formUrl}
							placeholder={formType === 'http' ? 'https://example.com' : '8.8.8.8'}
							class="w-full px-3 py-2 bg-[#09090b] border border-zinc-700 rounded text-white focus:outline-none focus:border-emerald-500"
						/>
					</div>
				{/if}

				{#if formType === 'http'}
					<div>
						<label for="mon-kw" class="block text-zinc-400 mb-1">OPTIONAL KEYWORD SEARCH</label>
						<input
							id="mon-kw"
							type="text"
							bind:value={formKeyword}
							placeholder="e.g. System Normal (searches first 64KB)"
							class="w-full px-3 py-2 bg-[#09090b] border border-zinc-700 rounded text-white focus:outline-none focus:border-emerald-500"
						/>
					</div>
				{/if}

				<div>
					<label for="mon-int" class="block text-zinc-400 mb-1">CHECK INTERVAL (SECONDS)</label>
					<input
						id="mon-int"
						type="number"
						bind:value={formInterval}
						min="10"
						max="3600"
						class="w-full px-3 py-2 bg-[#09090b] border border-zinc-700 rounded text-white focus:outline-none focus:border-emerald-500"
					/>
				</div>

				<div>
					<label for="mon-retries" class="block text-zinc-400 mb-1">🔄 FAILED RETRIES BEFORE ALERT THRESHOLD</label>
					<input
						id="mon-retries"
						type="number"
						bind:value={formMaxRetries}
						min="1"
						max="20"
						class="w-full px-3 py-2 bg-[#09090b] border border-zinc-700 rounded text-white focus:outline-none focus:border-emerald-500 font-mono"
					/>
					<p class="text-[10px] text-zinc-500 mt-1 font-mono">
						Fails ≤ retries set status to <strong class="text-amber-400">DEGRADED (Silent)</strong>. Fails &gt; retries send <strong class="text-rose-400">OFFLINE Alerts</strong>. Single OK check recovers to UP.
					</p>
				</div>

				<div class="flex items-center justify-between p-2.5 rounded bg-[#09090b] border border-zinc-700 mt-2">
					<div>
						<span class="block text-zinc-200 font-semibold">👁️ Show on Public Status Page</span>
						<span class="text-[10px] text-zinc-400">If unchecked, monitor stays private in Admin only</span>
					</div>
					<input type="checkbox" bind:checked={formIsPublic} class="w-4 h-4 accent-emerald-500 cursor-pointer" />
				</div>
			</div>

			<div class="flex justify-end gap-2 pt-3 border-t border-[#27272a]">
				<button
					onclick={() => (showModal = false)}
					class="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs font-semibold"
				>
					Cancel
				</button>
				<button
					onclick={saveMonitor}
					class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-black font-semibold rounded text-xs"
				>
					Save Monitor
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Settings & Notifications Modal -->
{#if showSettingsModal}
	<div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
		<div class="w-full max-w-2xl bg-[#18181b] border border-[#27272a] p-6 rounded-xl shadow-2xl max-h-[90vh] overflow-y-auto space-y-6">
			<div class="flex items-center justify-between pb-3 border-b border-[#27272a]">
				<h3 class="text-base font-bold text-white tracking-wide flex items-center gap-2">
					<span>⚙️</span> System Settings & Authentication
				</h3>
				<button onclick={() => (showSettingsModal = false)} class="text-zinc-500 hover:text-white">✕</button>
			</div>

			{#if settingsMessage}
				<div class="p-3 rounded bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 text-xs font-mono">
					{settingsMessage}
				</div>
			{/if}
			{#if settingsError}
				<div class="p-3 rounded bg-rose-950/80 border border-rose-500/40 text-rose-300 text-xs font-mono">
					{settingsError}
				</div>
			{/if}

			<div class="space-y-6 text-xs font-mono">
				<!-- Section 0: Branding & Customization -->
				<section class="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-3">
					<h4 class="text-xs font-bold uppercase text-emerald-400 tracking-wide">Branding & Customization</h4>
					<div>
						<label for="set-logo-url" class="block text-zinc-400 mb-1">PUBLIC & ADMIN LOGO URL</label>
						<input
							id="set-logo-url"
							type="url"
							bind:value={settingsForm.logo_url}
							placeholder="https://example.com/logo.png"
							class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-white focus:outline-none"
						/>
						<p class="text-[10px] text-zinc-500 mt-1">Direct image URL (PNG, SVG, JPG) to replace the default AK badge across the status page and dashboard.</p>
					</div>
				</section>

				<!-- Section 1: Security & Authentication Options -->
				<section class="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-3">
					<h4 class="text-xs font-bold uppercase text-amber-400 tracking-wide">Security & Login Methods</h4>
					
					<div class="flex items-center justify-between p-2.5 rounded bg-[#18181b] border border-zinc-700">
						<div>
							<span class="block text-zinc-200 font-semibold">Standard Password Authentication</span>
							<span class="text-[10px] text-zinc-400">Allow logging in via standard admin password</span>
						</div>
						<label class="flex items-center gap-2 cursor-pointer">
							<input type="checkbox" bind:checked={settingsForm.password_auth_enabled} class="w-4 h-4 accent-emerald-500 cursor-pointer" />
							<span class="text-emerald-400 font-bold">{settingsForm.password_auth_enabled ? 'ENABLED' : 'DISABLED'}</span>
						</label>
					</div>
				</section>

				<!-- Section 2: Pushover Configuration -->
				<section class="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-3">
					<div class="flex items-center justify-between">
						<h4 class="text-xs font-bold uppercase text-emerald-400 tracking-wide">Pushover Push Notifications</h4>
						<label class="flex items-center gap-2 cursor-pointer text-zinc-300 text-[11px]">
							<input type="checkbox" bind:checked={settingsForm.pushover_enabled} class="w-4 h-4 accent-emerald-500 cursor-pointer" />
							<span class="text-emerald-400 font-bold">{settingsForm.pushover_enabled ? 'ENABLED' : 'DISABLED'}</span>
						</label>
					</div>

					<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
						<div>
							<label for="set-push-user" class="block text-zinc-400 mb-1">USER KEY</label>
							<input id="set-push-user" type="text" bind:value={settingsForm.pushover_user_key} placeholder="e.g. u123456789..." class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-white focus:outline-none" />
						</div>
						<div>
							<label for="set-push-token" class="block text-zinc-400 mb-1">API TOKEN / APP TOKEN</label>
							<input id="set-push-token" type="text" bind:value={settingsForm.pushover_api_token} placeholder="e.g. az123456789..." class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-white focus:outline-none" />
						</div>
					</div>

					<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
						<div>
							<label for="set-push-sound-down" class="block text-zinc-400 mb-1">🚨 DOWN / OUTAGE SOUND</label>
							<select id="set-push-sound-down" bind:value={settingsForm.pushover_sound_down} class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-white focus:outline-none font-sans">
								<option value="siren">🚨 Siren (Emergency)</option>
								<option value="falling">📉 Falling Tone</option>
								<option value="alien">👾 Alien Sound</option>
								<option value="gamelan">🔔 Gamelan Chime</option>
								<option value="spacealarm">🚀 Space Alarm</option>
								<option value="tugboat">🚢 Tug Boat</option>
								<option value="vortex">🌀 Vortex</option>
								<option value="echo">📢 Echo</option>
								<option value="mechanical">⚙️ Mechanical</option>
								<option value="pushover">📱 Pushover Default</option>
								<option value="none">🔕 Silent / No Sound</option>
							</select>
						</div>
						<div>
							<label for="set-push-sound-up" class="block text-zinc-400 mb-1">✨ UP / RESTORED SOUND</label>
							<select id="set-push-sound-up" bind:value={settingsForm.pushover_sound_up} class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-white focus:outline-none font-sans">
								<option value="magic">✨ Magic Wand (Restored)</option>
								<option value="climb">🧗 Climb (Restored)</option>
								<option value="piano_bar">🎹 Piano Bar</option>
								<option value="cashregister">💰 Cash Register</option>
								<option value="incoming">📨 Incoming</option>
								<option value="intermission">🍿 Intermission</option>
								<option value="updown">⬆️⬇️ Up Down</option>
								<option value="pushover">📱 Pushover Default</option>
								<option value="none">🔕 Silent / No Sound</option>
							</select>
						</div>
					</div>

					<div class="flex items-center justify-between pt-2">
						<button type="button" onclick={() => testNotification('pushover')} class="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded text-[11px]">
							Test Pushover Alert
						</button>
						{#if testStatus.pushover}
							<span class="text-[11px] text-zinc-300 font-semibold">{testStatus.pushover}</span>
						{/if}
					</div>
				</section>

				<!-- Section 3: Email / SMTP Configuration -->
				<section class="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-3">
					<div class="flex items-center justify-between">
						<h4 class="text-xs font-bold uppercase text-emerald-400 tracking-wide">SMTP Email Alerts</h4>
						<label class="flex items-center gap-2 cursor-pointer text-zinc-300 text-[11px]">
							<input type="checkbox" bind:checked={settingsForm.smtp_enabled} class="w-4 h-4 accent-emerald-500 cursor-pointer" />
							<span class="text-emerald-400 font-bold">{settingsForm.smtp_enabled ? 'ENABLED' : 'DISABLED'}</span>
						</label>
					</div>

					<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
						<div class="sm:col-span-2">
							<label for="set-smtp-host" class="block text-zinc-400 mb-1">SMTP HOST</label>
							<input id="set-smtp-host" type="text" bind:value={settingsForm.smtp_host} placeholder="smtp.mailgun.org or mail.yourdomain.com" class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-white focus:outline-none" />
						</div>
						<div>
							<label for="set-smtp-port" class="block text-zinc-400 mb-1">PORT</label>
							<input id="set-smtp-port" type="number" bind:value={settingsForm.smtp_port} placeholder="587" class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-white focus:outline-none" />
						</div>
					</div>

					<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
						<div>
							<label for="set-smtp-user" class="block text-zinc-400 mb-1">SMTP USERNAME</label>
							<input id="set-smtp-user" type="text" bind:value={settingsForm.smtp_user} placeholder="user@domain.com" class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-white focus:outline-none" />
						</div>
						<div>
							<label for="set-smtp-pass" class="block text-zinc-400 mb-1">SMTP PASSWORD</label>
							<input id="set-smtp-pass" type="password" bind:value={settingsForm.smtp_pass} placeholder="••••••••" class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-white focus:outline-none" />
						</div>
					</div>

					<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
						<div>
							<label for="set-smtp-from" class="block text-zinc-400 mb-1">SENDER EMAIL (FROM)</label>
							<input id="set-smtp-from" type="text" bind:value={settingsForm.smtp_from} placeholder="akmon-alerts@domain.com" class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-white focus:outline-none" />
						</div>
						<div>
							<label for="set-smtp-to" class="block text-zinc-400 mb-1">RECIPIENT EMAIL (TO)</label>
							<input id="set-smtp-to" type="text" bind:value={settingsForm.smtp_to} placeholder="admin@domain.com" class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-white focus:outline-none" />
						</div>
					</div>

					<div class="flex items-center justify-between pt-2">
						<button type="button" onclick={() => testNotification('email')} class="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded text-[11px]">
							Test Email Alert
						</button>
						{#if testStatus.email}
							<span class="text-[11px] text-zinc-300 font-semibold">{testStatus.email}</span>
						{/if}
					</div>
				</section>

				<!-- Section 4: PocketID OIDC Configuration -->
				<section class="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-3">
					<div class="flex items-center justify-between">
						<h4 class="text-xs font-bold uppercase text-indigo-400 tracking-wide">PocketID OpenID Connect (OIDC)</h4>
						<label class="flex items-center gap-2 cursor-pointer text-zinc-300 text-[11px]">
							<input type="checkbox" bind:checked={settingsForm.oidc_enabled} class="w-4 h-4 accent-indigo-500 cursor-pointer" />
							<span class="text-indigo-400 font-bold">{settingsForm.oidc_enabled ? 'ENABLED' : 'DISABLED'}</span>
						</label>
					</div>

					<div>
						<label for="set-oidc-issuer" class="block text-zinc-400 mb-1">POCKETID ISSUER URL</label>
						<input id="set-oidc-issuer" type="text" bind:value={settingsForm.oidc_issuer} placeholder="https://pocketid.example.com" class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-white focus:outline-none" />
					</div>

					<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
						<div>
							<label for="set-oidc-client" class="block text-zinc-400 mb-1">CLIENT ID</label>
							<input id="set-oidc-client" type="text" bind:value={settingsForm.oidc_client_id} placeholder="akmon-client-id" class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-white focus:outline-none" />
						</div>
						<div>
							<label for="set-oidc-secret" class="block text-zinc-400 mb-1">CLIENT SECRET</label>
							<input id="set-oidc-secret" type="password" bind:value={settingsForm.oidc_client_secret} placeholder="••••••••" class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-white focus:outline-none" />
						</div>
					</div>
				</section>

				<!-- Section 5: Secret Private Status Access Link -->
				<section class="p-4 rounded-lg bg-[#09090b] border border-zinc-800 space-y-3">
					<div class="flex items-center justify-between">
						<h4 class="text-xs font-bold uppercase text-emerald-400 tracking-wide flex items-center gap-1.5">
							<span>🔗</span> Private Monitors Secret Access Link
						</h4>
						<span class="px-2 py-0.5 rounded bg-emerald-950/80 text-emerald-400 text-[10px] font-mono font-bold border border-emerald-500/30">
							64-Char Token Active
						</span>
					</div>
					<p class="text-[11px] text-zinc-400">
						Share this secret link with trusted clients or team members. Anyone with this link can view both public AND private monitors without logging in.
					</p>

					<div>
						<label for="share-access-link" class="block text-zinc-400 text-[10px] mb-1 font-mono">SECRET ACCESS URL (INCLUDES TOKEN)</label>
						<div class="flex items-center gap-2">
							<input
								id="share-access-link"
								type="text"
								readonly
								value={getPrivateShareUrl()}
								class="w-full px-3 py-2 bg-[#18181b] border border-zinc-700 rounded text-emerald-400 font-mono text-xs select-all focus:outline-none"
							/>
							<button
								type="button"
								onclick={copyShareLink}
								class="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-black font-bold rounded text-xs whitespace-nowrap flex-shrink-0 transition-colors"
							>
								{shareTokenCopied ? '✅ Copied!' : '📋 Copy Link'}
							</button>
						</div>
					</div>

					<div class="flex justify-end pt-1">
						<button
							type="button"
							onclick={regenerateShareToken}
							class="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[11px] font-mono flex items-center gap-1.5 transition-colors"
						>
							<span>🔄</span> Regenerate 64-Char Token
						</button>
					</div>
				</section>
			</div>

			<div class="flex justify-end gap-2 pt-3 border-t border-[#27272a]">
				<button onclick={() => (showSettingsModal = false)} class="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs font-semibold">
					Close
				</button>
				<button onclick={saveSettings} class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-black font-semibold rounded text-xs">
					Save Settings
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Agent Token & 1-Click Installation Snippet Modal -->
{#if showAgentModal && selectedAgentMonitor}
	<div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
		<div class="w-full max-w-xl bg-[#18181b] border border-[#27272a] p-6 rounded-xl shadow-2xl space-y-4">
			<div class="flex items-center justify-between pb-3 border-b border-[#27272a]">
				<h3 class="text-sm font-bold text-white tracking-wide">
					Agent Setup: {selectedAgentMonitor.name}
				</h3>
				<button onclick={() => (showAgentModal = false)} class="text-zinc-500 hover:text-white">✕</button>
			</div>

			<div class="space-y-4 text-xs font-mono">
				<div>
					<span class="block text-zinc-400 mb-1">AGENT INGESTION TOKEN</span>
					<div class="p-2.5 rounded bg-[#09090b] border border-zinc-700 text-emerald-400 select-all font-bold">
						{selectedAgentMonitor.token}
					</div>
				</div>

				{#if selectedAgentMonitor.type === 'agent_linux'}
					<div>
						<label for="agent-cmd-linux" class="block text-zinc-400 mb-1">1-CLICK LINUX INSTALL COMMAND (curl + bash)</label>
						<textarea
							id="agent-cmd-linux"
							readonly
							rows="3"
							class="w-full p-2.5 rounded bg-[#09090b] border border-zinc-700 text-zinc-200 select-all text-[11px] focus:outline-none"
						>{getLinuxCommand(selectedAgentMonitor)}</textarea>
						<p class="text-[10px] text-zinc-500 mt-1">Run this command on your Linux server or add to crontab (`* * * * *`).</p>
					</div>
				{:else}
					<div>
						<label for="agent-cmd-php" class="block text-zinc-400 mb-1">SHARED HOSTING PHP RUN COMMAND</label>
						<textarea
							id="agent-cmd-php"
							readonly
							rows="3"
							class="w-full p-2.5 rounded bg-[#09090b] border border-zinc-700 text-zinc-200 select-all text-[11px] focus:outline-none"
						>{getPhpSnippet(selectedAgentMonitor)}</textarea>
					</div>
				{/if}
			</div>

			<div class="flex justify-end pt-3 border-t border-[#27272a]">
				<button
					onclick={() => (showAgentModal = false)}
					class="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs font-semibold"
				>
					Close
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- In-Depth Agent Telemetry Analytics Modal -->
{#if showTelemetryModal && selectedTelemetryMonitor}
	{@const m = selectedTelemetryMonitor}
	{@const metrics = m.agent_metrics || {}}
	{@const heartbeats = m.recent_heartbeats || []}
	<div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
		<div class="w-full max-w-4xl bg-[#18181b] border border-[#27272a] p-6 rounded-xl shadow-2xl max-h-[90vh] overflow-y-auto space-y-6">
			<!-- Modal Header & Server Selector -->
			<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#27272a]">
				<div>
					<div class="flex items-center gap-2">
						<span class="w-2.5 h-2.5 rounded-full {m.latest_status === 1 ? 'bg-emerald-500' : 'bg-rose-500'}"></span>
						<h3 class="text-base font-bold text-white tracking-wide">{m.name}</h3>
						<span class="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono text-[10px] uppercase">{m.type}</span>
					</div>
					<p class="text-xs font-mono text-zinc-400 mt-1">{metrics.os_info || 'Linux Operating System'}</p>
				</div>

				<!-- Server Switcher Dropdown (if multiple agents exist) -->
				<div class="flex items-center gap-2">
					<select
						bind:value={selectedTelemetryMonitor}
						class="px-3 py-1.5 bg-[#09090b] border border-zinc-700 rounded text-xs text-white font-mono focus:outline-none"
					>
						{#each monitors.filter((mon) => mon.type === 'agent_linux' || mon.type === 'agent_php') as agentMon}
							<option value={agentMon}>{agentMon.name}</option>
						{/each}
					</select>
					<button onclick={() => (showTelemetryModal = false)} class="text-zinc-500 hover:text-white px-2 text-lg">✕</button>
				</div>
			</div>

			<!-- Live Summary Cards Grid -->
			<div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5 font-mono">
				<div class="p-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-center">
					<span class="block text-[9px] text-emerald-400 font-bold">CPU USER</span>
					<span class="text-base font-bold text-white mt-0.5">{metrics.cpu_user ?? 0}%</span>
				</div>
				<div class="p-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-center">
					<span class="block text-[9px] text-indigo-400 font-bold">CPU SYS</span>
					<span class="text-base font-bold text-white mt-0.5">{metrics.cpu_system ?? 0}%</span>
				</div>
				<div class="p-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-center">
					<span class="block text-[9px] text-rose-400 font-bold">CPU IOWAIT</span>
					<span class="text-base font-bold text-white mt-0.5">{metrics.cpu_iowait ?? 0}%</span>
				</div>
				<div class="p-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-center {metrics.cpu_steal > 0 ? 'bg-amber-950/40 border-amber-500/40' : ''}">
					<span class="block text-[9px] text-amber-400 font-bold">CPU STEAL</span>
					<span class="text-base font-bold {metrics.cpu_steal > 0 ? 'text-amber-300 animate-pulse' : 'text-zinc-300'}">{metrics.cpu_steal ?? 0}%</span>
				</div>
				<div class="p-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-center">
					<span class="block text-[9px] text-emerald-400 font-bold">NET IN (RX)</span>
					<span class="text-sm font-bold text-emerald-400 mt-0.5">{formatSpeed(metrics.net_rx_kbps)}</span>
				</div>
				<div class="p-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-center">
					<span class="block text-[9px] text-indigo-400 font-bold">NET OUT (TX)</span>
					<span class="text-sm font-bold text-indigo-400 mt-0.5">{formatSpeed(metrics.net_tx_kbps)}</span>
				</div>
				<div class="p-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-center">
					<span class="block text-[9px] text-zinc-400 font-bold">RAM UTIL</span>
					<span class="text-base font-bold text-zinc-200">{metrics.ram_total > 0 ? Math.round((metrics.ram_used / metrics.ram_total) * 100) : 0}%</span>
				</div>
				<div class="p-2.5 rounded-lg bg-[#09090b] border border-zinc-800 text-center">
					<span class="block text-[9px] text-zinc-500 font-bold">SWAP UTIL</span>
					<span class="text-base font-bold text-zinc-400">{metrics.swap_total > 0 ? Math.round((metrics.swap_used / metrics.swap_total) * 100) : 0}%</span>
				</div>
			</div>

			{#if metrics.cpu_steal > 0}
				<div class="p-3 rounded-lg bg-amber-950/40 border border-amber-500/30 text-amber-300 text-xs font-mono flex items-center gap-2">
					<span class="text-base">⚠️</span>
					<span><strong>Hypervisor CPU Steal Detected ({metrics.cpu_steal}%):</strong> Your cloud VPS host is robbing CPU cycles from your instance. Consider upgrading CPU allocation.</span>
				</div>
			{/if}

			<!-- Graph 1: Detailed CPU Breakdown Over Time -->
			<div class="p-4 rounded-xl bg-[#09090b] border border-zinc-800 space-y-3">
				<div class="flex items-center justify-between">
					<h4 class="text-xs font-bold font-mono text-zinc-200 uppercase tracking-wide">
						📈 CPU Usage History Breakdown (Last 60 Check-ins)
					</h4>
					<div class="flex items-center gap-3 text-[10px] font-mono">
						<span class="flex items-center gap-1 text-emerald-400"><span class="w-2 h-2 rounded bg-emerald-500"></span> User</span>
						<span class="flex items-center gap-1 text-indigo-400"><span class="w-2 h-2 rounded bg-indigo-500"></span> System</span>
						<span class="flex items-center gap-1 text-rose-400"><span class="w-2 h-2 rounded bg-rose-500"></span> IOWait</span>
						<span class="flex items-center gap-1 text-amber-400"><span class="w-2 h-2 rounded bg-amber-500"></span> Steal</span>
					</div>
				</div>

				<div class="relative w-full h-40 bg-[#18181b]/60 rounded-lg p-2 border border-zinc-800 flex items-center justify-center">
					{#if heartbeats && heartbeats.length > 1}
						<svg class="w-full h-full overflow-visible" viewBox="0 0 500 120" preserveAspectRatio="none">
							<line x1="0" y1="30" x2="500" y2="30" stroke="#27272a" stroke-dasharray="3 3" stroke-width="1" />
							<line x1="0" y1="60" x2="500" y2="60" stroke="#27272a" stroke-dasharray="3 3" stroke-width="1" />
							<line x1="0" y1="90" x2="500" y2="90" stroke="#27272a" stroke-dasharray="3 3" stroke-width="1" />

							<polyline fill="none" stroke="#10b981" stroke-width="2" points={generateCpuPath(heartbeats, 'cpu_user')} />
							<polyline fill="none" stroke="#6366f1" stroke-width="2" points={generateCpuPath(heartbeats, 'cpu_system')} />
							<polyline fill="none" stroke="#f43f5e" stroke-width="2" points={generateCpuPath(heartbeats, 'cpu_iowait')} />
							<polyline fill="none" stroke="#f59e0b" stroke-width="2.5" points={generateCpuPath(heartbeats, 'cpu_steal')} />
						</svg>
					{:else}
						<span class="text-xs font-mono text-zinc-500">Awaiting multiple agent heartbeat checks for historical CPU trend...</span>
					{/if}
				</div>
			</div>

			<!-- Graph 2: Network Bandwidth Traffic History (Inbound vs Outbound KB/s) -->
			<div class="p-4 rounded-xl bg-[#09090b] border border-zinc-800 space-y-3">
				<div class="flex items-center justify-between">
					<h4 class="text-xs font-bold font-mono text-zinc-200 uppercase tracking-wide">
						🌐 Network Bandwidth Traffic (Rx / Tx Throughput)
					</h4>
					<div class="flex items-center gap-3 text-[10px] font-mono">
						<span class="flex items-center gap-1 text-emerald-400"><span class="w-2 h-2 rounded bg-emerald-500"></span> Inbound (Rx): {formatSpeed(metrics.net_rx_kbps)}</span>
						<span class="flex items-center gap-1 text-indigo-400"><span class="w-2 h-2 rounded bg-indigo-500"></span> Outbound (Tx): {formatSpeed(metrics.net_tx_kbps)}</span>
					</div>
				</div>

				<div class="relative w-full h-36 bg-[#18181b]/60 rounded-lg p-2 border border-zinc-800 flex items-center justify-center">
					{#if heartbeats && heartbeats.length > 1}
						<svg class="w-full h-full overflow-visible" viewBox="0 0 500 120" preserveAspectRatio="none">
							<line x1="0" y1="40" x2="500" y2="40" stroke="#27272a" stroke-dasharray="3 3" stroke-width="1" />
							<line x1="0" y1="80" x2="500" y2="80" stroke="#27272a" stroke-dasharray="3 3" stroke-width="1" />

							<polyline fill="none" stroke="#10b981" stroke-width="2" points={generateNetPath(heartbeats, 'net_rx_kbps')} />
							<polyline fill="none" stroke="#6366f1" stroke-width="2" points={generateNetPath(heartbeats, 'net_tx_kbps')} />
						</svg>
					{:else}
						<span class="text-xs font-mono text-zinc-500">Awaiting network traffic telemetry...</span>
					{/if}
				</div>
			</div>

			<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
				<!-- Graph 3: System Load Averages (1m, 5m, 15m) -->
				<div class="p-4 rounded-xl bg-[#09090b] border border-zinc-800 space-y-3">
					<div class="flex items-center justify-between">
						<h4 class="text-xs font-bold font-mono text-zinc-200 uppercase tracking-wide">
							📊 System Load Averages (1m, 5m, 15m)
						</h4>
						<span class="text-[10px] font-mono text-zinc-400">Latest: {metrics.load ? metrics.load.join(', ') : '0, 0, 0'}</span>
					</div>

					<div class="relative w-full h-32 bg-[#18181b]/60 rounded-lg p-2 border border-zinc-800 flex items-center justify-center">
						{#if heartbeats && heartbeats.length > 1}
							<svg class="w-full h-full overflow-visible" viewBox="0 0 500 120" preserveAspectRatio="none">
								<polyline fill="none" stroke="#10b981" stroke-width="2" points={generateLoadPath(heartbeats, 0)} />
								<polyline fill="none" stroke="#f59e0b" stroke-width="1.5" points={generateLoadPath(heartbeats, 1)} />
								<polyline fill="none" stroke="#3b82f6" stroke-width="1.5" points={generateLoadPath(heartbeats, 2)} />
							</svg>
						{:else}
							<span class="text-xs font-mono text-zinc-500">Awaiting data...</span>
						{/if}
					</div>
				</div>

				<!-- Graph 4: RAM & Swap Memory Utilization -->
				<div class="p-4 rounded-xl bg-[#09090b] border border-zinc-800 space-y-3">
					<div class="flex items-center justify-between">
						<h4 class="text-xs font-bold font-mono text-zinc-200 uppercase tracking-wide">
							💾 RAM & Swap Memory Trend
						</h4>
						<div class="flex items-center gap-2 text-[10px] font-mono">
							<span class="text-emerald-400">RAM: {metrics.ram_used || 0}/{metrics.ram_total || 0} MB</span>
							<span class="text-amber-400">Swap: {metrics.swap_used || 0}/{metrics.swap_total || 0} MB</span>
						</div>
					</div>

					<div class="relative w-full h-32 bg-[#18181b]/60 rounded-lg p-2 border border-zinc-800 flex items-center justify-center">
						{#if heartbeats && heartbeats.length > 1}
							<svg class="w-full h-full overflow-visible" viewBox="0 0 500 120" preserveAspectRatio="none">
								<polyline fill="none" stroke="#10b981" stroke-width="2" points={generateRamPath(heartbeats)} />
								<polyline fill="none" stroke="#f59e0b" stroke-width="1.5" points={generateSwapPath(heartbeats)} />
							</svg>
						{:else}
							<span class="text-xs font-mono text-zinc-500">Awaiting data...</span>
						{/if}
					</div>
				</div>
			</div>

			<div class="flex justify-end pt-3 border-t border-[#27272a]">
				<button
					onclick={() => (showTelemetryModal = false)}
					class="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs font-semibold"
				>
					Close Analytics
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Custom Client Status Pages Modal -->
{#if showStatusPagesModal}
	<div class="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
		<div class="bg-[#18181b] border border-[#27272a] rounded-xl max-w-2xl w-full p-6 space-y-6 shadow-2xl max-h-[90vh] overflow-y-auto">
			<div class="flex items-center justify-between border-b border-[#27272a] pb-4">
				<div class="flex items-center gap-2">
					<span class="text-xl">🔗</span>
					<div>
						<h3 class="text-lg font-bold text-white">Custom Client Status Pages</h3>
						<p class="text-xs text-zinc-400 font-mono">Create shareable status pages with selected public & private monitors</p>
					</div>
				</div>
				<button onclick={() => (showStatusPagesModal = false)} class="text-zinc-400 hover:text-white text-lg">✕</button>
			</div>

			<!-- Tabs -->
			<div class="flex border-b border-zinc-800 gap-4 text-xs font-mono">
				<button
					onclick={() => (statusPagesTab = 'create')}
					class="pb-2 border-b-2 transition-colors {statusPagesTab === 'create' ? 'border-emerald-500 text-emerald-400 font-bold' : 'border-transparent text-zinc-400 hover:text-white'}"
				>
					✨ Create New Client Link
				</button>
				<button
					onclick={() => { statusPagesTab = 'manage'; loadStatusPages(); }}
					class="pb-2 border-b-2 transition-colors {statusPagesTab === 'manage' ? 'border-emerald-500 text-emerald-400 font-bold' : 'border-transparent text-zinc-400 hover:text-white'}"
				>
					📋 Existing Client Pages ({statusPagesList.length})
				</button>
			</div>

			{#if statusPagesTab === 'create'}
				<div class="space-y-4">
					{#if statusPageCreateError}
						<div class="p-3 bg-rose-950/80 border border-rose-500/40 text-rose-300 rounded text-xs font-mono">
							⚠️ {statusPageCreateError}
						</div>
					{/if}

					<div>
						<label for="page-title-input" class="block text-xs font-mono text-zinc-400 mb-1">CLIENT PAGE TITLE</label>
						<input
							id="page-title-input"
							type="text"
							bind:value={newPageTitle}
							placeholder="e.g. Acme Corp Infrastructure Status"
							class="w-full px-3 py-2 bg-[#09090b] border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-emerald-500 font-mono"
						/>
					</div>

					<div class="space-y-2">
						<div class="flex items-center justify-between">
							<span class="block text-xs font-mono text-zinc-400">SELECT MONITORS TO INCLUDE (PUBLIC & PRIVATE)</span>
							<div class="flex gap-2 text-[10px] font-mono">
								<button type="button" onclick={() => (selectedMonitorIdsForPage = monitors.map(m => m.id))} class="text-emerald-400 hover:underline">Select All</button>
								<span class="text-zinc-600">|</span>
								<button type="button" onclick={() => (selectedMonitorIdsForPage = [])} class="text-zinc-400 hover:underline">Deselect All</button>
							</div>
						</div>

						<div class="max-h-60 overflow-y-auto border border-zinc-800 rounded bg-[#09090b] divide-y divide-zinc-800/60">
							{#each monitors as m}
								<label class="flex items-center justify-between p-2.5 hover:bg-zinc-800/50 cursor-pointer text-xs font-mono">
									<div class="flex items-center gap-3">
										<input
											type="checkbox"
											checked={selectedMonitorIdsForPage.includes(m.id)}
											onchange={() => toggleMonitorSelectionForPage(m.id)}
											class="w-4 h-4 accent-emerald-500 cursor-pointer"
										/>
										<span class="text-white font-bold">{m.name}</span>
										<span class="text-[10px] text-zinc-500">({m.group_name || 'Default'})</span>
									</div>
									<span class="px-2 py-0.5 rounded text-[10px] font-bold {m.is_public !== 0 ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/30' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}">
										{m.is_public !== 0 ? '🌐 Public' : '🔒 Private'}
									</span>
								</label>
							{/each}
						</div>
					</div>

					<div class="flex justify-end gap-2 pt-2">
						<button onclick={() => (showStatusPagesModal = false)} class="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs font-semibold">
							Cancel
						</button>
						<button onclick={createClientStatusPage} class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-black font-bold rounded text-xs">
							✨ Generate Client Link (64-Char Token)
						</button>
					</div>
				</div>
			{:else}
				<!-- Manage Tab -->
				<div class="space-y-4">
					{#if statusPagesList.length === 0}
						<div class="p-8 text-center text-zinc-500 font-mono text-xs border border-dashed border-zinc-800 rounded">
							No custom status pages created yet. Click "✨ Create New Client Link" above.
						</div>
					{:else}
						<div class="space-y-3">
							{#each statusPagesList as p}
								<div class="p-4 bg-[#09090b] border border-zinc-800 rounded-lg space-y-3">
									<div class="flex items-center justify-between">
										<div>
											<h4 class="text-sm font-bold text-white">{p.title}</h4>
											<p class="text-[10px] text-zinc-400 font-mono">
												Includes {p.monitor_ids.length} monitors • Created {formatRelativeTime(p.created_at)}
											</p>
										</div>
										<button
											onclick={() => deleteClientStatusPage(p.id)}
											class="px-2.5 py-1 bg-rose-950/60 hover:bg-rose-900 border border-rose-500/40 text-rose-300 text-[11px] rounded font-mono transition-colors"
										>
											🗑️ Revoke Link
										</button>
									</div>

									<div class="flex items-center gap-2">
										<input
											type="text"
											readonly
											value={getCustomPageUrl(p.id)}
											class="w-full px-3 py-1.5 bg-[#18181b] border border-zinc-700 rounded text-emerald-400 font-mono text-xs select-all focus:outline-none"
										/>
										<button
											onclick={() => copyCustomPageUrl(p.id)}
											class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-black font-bold rounded text-xs whitespace-nowrap flex-shrink-0 transition-colors"
										>
											{statusPageCopiedId === p.id ? '✅ Copied!' : '📋 Copy URL'}
										</button>
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}
