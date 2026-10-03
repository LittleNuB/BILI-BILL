import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const source = dirname(fileURLToPath(import.meta.url)), root = resolve(source, '../..');
const output = join(root, 'release-artifacts', `codex-plugin-${Date.now()}`), target = join(output, 'bili-bill-knowledge');
await mkdir(join(target, 'server'), { recursive: true });
const result = await build({ entryPoints: [join(source, 'cli.mjs')], outfile: join(target, 'server/index.mjs'), bundle: true,
  platform: 'node', target: 'node24', format: 'esm', metafile: true, minify: false, legalComments: 'inline',
  banner: { js: "import { createRequire as __bbCreateRequire } from 'node:module'; const require = __bbCreateRequire(import.meta.url);" } });
for (const file of ['plugin.json', 'mcp.json', '.mcp.json', '.codex-plugin', 'config.example.json', 'README.md', 'skills'])
  await cp(join(source, file), join(target, file), { recursive: true });
await mkdir(join(target, 'assets')); await cp(join(root, 'public/icons/icon128.png'), join(target, 'assets/icon.png'));
const manifest = JSON.parse(await readFile(join(target, 'plugin.json'), 'utf8'));
manifest.extensions['com.openai'].interface.logo = './assets/icon.png';
manifest.extensions['com.openai'].interface.composerIcon = './assets/icon.png';
if (manifest.name !== 'bili-bill-knowledge' || manifest.extensions['com.openai'].interface.shortDescription.length > 30) throw Error('Invalid manifest');
await writeFile(join(target, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
const lock = JSON.parse(await readFile(join(source, 'package-lock.json'), 'utf8'));
const notices = [];
for (const [folder, pkg] of Object.entries(lock.packages)) {
  if (!folder || pkg.dev) continue;
  const dir = join(source, folder), name = folder.split('node_modules/').at(-1);
  notices.push(`${name}@${pkg.version}: ${pkg.license ?? 'See license file'}`);
  for (const file of await readdir(dir)) if (/^(license|copying|notice)(\.|$)/i.test(file)) {
    const info = await lstat(join(dir, file)); if (!info.isFile()) continue;
    const destination = join(target, 'licenses', name.replaceAll('/', '__'));
    await mkdir(destination, { recursive: true }); await cp(join(dir, file), join(destination, file));
  }
}
await cp(join(root, 'LICENSE'), join(target, 'LICENSE'));
await writeFile(join(target, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n') + '\n');
const test = spawnSync(process.execPath, ['--test', join(source, 'tests/agent.test.mjs')], {
  cwd: root, encoding: 'utf8', env: { ...process.env, BB_CODEX_TEST_ENTRY: join(target, 'server/index.mjs') },
});
process.stdout.write(test.stdout); process.stderr.write(test.stderr);
if (test.status !== 0) throw Error('Packaged stdio test failed');
const inventory = [];
async function walk(dir) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name), info = await lstat(path);
    if (info.isSymbolicLink()) throw Error('Link in package');
    if (info.isDirectory()) await walk(path);
    else {
      if (/^(config\.json|\.env|.*\.(pem|key))$/i.test(name)) throw Error('Private file in package');
      const bytes = await readFile(path); inventory.push({ path: relative(target, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
await walk(target);
await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'pass', kind: 'synthetic_stdio_and_package',
  installedHostVerified: false, target, files: inventory, bundledInputCount: Object.keys(result.metafile.inputs).length }, null, 2));
console.log(JSON.stringify({ output: target, status: 'pass', installedHostVerified: false }));
