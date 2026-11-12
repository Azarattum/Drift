import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(init: string) {
  const dir = await mkdtemp(join(tmpdir(), 'drift-install-'));
  fixtures.push(dir);
  const source = await Bun.file(new URL('../install.sh', import.meta.url)).text();
  const isolated = source
    .replaceAll('/etc/init.d/', dir + '/etc/init.d/')
    .replaceAll('/usr/libexec', dir + '/usr/libexec')
    .replaceAll('/usr/bin/', dir + '/usr/bin/');
  await Bun.write(join(dir, 'install.sh'), isolated);
  await Bun.write(join(dir, 'etc/init.d/transmission'), init);
  await Bun.write(join(dir, 'drift-stream'), 'fixture binary');
  await chmod(join(dir, 'drift-stream'), 0o755);
  await Bun.write(join(dir, 'drift-stream.procd'), '# fixture hook\n');
  // Ensure the staged fixture has the normal firmware's bin directory.
  await Bun.write(join(dir, 'usr/bin/.keep'), '');
  return {
    dir,
    run: async () => {
      const child = Bun.spawn(['sh', join(dir, 'install.sh')], { stdout: 'pipe', stderr: 'pipe' });
      await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return child.exited;
    },
  };
}

test('installer preserves a backup, inserts one hook, packages files and is idempotent', async () => {
  const init = '#!/bin/sh\ntransmission() {\n\tprocd_close_instance\n}\n';
  const f = await fixture(init);
  expect(await f.run()).toBe(0);
  const path = join(f.dir, 'etc/init.d/transmission');
  const first = await readFile(path, 'utf8');
  expect(first.split(' || . ').length).toBe(2);
  expect(await readFile(path + '.before-drift-stream', 'utf8')).toBe(init);
  expect(await readFile(join(f.dir, 'usr/bin/drift-stream'), 'utf8')).toBe('fixture binary');
  expect(await f.run()).toBe(0);
  expect(await readFile(path, 'utf8')).toBe(first);
  expect(await readFile(path + '.before-drift-stream', 'utf8')).toBe(init);
});

test('unknown init layouts and existing backups fail without altering the service', async () => {
  for (const init of ['#!/bin/sh\n', 'procd_close_instance\nprocd_close_instance\n']) {
    const f = await fixture(init);
    expect(await f.run()).not.toBe(0);
    expect(await readFile(join(f.dir, 'etc/init.d/transmission'), 'utf8')).toBe(init);
  }
  const f = await fixture('procd_close_instance\n');
  await Bun.write(join(f.dir, 'etc/init.d/transmission.before-drift-stream'), 'previous backup');
  expect(await f.run()).not.toBe(0);
  expect(await readFile(join(f.dir, 'etc/init.d/transmission.before-drift-stream'), 'utf8')).toBe(
    'previous backup',
  );
});
