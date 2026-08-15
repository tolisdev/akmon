<script>
	import { onMount } from 'svelte';
	import io from 'socket.io-client';

	let monitors = $state([]);
	let loading = $state(true);
	let tooltip = $state({ visible: false, x: 0, y: 0, content: '' });

	let overallStatus = $derived(() => {
		if (monitors.length === 0) return 'operational';
		const hasDown = monitors.some((m) => m.status === 0);
		if (hasDown) return 'disruption';
		const hasDegraded = monitors.some((m) => m.status === 2);
		if (hasDegraded) return 'degraded';
		return 'operational';
	});

	// Group monitors dynamically by group_name
	let groupedMonitors = $derived(() => {
		const groups = {};
		for (const m of monitors) {
			const groupName = m.group_name || 'Default Services';
			if (!groups[groupName]) {
				groups[groupName] = [];
			}
			groups[groupName].push(m);
		}
		return groups;
	});

	async function fetchStatus() {
		try {
			const res = await fetch('/api/v1/public/status');
			if (res.ok) {
				const data = await res.json();
				if (data.monitors) {
					monitors = data.monitors;
				}
			}
		} catch (e) {
			console.error('Failed to fetch status', e);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		fetchStatus();

		const socketUrl = window.location.origin;
		const socketInstance = io(socketUrl);

		socketInstance.on('heartbeat', (hb) => {
			const idx = monitors.findIndex((m) => m.id === hb.monitor_id);
			if (idx !== -1) {
				monitors[idx].status = hb.status;
				monitors[idx].ping_ms = hb.ping_ms;
				monitors[idx].last_check = hb.created_at;

				const segs = [...monitors[idx].segments];
				segs.shift();
				segs.push({
					status: hb.status,
					ping_ms: hb.ping_ms,
					time: hb.created_at
				});
				monitors[idx].segments = segs;
			}
		});

		return () => {
			if (socketInstance) socketInstance.disconnect();
		};
	});

	function handleMouseEnter(e, seg) {
		if (seg.status === -1) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const statusText = seg.status === 1 ? 'OPERATIONAL' : seg.status === 2 ? 'DEGRADED' : 'OFFLINE';
		const pingText = seg.ping_ms > 0 ? `${seg.ping_ms}ms` : '';
		const timeStr = seg.time ? new Date(seg.time.replace(' ', 'T') + 'Z').toLocaleTimeString() : '';

		tooltip = {
			visible: true,
			x: rect.left + rect.width / 2,
			y: rect.top - 40,
			content: `${statusText} ${pingText ? '• ' + pingText : ''} ${timeStr ? '• ' + timeStr : ''}`
		};
	}

	function handleMouseLeave() {
		tooltip = { ...tooltip, visible: false };
	}
</script>

