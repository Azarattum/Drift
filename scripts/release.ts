import { resolve } from 'node:path';

export function releaseVersion(tag: string): string {
  const version = tag.replace(/^v/, '');
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(
      version,
    )
  )
    throw new Error('Use a version such as v1.2.3 or v1.2.3-rc.1');
  const identifiers = version.split('-').slice(1).join('-').split('.');
  if (identifiers.some((part) => /^0\d+$/.test(part)))
    throw new Error('Invalid prerelease version');
  return version;
}

function sections(changelog: string) {
  const headings: { name: string; start: number; body: number }[] = [];
  let offset = 0;
  let fence = '';
  for (const line of changelog.split(/(?<=\n)/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
    } else if (!fence && /^##\s/.test(line)) {
      const heading = line.trim().match(/^## \[([^\]]+)\](?: - \d{4}-\d{2}-\d{2})?$/);
      if (!heading) throw new Error('Use Keep a Changelog version headings');
      if (headings.some((h) => h.name === heading[1]))
        throw new Error('Duplicate changelog version');
      headings.push({ name: heading[1], start: offset, body: offset + line.length });
    }
    offset += line.length;
  }
  return headings.map((h, i) => ({ ...h, end: headings[i + 1]?.start ?? changelog.length }));
}

export function releaseNotes(changelog: string, tag: string): string {
  const version = releaseVersion(tag);
  const entries = sections(changelog);
  const entry = entries.find((h) => h.name === version);
  if (!entry || entries.find((h) => h.name !== 'Unreleased') !== entry)
    throw new Error('The tag must match the current changelog version');
  const notes = changelog.slice(entry.body, entry.end).trim();
  if (!/^[-*] \S/m.test(notes)) throw new Error('Release notes must contain changes');
  return `${notes}\n`;
}

export function prepareChangelog(changelog: string, tag: string, date: string): string {
  const version = releaseVersion(tag);
  const entries = sections(changelog);
  if (entries.some((h) => h.name === version)) throw new Error('Version already exists');
  const unreleased = entries[0];
  if (unreleased?.name !== 'Unreleased') throw new Error('Start with an Unreleased section');
  const changes = changelog.slice(unreleased.body, unreleased.end).trim();
  if (!/^[-*] \S/m.test(changes)) throw new Error('Add changes under Unreleased first');
  return `${changelog.slice(0, unreleased.start)}## [Unreleased]\n\n## [${version}] - ${date}\n\n${changes}\n\n${changelog.slice(unreleased.end)}`;
}

function nativeVersions(toml: string, lock: string): [string, string] {
  const manifest = toml.match(/\[package\][\s\S]*?\nversion = "([^"]+)"/);
  const locked = lock.match(/\[\[package\]\]\nname = "drift-stream"\nversion = "([^"]+)"/);
  if (!manifest || !locked) throw new Error('Native package version not found');
  return [manifest[1], locked[1]];
}

async function main() {
  const [command, tag, output] = Bun.argv.slice(2);
  if (!['notes', 'prepare'].includes(command) || !tag)
    throw new Error('Usage: bun scripts/release.ts notes <tag> <output.md> | prepare <version>');
  const root = resolve(import.meta.dir, '..');
  const native = `${root}/integrations/openwrt/drift-stream`;
  const [pkg, changelog, toml, lock] = await Promise.all([
    Bun.file(`${root}/package.json`).json(),
    Bun.file(`${root}/CHANGELOG.md`).text(),
    Bun.file(`${native}/Cargo.toml`).text(),
    Bun.file(`${native}/Cargo.lock`).text(),
  ]);
  const version = releaseVersion(tag);
  const versions = [pkg.version, ...nativeVersions(toml, lock)];
  if (command === 'notes') {
    if (!output || tag !== `v${version}`)
      throw new Error('Release tags must start with v; supply an output path');
    if (versions.some((v) => v !== version))
      throw new Error('Tag and web/native package versions must match');
    await Bun.write(output, releaseNotes(changelog, tag));
    return;
  }
  const nextChangelog = prepareChangelog(changelog, version, new Date().toISOString().slice(0, 10));
  if (Bun.semver.order(version, pkg.version) <= 0)
    throw new Error('The next version must be newer');
  if (versions.some((v) => v !== pkg.version))
    throw new Error('Synchronize existing package versions first');
  const nextToml = toml.replace(
    /(\[package\][\s\S]*?\nversion = ")[^"]+"/,
    (_, prefix) => `${prefix}${version}"`,
  );
  const nextLock = lock.replace(
    /(\[\[package\]\]\nname = "drift-stream"\nversion = ")[^"]+"/,
    (_, prefix) => `${prefix}${version}"`,
  );
  pkg.version = version;
  await Bun.write(`${root}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);
  await Bun.write(`${native}/Cargo.toml`, nextToml);
  await Bun.write(`${native}/Cargo.lock`, nextLock);
  await Bun.write(`${root}/CHANGELOG.md`, nextChangelog);
  console.log(`Prepared v${version}. Review, validate, commit, then push the tag.`);
}

if (import.meta.main) await main();
