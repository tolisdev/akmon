<script>
	import { onMount } from 'svelte';
	import io from 'socket.io-client';

	let statusData = $state({ monitors: [] });
	let loading = $state(true);
	let error = $state(null);
	let activeTab = $state('all');

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

	function formatRelativeTime(dateStr) {
		if (!dateStr) return 'Never';
		const date = new Date(dateStr);
		const now = new Date();
		const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

		if (isNaN(diffSec)) return '—';
		if (diffSec < 5) return 'Just now';
		if (diffSec < 60) return `${diffSec}s ago`;
		if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
		if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
		return `${Math.floor(diffSec / 86400)}d ago`;
	}

	async function fetchStatus() {
		try {
			const res = await fetch('/api/v1/public/status');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			statusData = data;
		} catch (err) {
			error = err.message || 'Failed to load status data';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		fetchStatus();

		const socketUrl = window.location.origin;
		const socket = io(socketUrl, {
			transports: ['websocket', 'polling'],
			reconnection: true
		});

		socket.on('heartbeat', (hb) => {
			if (!statusData.monitors) return;
			const idx = statusData.monitors.findIndex((m) => m.id === hb.monitor_id);
			if (idx !== -1) {
				const m = statusData.monitors[idx];
				m.status = hb.status;
				m.ping_ms = hb.ping_ms;
				m.last_check = hb.created_at;

				const segs = [...(m.segments || [])];
				segs.shift(); // Remove oldest on the left
				segs.push({
					status: hb.status,
					ping_ms: hb.ping_ms,
					time: hb.created_at
				});
				m.segments = segs;
			}
		});

		return () => {
			socket.disconnect();
		};
	});

	function getOverallStatusText() {
		const monitors = statusData.monitors || [];
		if (monitors.length === 0) return { text: 'No Services Monitored', color: 'text-zinc-400', bg: 'bg-zinc-800' };
		const isDown = monitors.some((m) => m.status === 0);
		if (isDown) return { text: 'Some Systems Experiencing Outages', color: 'text-rose-400', bg: 'bg-rose-500/10 border-rose-500/20' };
		const isDegraded = monitors.some((m) => m.status === 2);
		if (isDegraded) return { text: 'Degraded Performance Detected', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' };
		return { text: 'All Systems Operational', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' };
	}
</script>

<div class="max-w-6xl mx-auto px-4 py-8 space-y-8">
	<!-- Hero / Status Banner -->
	<header class="space-y-4">
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-3">
				<div class="w-10 h-10 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-mono font-bold">
					AK
				</div>
				<div>
					<h1 class="text-xl font-bold text-white tracking-wide">Infrastructure Status</h1>
					<p class="text-xs text-zinc-400 font-mono">Real-time Uptime & Performance Monitoring</p>
				</div>
			</div>
			<a href="/admin" class="text-xs text-zinc-400 hover:text-white font-mono underline">Admin Login →</a>
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
				<span class="text-xs text-zinc-500 font-mono">Live Socket.IO Sync</span>
			</div>
		{/if}
	</header>

	<!-- Main Content -->
	{#if loading}
		<div class="p-12 text-center text-zinc-500 font-mono">
			<div class="inline-block animate-spin w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full mb-2"></div>
			<p>Connecting to telemetry daemon...</p>
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
								<div class="p-4 rounded-xl bg-[#18181b] border border-[#27272a] hover:border-zinc-700/80 transition-all space-y-3">
									<div class="flex items-center justify-between">
										<div class="flex items-center gap-3">
											<span class="w-2.5 h-2.5 rounded-full {m.status === 1 ? 'bg-emerald-500' : m.status === 2 ? 'bg-amber-500' : 'bg-rose-500'}"></span>
											<span class="font-semibold text-sm text-white tracking-wide">{m.name}</span>
											<span class="text-xs text-zinc-500 font-mono">({m.type})</span>
										</div>
										<div class="flex items-center gap-4 text-xs font-mono">
											<span class="text-zinc-400">
												Last ping: <strong class="text-zinc-200">{formatRelativeTime(m.last_check)}</strong>
											</span>
											{#if m.ping_ms > 0}
												<span class="text-zinc-400">Latency: <strong class="text-zinc-200">{m.ping_ms}ms</strong></span>
											{/if}
											<span class="font-bold {m.uptime_pct >= 99 ? 'text-emerald-400' : m.uptime_pct >= 95 ? 'text-amber-400' : 'text-rose-400'}">
												{m.uptime_pct}% Uptime
											</span>
										</div>
									</div>

									<!-- 60 Segment Health Bar Grid (repeat 60 columns CSS) -->
									<div class="space-y-1.5">
										<div class="grid gap-1 h-7 w-full" style="grid-template-columns: repeat(60, minmax(0, 1fr));">
											{#each m.segments || [] as seg, i}
												<div
													class="rounded-sm transition-all hover:scale-110 relative group {seg.status === 1 ? 'bg-emerald-500' : seg.status === 0 ? 'bg-rose-500' : seg.status === 2 ? 'bg-amber-500' : 'bg-zinc-800'}"
												>
													<!-- Tooltip -->
													<div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 pointer-events-none">
														<div class="bg-[#09090b] border border-zinc-700 text-white text-[10px] font-mono px-2 py-1 rounded shadow-xl whitespace-nowrap">
															<div>{seg.time ? new Date(seg.time).toLocaleTimeString() : 'No Check'}</div>
															<div class="text-zinc-400">{seg.status === 1 ? `UP (${seg.ping_ms}ms)` : seg.status === 0 ? 'DOWN' : 'No Data'}</div>
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