<div class="max-w-4xl mx-auto px-4 py-12 w-full flex-grow">
	<!-- Top Bar / Header -->
	<header class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-8 mb-8 border-b border-[#27272a]">
		<div>
			<div class="flex items-center gap-3">
				<span class="inline-block w-3 h-3 rounded-full bg-emerald-500 animate-pulse"></span>
				<h1 class="text-2xl font-bold tracking-tight text-white">System Status</h1>
			</div>
			<p class="text-xs text-zinc-400 mt-1">Real-time uptime telemetry & monitoring</p>
		</div>

		<!-- Status Badge -->
		{#if overallStatus() === 'operational'}
			<div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-950/60 border border-emerald-500/30 text-emerald-400 text-xs font-semibold">
				<span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
				All Systems Operational
			</div>
		{:else if overallStatus() === 'degraded'}
			<div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-950/60 border border-amber-500/30 text-amber-400 text-xs font-semibold">
				<span class="w-2 h-2 rounded-full bg-amber-500"></span>
				Partial Performance Degradation
			</div>
		{:else}
			<div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-rose-950/60 border border-rose-500/30 text-rose-400 text-xs font-semibold">
				<span class="w-2 h-2 rounded-full bg-rose-500 animate-bounce"></span>
				Service Disruption Detected
			</div>
		{/if}
	</header>

	<!-- Main Grouped Monitor List -->
	{#if loading}
		<div class="space-y-4">
			{#each Array(3) as _}
				<div class="p-5 rounded-lg bg-[#18181b] border border-[#27272a] animate-pulse">
					<div class="h-5 bg-zinc-800 rounded w-1/3 mb-4"></div>
					<div class="h-8 bg-zinc-800 rounded w-full"></div>
				</div>
			{/each}
		</div>
	{:else if monitors.length === 0}
		<div class="p-12 text-center rounded-xl bg-[#18181b] border border-[#27272a]">
			<div class="w-12 h-12 rounded-full bg-zinc-800/80 flex items-center justify-center mx-auto mb-3 text-zinc-400">
				📡
			</div>
			<h3 class="text-sm font-semibold text-zinc-200">No Services Registered</h3>
			<p class="text-xs text-zinc-500 mt-1">Monitors added via the admin dashboard will appear here automatically.</p>
		</div>
	{:else}
		<div class="space-y-8">
			{#each Object.entries(groupedMonitors()) as [groupName, groupList]}
				{@const upCount = groupList.filter((m) => m.status === 1).length}
				<section class="space-y-3">
					<!-- Group Header -->
					<div class="flex items-center justify-between pb-2 border-b border-[#27272a]">
						<h2 class="text-sm font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
							<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
							{groupName}
						</h2>
						<span class="text-xs font-mono text-zinc-500">
							{upCount}/{groupList.length} Operational
						</span>
					</div>

					<div class="space-y-4">
						{#each groupList as monitor (monitor.id)}
							<div class="p-5 rounded-xl bg-[#18181b] border border-[#27272a] hover:border-zinc-700 transition-colors shadow-sm">
								<!-- Card Header -->
								<div class="flex items-center justify-between mb-4">
									<div class="flex items-center gap-3">
										<span class="font-medium text-sm text-white tracking-wide">{monitor.name}</span>
										<span class="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/50">
											{monitor.type}
										</span>
									</div>

									<div class="flex items-center gap-4 text-xs font-mono">
										{#if monitor.ping_ms > 0}
											<span class="text-zinc-400">{monitor.ping_ms}<span class="text-[10px] text-zinc-500">ms</span></span>
										{/if}

										<div class="flex items-center gap-1.5">
											{#if monitor.status === 1}
												<span class="w-2 h-2 rounded-full bg-emerald-500"></span>
												<span class="text-emerald-400 font-medium">UP</span>
											{:else if monitor.status === 2}
												<span class="w-2 h-2 rounded-full bg-amber-500"></span>
												<span class="text-amber-400 font-medium">DEGRADED</span>
											{:else}
												<span class="w-2 h-2 rounded-full bg-rose-500"></span>
												<span class="text-rose-400 font-medium">DOWN</span>
											{/if}
										</div>
									</div>
								</div>

								<!-- 60-Segment Historical Health Bar -->
								<div class="relative">
									<div class="grid grid-cols-60 gap-[2px] h-8 items-center bg-[#09090b] p-1 rounded-md border border-zinc-800/80">
										{#each monitor.segments as seg, idx}
											<div
												role="button"
												tabindex="0"
												class="h-full rounded-[1px] transition-all duration-150 cursor-pointer hover:scale-y-125 hover:opacity-100 opacity-90 {seg.status === 1 ? 'bg-emerald-500' : seg.status === 2 ? 'bg-amber-500' : seg.status === 0 ? 'bg-rose-500' : 'bg-zinc-800/40'}"
												onmouseenter={(e) => handleMouseEnter(e, seg)}
												onmouseleave={handleMouseLeave}
											></div>
										{/each}
									</div>

									<!-- Health Bar Footer Details -->
									<div class="flex justify-between items-center text-[10px] text-zinc-500 font-mono mt-2 px-0.5">
										<span>60 checks ago</span>
										<span class="text-zinc-400 font-semibold">{monitor.uptime_pct}% uptime</span>
										<span>Recently</span>
									</div>
								</div>
							</div>
						{/each}
					</div>
				</section>
			{/each}
		</div>
	{/if}

	<!-- Dynamic Floating Tooltip -->
	{#if tooltip.visible}
		<div
			class="fixed z-50 transform -translate-x-1/2 px-2.5 py-1 rounded bg-zinc-900 border border-zinc-700 text-[11px] font-mono text-zinc-200 shadow-xl pointer-events-none whitespace-nowrap"
			style="left: {tooltip.x}px; top: {tooltip.y}px;"
		>
			{tooltip.content}
		</div>
	{/if}

	<!-- Footer -->
	<footer class="mt-16 pt-6 border-t border-[#27272a]/60 text-center text-xs text-zinc-500 flex flex-col sm:flex-row items-center justify-between gap-2">
		<span>akMon High-Efficiency Monitor • Single Process Engine</span>
		<a href="/admin" class="text-zinc-400 hover:text-white transition-colors underline font-mono text-[11px]">Admin Management →</a>
	</footer>
</div>

<style>
	.grid-cols-60 {
		grid-template-columns: repeat(60, minmax(0, 1fr));
	}
</style>
