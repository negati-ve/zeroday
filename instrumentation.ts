export async function register() {
  // Only run in the Node.js runtime (not edge), and only on the server.
  // This fires once at process start — before any request arrives — so background
  // timers are always running regardless of whether a browser ever connects.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { ensureATBackground } = await import('./src/lib/autoTrader')
    const { ensureHeroBackground } = await import('./src/lib/optionHero')
    ensureATBackground()
    ensureHeroBackground()
    console.log('[instrumentation] background timers started at server startup')
  }
}
