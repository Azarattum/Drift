import { resolve } from 'node:path';

const [host, destination] = Bun.argv.slice(2);
if (
  !host ||
  !destination ||
  !/^[a-zA-Z0-9_.@:-]+$/.test(host) ||
  !/^\/[a-zA-Z0-9_./-]+$/.test(destination) ||
  destination === '/' ||
  destination.split('/').includes('..')
) {
  throw new Error('Usage: bun scripts/deploy.ts user@host /absolute/bundle-directory');
}
if (!(await Bun.file(resolve('dist/index.html')).exists()))
  throw new Error('Run bun run build first');
const archive = Bun.spawn(['tar', '-C', resolve('dist'), '-czf', '-', '.'], {
  stdout: 'pipe',
  stderr: 'inherit',
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
const upload = Bun.spawn(
  [
    'ssh',
    '-o',
    'BatchMode=yes',
    host,
    `mkdir -p '${destination}' && tar -xzf - -C '${destination}'`,
  ],
  { stdin: archive.stdout, stdout: 'inherit', stderr: 'inherit' },
);
if ((await upload.exited) !== 0 || (await archive.exited) !== 0)
  throw new Error('Bundle upload failed');
console.log(
  `Uploaded dist/ to ${host}:${destination}. Configure the daemon web home to activate it.`,
);
