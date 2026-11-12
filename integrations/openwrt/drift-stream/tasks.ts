// Bun is the task entrypoint; Cargo manages the isolated native project's dependencies.
import { dirname, join } from 'node:path';
import { readdir, rm } from 'node:fs/promises';

const root = dirname(import.meta.path);
const task = Bun.argv[2] ?? 'check';
async function run(command: string[]) {
  const child = Bun.spawn(command, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if ((await child.exited) !== 0) throw new Error(`Failed: ${command.join(' ')}`);
}

if (task === 'check') {
  await run(['bun', 'test', 'tests/install.test.ts']);
  await run(['cargo', '+stable', 'fmt', '--check']);
  await run(['cargo', '+stable', 'clippy', '--all-targets', '--locked', '--', '-D', 'warnings']);
  await run(['rustup', '+stable', 'target', 'add', 'aarch64-unknown-linux-musl']);
  await run([
    'cargo',
    '+stable',
    'clippy',
    '--target',
    'aarch64-unknown-linux-musl',
    '--locked',
    '--',
    '-D',
    'warnings',
  ]);
  await run(['cargo', '+stable', 'test', '--locked']);
} else if (task === 'build') {
  const target = Bun.argv[3] ?? 'aarch64-unknown-linux-musl';
  if (!/^[a-z0-9_-]+$/.test(target)) throw new Error('Invalid Rust target');
  await run(['rustup', '+stable', 'target', 'add', target]);
  await run([
    'cargo',
    '+stable',
    'build',
    '--release',
    '--locked',
    '--target',
    target,
    '--config',
    `target.${target}.linker="rust-lld"`,
  ]);
  await rm(join(root, 'dist'), { recursive: true, force: true });
  await run(['mkdir', '-p', 'dist']);
  await Bun.write(
    join(root, 'dist/drift-stream'),
    Bun.file(join(root, 'target', target, 'release/drift-stream')),
  );
  for (const file of ['drift-stream.procd', 'install.sh'])
    await Bun.write(join(root, 'dist', file), Bun.file(join(root, file)));
  await Bun.write(join(root, 'dist/LICENSE'), Bun.file(join(root, '../../../LICENSE')));
  const metadata = Bun.spawn(
    [
      'cargo',
      '+stable',
      'metadata',
      '--locked',
      '--filter-platform',
      target,
      '--format-version',
      '1',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'inherit' },
  );
  const graph = (await new Response(metadata.stdout).json()) as {
    packages: {
      name: string;
      version: string;
      license: string | null;
      manifest_path: string;
      id: string;
    }[];
    resolve: {
      root: string;
      nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[];
    };
  };
  if (await metadata.exited) throw new Error('Cannot collect dependency licenses');
  const nodes = new Map(graph.resolve.nodes.map((n) => [n.id, n]));
  const included = new Set<string>();
  const pending = [graph.resolve.root];
  while (pending.length) {
    const id = pending.pop()!;
    if (included.has(id)) continue;
    included.add(id);
    for (const dep of nodes.get(id)?.deps ?? [])
      if (dep.dep_kinds.some((k) => k.kind !== 'dev')) pending.push(dep.pkg);
  }
  const packages = graph.packages.filter((p) => included.has(p.id));
  await Bun.write(
    join(root, 'dist/THIRD_PARTY.txt'),
    packages
      .map((p) => `${p.name} ${p.version}: ${p.license ?? 'See crate license'}`)
      .sort()
      .join('\n') + '\n',
  );
  for (const p of packages) {
    if (p.name === 'drift-stream') continue;
    const directory = dirname(p.manifest_path);
    const licenses = (await readdir(directory, { withFileTypes: true })).filter(
      (f) => f.isFile() && /^(license|copying|notice)([.-]|$)/i.test(f.name),
    );
    if (!licenses.length) throw new Error(`Missing dependency license files: ${p.name}`);
    for (const file of licenses)
      await Bun.write(
        join(root, 'dist/licenses', `${p.name}-${p.version}`, file.name),
        Bun.file(join(directory, file.name)),
      );
  }
  await run(['chmod', '755', 'dist/drift-stream', 'dist/install.sh']);
} else {
  throw new Error(
    'Usage: bun integrations/openwrt/drift-stream/tasks.ts check|build [Rust target]',
  );
}
