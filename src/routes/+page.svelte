<script>
	import { onMount } from 'svelte';

	let statusData = $state({ monitors: [] });
	let loading = $state(true);
	let error = $state(null);
	let activeTab = $state('all');
	let logoLoaded = $state(false);

	// Group Monitors by section
	let groups = $derived.by(() => {
		const map = {};
		const monitors = statusData.monitors || [];

		for (const m of monitors) {
			const groupName = m.group_name || 'Default';
			if (!map[groupName]) {
				map[groupName] = [];
			}
			map[groupName].push(m);
		}

		return map;
	});

	let groupKeys = $derived(Object.keys(groups));

	function parseDate(dateStr) {
		if (!dateStr) return null;
		let str = String(dateStr).trim();
		if (!str.endsWith('Z') && !str.includes('+') && !str.includes('GMT')) {
			str = str.replace(' ', 'T') + 'Z';
		}
		const d = new Date(str);
		return isNaN(d.getTime()) ? new Date(dateStr) : d;
	}

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

	let shareToken = $state('');

	async function fetchStatus() {
		try {
			const url = shareToken ? `/api/v1/public/status?token=${encodeURIComponent(shareToken)}` : '/api/v1/public/status';
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			statusData = data;
			error = null;
		} catch (err) {
			error = err.message || 'Failed to load status data';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		if (typeof window !== 'undefined') {
			const params = new URLSearchParams(window.location.search);
			shareToken = params.get('token') || '';
		}
		fetchStatus();
		const interval = setInterval(fetchStatus, 10000);
		return () => clearInterval(interval);
	});

	function getOverallStatusText() {
		const monitors = statusData.monitors || [];
		if (monitors.length === 0) return { text: 'No Services Monitored', color: 'text-zinc-400', bg: 'bg-zinc-800' };
		const isDown = monitors.some((m) => m.status === 0);
		if (isDown) return { text: 'Some Systems Experiencing Outages', color: 'text-rose-400', bg: 'bg-rose-500/10 border-rose-500/20' };
		const isDegraded = monitors.some((m) => m.status === 2);
		if (isDegraded) return { text: 'Degraded Performance Detected', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' };
		const isMaintenance = monitors.some((m) => m.status === 3 || m.in_maintenance);
		if (isMaintenance) return { text: 'Systems Operational (Scheduled Maintenance)', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' };
		return { text: 'All Systems Operational', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' };
	}
</script>

<div class="w-full max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
	<!-- Hero / Status Banner -->
	<header class="space-y-4">
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-3">
				<!-- Zero-Shift Preloader Logo Container -->
				<div class="relative flex items-center min-w-[40px] h-10">
					{#if loading || (statusData.logo_url && !logoLoaded)}
						<div class="animate-pulse bg-zinc-800/80 border border-zinc-700/50 rounded-lg w-28 h-10 flex items-center justify-center text-[10px] font-mono text-zinc-400 px-2">
							<span class="inline-block animate-spin w-3 h-3 border border-emerald-500 border-t-transparent rounded-full mr-1.5 flex-shrink-0"></span>
							<span>Loading...</span>
						</div>
					{/if}

					{#if statusData.logo_url && statusData.logo_url.trim() !== ''}
						<img
							src={statusData.logo_url}
							alt="Logo"
							onload={() => (logoLoaded = true)}
							onerror={() => (logoLoaded = true)}
							class="h-10 w-auto max-w-[180px] object-contain rounded-lg transition-opacity duration-300 {logoLoaded ? 'opacity-100' : 'opacity-0 absolute inset-0 pointer-events-none'}"
						/>
					{:else if !loading}
						<div class="w-10 h-10 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-mono font-bold flex-shrink-0">
							AK
						</div>
					{/if}
				</div>

				<div>
					<h1 class="text-xl font-bold text-white tracking-wide">Infrastructure Status</h1>
					<p class="text-xs text-zinc-400 font-mono">Uptime & Performance Monitoring</p>
				</div>
			</div>
			<div class="flex items-center gap-3">
				{#if shareToken}
					<span class="px-2.5 py-1 rounded-full bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 text-xs font-mono font-bold flex items-center gap-1.5 shadow-lg" title="Viewing private monitors via secret share token">
						🔒 Private Access Enabled
					</span>
				{/if}
				<a href="/admin" class="text-xs text-zinc-400 hover:text-white font-mono underline">Admin Login →</a>
			</div>
		</div>

		{#if !loading && !error}
			{@const overall = getOverallStatusText()}
			<div class="p-4 rounded-xl border flex items-center justify-between {overall.bg}">
				<div class="flex items-center gap-3">
					<span class="relative flex h-3 w-3">
						<span class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 {overall.color === 'text-emerald-400' ? 'bg-emerald-400' : 'bg-rose-400'}"></span>
						<span class="relative inline-flex rounded-full h-3 w-3 {overall.color === 'text-emerald-400' ? 'bg-emerald-500' : 'bg-rose-500'}"></span>
					</span>
					<span class="font-semibold text-sm tracking-wide {overall.color}">{overall.text}</span>
				</div>
				<span class="text-xs text-zinc-500 font-mono">Auto Refreshing (10s)</span>
			</div>
		{/if}
	</header>

	<!-- Main Content -->
	{#if loading}
		<div class="p-12 text-center text-zinc-500 font-mono">
			<div class="inline-block animate-spin w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full mb-2"></div>
			<p>Loading status data...</p>
		</div>
	{:else if error}
		<div class="p-4 rounded-xl bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs font-mono">
			Error: {error}
		</div>
	{:else}
		<!-- Group Navigation Tabs -->
		{#if groupKeys.length > 1}
			<div class="flex border-b border-[#27272a] gap-2">
				<button
					onclick={() => (activeTab = 'all')}
					class="pb-2 px-3 text-xs font-mono transition-colors border-b-2 font-semibold {activeTab === 'all' ? 'border-emerald-500 text-white' : 'border-transparent text-zinc-400 hover:text-zinc-200'}"
				>
					All ({statusData.monitors.length})
				</button>
				{#each groupKeys as groupName}
					<button
						onclick={() => (activeTab = groupName)}
						class="pb-2 px-3 text-xs font-mono transition-colors border-b-2 font-semibold {activeTab === groupName ? 'border-emerald-500 text-white' : 'border-transparent text-zinc-400 hover:text-zinc-200'}"
					>
						{groupName} ({groups[groupName].length})
					</button>
				{/each}
			</div>
		{/if}

		<!-- Group Sections -->
		<div class="space-y-8">
			{#each groupKeys as groupName (groupName)}
				{#if activeTab === 'all' || activeTab === groupName}
					{@const groupMonitors = groups[groupName]}
					<section class="space-y-4">
						<div class="flex items-center justify-between pb-2 border-b border-[#27272a]">
							<h2 class="text-sm font-bold text-white tracking-wide flex items-center gap-2">
								<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
								{groupName}
							</h2>
							<div class="text-xs font-mono text-zinc-400">
								{groupMonitors.filter((m) => m.status === 1).length} / {groupMonitors.length} Operational
							</div>
						</div>

						<div class="space-y-3">
							{#each groupMonitors as m (m.id)}
								<div class="p-4 rounded-xl bg-[#18181b] border border-[#27272a] hover:border-zinc-700/80 transition-all space-y-3 w-full">
									<div class="flex items-center justify-between">
										<div class="flex items-center gap-3">
											<span class="w-2.5 h-2.5 rounded-full {m.status === 3 || m.in_maintenance ? 'bg-amber-400 animate-pulse' : m.status === 1 ? 'bg-emerald-500' : m.status === 2 ? 'bg-amber-500' : 'bg-rose-500'}"></span>
											<span class="font-semibold text-sm text-white tracking-wide">{m.name}</span>
											{#if m.status === 3 || m.in_maintenance}
												<span class="px-2 py-0.5 rounded bg-amber-950/80 border border-amber-500/40 text-amber-300 text-[10px] font-bold font-mono">🛠️ MAINTENANCE</span>
											{:else}
												<span class="text-xs text-zinc-500 font-mono">({m.type})</span>
											{/if}
										</div>
										<div class="flex items-center gap-4 text-xs font-mono">
											{#if m.ssl_days !== null && m.ssl_days !== undefined}
												<span class="text-zinc-400">
													SSL: <strong class="{m.ssl_days > 14 ? 'text-emerald-400' : 'text-amber-400'}">{m.ssl_days}d left</strong>
												</span>
											{/if}
											<span class="text-zinc-400">
												Last ping: <strong class="text-zinc-200">{m.status === 3 || m.in_maintenance ? 'Paused (Maintenance)' : formatRelativeTime(m.last_check)}</strong>
											</span>
											{#if m.ping_ms > 0 && m.status !== 3 && !m.in_maintenance}
												<span class="text-zinc-400">Latency: <strong class="text-zinc-200">{m.ping_ms}ms</strong></span>
											{/if}
											<span class="font-bold {m.uptime_pct >= 99 ? 'text-emerald-400' : m.uptime_pct >= 95 ? 'text-amber-400' : 'text-rose-400'}">
												{m.uptime_pct}% Uptime
											</span>
										</div>
									</div>

									<!-- 60 Segment Health Bar (Full Width Flexbox) -->
									<div class="space-y-1.5 w-full">
										<div class="flex gap-1 h-7 w-full">
											{#each m.segments || [] as seg, i}
												<div
													class="flex-1 rounded-sm transition-all hover:scale-110 relative group min-w-0 {seg.status === 3 ? 'bg-amber-400/80' : seg.status === 1 ? 'bg-emerald-500' : seg.status === 0 ? 'bg-rose-500' : seg.status === 2 ? 'bg-amber-500' : 'bg-zinc-800'}"
												>
													<!-- Tooltip -->
													<div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 pointer-events-none">
														<div class="bg-[#09090b] border border-zinc-700 text-white text-[10px] font-mono px-2 py-1 rounded shadow-xl whitespace-nowrap">
															<div>{seg.time ? new Date(seg.time).toLocaleTimeString() : 'No Check'}</div>
															<div class="text-zinc-400">{seg.status === 3 ? '🛠️ MAINTENANCE' : seg.status === 1 ? `UP (${seg.ping_ms}ms)` : seg.status === 0 ? 'DOWN' : 'No Data'}</div>
														</div>
													</div>
												</div>
											{/each}
										</div>

										<div class="flex justify-between text-[10px] font-mono text-zinc-500">
											<span>60 checks ago</span>
											<span>Recently</span>
										</div>
									</div>
								</div>
							{/each}
						</div>
					</section>
				{/if}
			{/each}
		</div>
	{/if}
</div>
