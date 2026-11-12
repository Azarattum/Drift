Use Bun for package management, scripts, and unit tests. Svelte 5 runes, TypeScript, Tailwind 4, and Vite's Svelte compiler build a static bundle. Keep runtime dependencies small. No server is required in production.

Use conventional commits. Run `bun run validate` and relevant Playwright tests before shipping. Keep credentials and device-specific addresses out of source. Only deploy `dist/` to the target device. Respect reduced motion, keyboard input, and touch targets. RPC data is untrusted text; never render it as HTML.
