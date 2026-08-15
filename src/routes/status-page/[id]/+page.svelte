<script>
	import { onMount } from 'svelte';
	import { page } from '$app/state';

	let statusData = $state({ title: 'Client Status Portal', monitors: [] });
	let loading = $state(true);
	let error = $state(null);
	let activeTab = $state('all');
	let logoLoaded = $state(false);

	let pageId = $derived(page.params.id);

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

	async function fetchStatusPage() {
		if (!pageId) return;
		try {
			const res = await fetch(`/api/v1/public/status-page/${pageId}`);
			if (!res.ok) {
				if (res.status === 404) throw new Error('Status page not found or access revoked');
				throw new Error(`HTTP ${res.status}`);
			}
			const data = await res.json();
			statusData = data;
			error = null;
		} catch (err) {
			error = err.message || 'Failed to load client status page';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		fetchStatusPage();
		const interval = setInterval(fetchStatusPage, 10000);
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

<svelte:head>
	<title>{statusData.title || 'Client Status Page'} | akMon</title>
</svelte:head>

<div class="w-full max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
	<!-- Header / Status Banner -->
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
					<h1 class="text-xl font-bold text-white tracking-wide">{statusData.title || 'Client Status Portal'}</h1>
					<p class="text-xs text-zinc-400 font-mono">Dedicated Client Infrastructure Monitoring</p>
				</div>
			</div>
			<span class="px-3 py-1 rounded-full bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 text-xs font-mono font-bold">
				🔒 Client Portal
			</span>
		</div>

		{#if !loading && !error}
			{@const overall = getOverallStatusText()}
			<div class="p-4 rounded-xl border flex items-center justify-between {overall.bg}">
				<div class="flex items-center gap-3">
					<span class="relative flex h-3 w-3">
						<span class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 {overall.color === 'text-emerald-400' ? 'bg-emerald-400' : 'bg-rose-400'}"></span>
						<span class="relative inline-flex rounded-full h-3 w-3 {overall.color === 'text-emerald-400' ? 'bg-emerald-500' : 'bg-rose-500'}"></span>
					</span>
					<span class="font-semibold text-sm tracking-wide text-white">{overall.text}</span>
				</div>
				<span class="text-xs text-zinc-400 font-mono">Real-time status</span>
			</div>
		{/if}
	</header>

	{#if loading}
		<div class="p-12 text-center text-zinc-400 font-mono space-y-3">
			<div class="inline-block animate-spin w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full"></div>
			<p class="text-sm">Loading client status page...</p>
		</div>
	{:else if error}
		<div class="p-8 bg-rose-950/50 border border-rose-500/30 rounded-xl text-center space-y-3">
			<span class="text-2xl">⚠️</span>
			<h3 class="text-base font-bold text-rose-300">Access Error</h3>
			<p class="text-xs font-mono text-zinc-400">{error}</p>
		</div>
	{:else if statusData.monitors.length === 0}
		<div class="p-12 bg-[#18181b] border border-[#27272a] rounded-xl text-center text-zinc-400 font-mono">
			No services assigned to this status page yet.
		</div>
	{:else}
		<!-- Group Navigation Tabs -->
		{#if groupKeys.length > 1}
			<div class="flex flex-wrap gap-2 border-b border-[#27272a] pb-3">
				<button
					onclick={() => (activeTab = 'all')}
					class="px-3 py-1.5 rounded-lg text-xs font-mono transition-all {activeTab === 'all' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 font-bold' : 'text-zinc-400 hover:text-white bg-[#18181b]'}"
				>
					All Services ({statusData.monitors.length})
				</button>
				{#each groupKeys as groupKey}
					<button
						onclick={() => (activeTab = groupKey)}
						class="px-3 py-1.5 rounded-lg text-xs font-mono transition-all {activeTab === groupKey ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 font-bold' : 'text-zinc-400 hover:text-white bg-[#18181b]'}"
					>
						{groupKey} ({groups[groupKey].length})
					</button>
				{/each}
			</div>
		{/if}

		<!-- Service Groups List -->
		<div class="space-y-8">
			{#each groupKeys as groupKey}
				{#if activeTab === 'all' || activeTab === groupKey}
					{@const groupMonitors = groups[groupKey]}
					<div class="space-y-3">
						<h2 class="text-xs font-mono text-zinc-400 uppercase tracking-wider font-semibold">{groupKey}</h2>

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

									<!-- 60 Segment Health Bar -->
									<div class="space-y-1.5 w-full">
										<div class="flex gap-1 h-7 w-full">
											{#each m.segments || [] as seg, i}
												<div
													class="flex-1 rounded-sm transition-all relative group cursor-pointer {seg.status === 1 ? 'bg-emerald-500/80 hover:bg-emerald-400' : seg.status === 0 ? 'bg-rose-500/90 hover:bg-rose-400' : seg.status === 2 ? 'bg-amber-500/90 hover:bg-amber-400' : seg.status === 3 ? 'bg-amber-400 animate-pulse' : 'bg-zinc-800/60'}"
												>
													<!-- Segment Tooltip -->
													<div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 w-44 p-2 bg-[#09090b] border border-zinc-700 text-white text-[10px] font-mono rounded shadow-xl pointer-events-none">
														{#if seg.status === -1}
															<div class="text-zinc-400">No data segment</div>
														{:else}
															<div class="font-bold {seg.status === 1 ? 'text-emerald-400' : seg.status === 0 ? 'text-rose-400' : 'text-amber-400'}">
																{seg.status === 1 ? 'Operational' : seg.status === 0 ? 'Outage' : seg.status === 3 ? 'Maintenance' : 'Degraded'}
															</div>
															{#if seg.ping_ms > 0}
																<div>Latency: {seg.ping_ms}ms</div>
															{/if}
															{#if seg.time}
																<div class="text-zinc-400 mt-1">{formatRelativeTime(seg.time)}</div>
															{/if}
														{/if}
													</div>
												</div>
											{/each}
										</div>
										<div class="flex justify-between text-[10px] font-mono text-zinc-500">
											<span>60 checks ago</span>
											<span>Recent</span>
										</div>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>
