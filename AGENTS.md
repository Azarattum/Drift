# Repository guidelines

See [Development](README.md#development) for setup and test commands.

## Tools and code

- Use Bun for package management, scripts, and unit tests.
- Use Svelte 5 runes, TypeScript, Tailwind CSS 4, and Vite's Svelte compiler. Keep runtime dependencies small and preserve the static frontend build.
- Treat RPC data as untrusted text. Never render it as HTML.
- Keep credentials and device-specific addresses out of source.
- Use conventional commit messages.

## Browser and interaction support

- Keep Safari 15.4 / iOS 15.4.1 as the minimum target.
- Feature-detect newer APIs and provide fallbacks. Put newer CSS effects behind compatible values or `@supports`, while preserving modern browser paths.
- Respect reduced motion, keyboard input, visible focus, and touch targets.

## Validation and deployment

- Run `bun run validate` and relevant Playwright tests before shipping.
- Browser, CSS, or dependency changes require `bun run test:legacy` after building. Use the pinned WebKit 15.4 engine, installed with `bun node_modules/playwright-legacy/cli.js install webkit`.
- The archived engine check does not replace physical-device testing.
- Only deploy `dist/` to the target device.
