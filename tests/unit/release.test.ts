import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareChangelog, releaseNotes, releaseVersion } from '../../scripts/release';

test('release CLI synchronizes versions and refuses mismatched tags and downgrades', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drift-release-test-'));
  const native = join(root, 'integrations/openwrt/drift-stream');
  try {
    await Bun.write(
      join(root, 'scripts/release.ts'),
      Bun.file(new URL('../../scripts/release.ts', import.meta.url)),
    );
    await Bun.write(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    await Bun.write(join(root, 'CHANGELOG.md'), changelog);
    await Bun.write(
      join(native, 'Cargo.toml'),
      '[package]\nname = "drift-stream"\nversion = "1.2.3"\n',
    );
    await Bun.write(
      join(native, 'Cargo.lock'),
      '[[package]]\nname = "drift-stream"\nversion = "1.2.3"\n',
    );
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, join(root, 'scripts/release.ts'), ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return { code: await child.exited, error: await new Response(child.stderr).text() };
    };
    expect((await run('prepare', '1.0.0')).code).not.toBe(0);
    expect((await run('prepare', '2.0.0-rc.1')).code).toBe(0);
    expect((await Bun.file(join(root, 'package.json')).json()).version).toBe('2.0.0-rc.1');
    expect(await Bun.file(join(native, 'Cargo.toml')).text()).toContain('version = "2.0.0-rc.1"');
    expect(await Bun.file(join(native, 'Cargo.lock')).text()).toContain('version = "2.0.0-rc.1"');
    const notes = join(root, 'notes.md');
    expect((await run('notes', 'v2.0.0-rc.1', notes)).code).toBe(0);
    expect(await Bun.file(notes).text()).toBe('### Fixed\n\n- Next fix.\n');
    expect((await run('notes', 'v1.2.3', notes)).code).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const changelog =
  '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Next fix.\n\n## [1.2.3] - 2026-01-01\n\n### Added\n\n- Current feature.\n\n## [1.2.2] - 2025-12-01\n\n- Old fix.\n';
test('release notes contain only the current version, excluding unreleased and historical changes', () => {
  expect(releaseNotes(changelog, 'v1.2.3')).toBe('### Added\n\n- Current feature.\n');
  expect(() => releaseNotes(changelog, 'v1.2.2')).toThrow('current changelog');
  expect(() => releaseNotes(changelog, 'v9.0.0')).toThrow();
  expect(() => releaseNotes(changelog.replace('- Current feature.', ''), 'v1.2.3')).toThrow(
    'contain changes',
  );
});
test('preparing a release moves Unreleased notes without losing history', () => {
  const next = prepareChangelog(changelog, '1.3.0-rc.1', '2026-02-01');
  expect(next).toContain('## [Unreleased]\n\n## [1.3.0-rc.1] - 2026-02-01');
  expect(releaseNotes(next, 'v1.3.0-rc.1')).toBe('### Fixed\n\n- Next fix.\n');
  expect(next).toContain('## [1.2.3]');
  expect(() => prepareChangelog(changelog, '1.2.3', '2026-02-01')).toThrow('already exists');
  expect(() => prepareChangelog('# Changelog\n\n## [Unreleased]\n', '1.0.0', '2026-02-01')).toThrow(
    'Add changes',
  );
});
test('release parsing rejects malformed versions and duplicate headings and respects fenced examples', () => {
  for (const version of ['v01.2.3', '1.2', '1.2.3-01', '1.2.3;echo unsafe'])
    expect(() => releaseVersion(version)).toThrow();
  expect(releaseVersion('v1.2.3-rc.1')).toBe('1.2.3-rc.1');
  expect(() => releaseNotes(`${changelog}\n## [1.2.3]\n- Duplicate\n`, 'v1.2.3')).toThrow(
    'Duplicate',
  );
  expect(
    releaseNotes(
      changelog.replace('- Current feature.', '- Example:\n\n```md\n## [9.0.0]\n```'),
      'v1.2.3',
    ),
  ).toContain('## [9.0.0]');
});
