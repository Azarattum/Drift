Use Bun for package management, scripts, and unit tests. Svelte 5 runes, TypeScript, Tailwind 4, and Vite's Svelte compiler build a static bundle. Keep runtime dependencies small. No server is required in production.

Use conventional commits. Run `bun run validate` and relevant Playwright tests before shipping. Keep credentials and device-specific addresses out of source. Only deploy `dist/` to the target device. Respect reduced motion, keyboard input, and touch targets. RPC data is untrusted text; never render it as HTML.

Keep Safari 15.4 / iOS 15.4.1 as the minimum target. Feature-detect newer APIs, give required features fallbacks, and keep newer CSS effects behind compatible values or @supports. Preserve modern browser paths. Browser, CSS, or dependency changes require bun run test:legacy after building, using the pinned WebKit 15.4 engine (install with bun node_modules/playwright-legacy/cli.js install webkit). This engine check does not replace physical-device testing.
