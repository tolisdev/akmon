<script>
	import '../app.css';

	let { children } = $props();
</script>

<div class="min-h-screen bg-[#09090b] text-[#f4f4f5] flex flex-col selection:bg-emerald-500 selection:text-black">
	{@render children()}
</div>
