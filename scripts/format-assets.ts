import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

// Preserve loader → module → WASM paths, using .js for static servers without .mjs MIME support.
// Assets are self-hosted, never fetched from a CDN.
export function formatAssets(): Plugin {
  const root = fileURLToPath(new URL('../node_modules/avbridge/vendor/libav/', import.meta.url));
  const files = async () => {
    const result: { path: string; source: Buffer }[] = [];
    for (const variant of ['avbridge', 'webcodecs']) {
      for (const name of await readdir(`${root}${variant}`)) {
        if (!/\.(mjs|wasm)$/.test(name)) continue;
        result.push({
          path: `${variant}/${name.replace(/\.mjs$/, '.js')}`,
          source: name.endsWith('.mjs')
            ? Buffer.from(
                (await readFile(`${root}${variant}/${name}`, 'utf8'))
                  .replaceAll('.mjs', '.js')
                  .replaceAll('"mjs"', '"js"'),
              )
            : await readFile(`${root}${variant}/${name}`),
        });
      }
    }
    return result;
  };
  return {
    name: 'drift-format-assets',
    async generateBundle() {
      for (const file of await files())
        this.emitFile({
          type: 'asset',
          fileName: `format-codecs/${file.path}`,
          source: file.source,
        });
      for (const name of ['LICENSE', 'NOTICE.md', 'THIRD_PARTY_LICENSES.md'])
        this.emitFile({
          type: 'asset',
          fileName: `format-codecs/${name}`,
          source: await readFile(new URL(`../node_modules/avbridge/${name}`, import.meta.url)),
        });
    },
    async configureServer(server) {
      const assets = new Map((await files()).map((file) => [file.path, file.source]));
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0].match(/\/format-codecs\/(.+)$/)?.[1];
        const bytes = path && assets.get(path);
        if (!bytes) return next();
        res.setHeader(
          'Content-Type',
          path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        );
        res.end(bytes);
      });
    },
  };
}
