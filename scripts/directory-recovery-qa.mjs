import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const scenarios = ['source-root', 'source-empty-child', 'cancel', 'recover'];
const pauseLabel = '我已暂停其他窗口和 Agent 的目录写入';
const submitLabel = '选择新目录并恢复';
const recoverySources = [
  'src/background/storage/open-knowledge-recovery.ts',
  'src/shared/open-knowledge/browser-files.ts',
  'src/shared/open-knowledge/workspace.ts',
  'dashboard/modules/knowledge/KnowledgeDirectoryRecovery.tsx',
  'dashboard/modules/knowledge/KnowledgePage.tsx',
  'dashboard/modules/knowledge/runtime.ts',
  'dashboard/modules/knowledge/knowledge.css',
];

const entrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entrypoint && process.argv.includes('--help')) {
  console.log([
    'Run from any directory: node scripts/directory-recovery-qa.mjs',
    'Required: UX014_PLAYWRIGHT_MODULE, UX014_CHROME_EXECUTABLE, UX014_EDGE_EXECUTABLE.',
    'CHROME_EXECUTABLE and EDGE_EXECUTABLE are also accepted as executable aliases.',
    'Optional provenance: UX014_SOURCE_COMMIT, UX014_SOURCE_TREE, UX014_WORKING_TREE_DIRTY=true|false.',
    'Final packaging must supply and independently verify these Git metadata values; this script never invokes Git.',
    'No Git commands, build, installation, personal profile, system picker, or model calls.',
    'Runs the actual dist extension with native OPFS/IndexedDB and a controlled picker in fresh profiles.',
    'Missing prerequisites and test failures also produce release-artifacts/directory-recovery-*/report.json.',
    'Last stdout line: {out,status,report,reportSha256,results}; exit 0 only for pass, otherwise 1.',
    'Copy report.json and screens/ together. Screenshot paths are relative to out and hashed in report.files.',
  ].join('\n'));
} else if (entrypoint) {
  await main();
}

async function fileManifest(directory) {
  const files = {};
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `Do not follow links: ${absolute}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files[path.relative(directory, absolute).replaceAll('\\', '/')] = sha(await readFile(absolute));
    }
  }
  await visit(directory);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

async function sourceManifest() {
  const files = {};
  for (const folder of ['src', 'dashboard', 'popup', 'public', 'scripts']) {
    for (const [name, hash] of Object.entries(await fileManifest(path.join(root, folder)))) files[`${folder}/${name}`] = hash;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && /^(package(-lock)?\.json|vite[^/]*|tsconfig[^/]*\.json)$/.test(entry.name)) {
      files[entry.name] = sha(await readFile(path.join(root, entry.name)));
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

export async function buildFixtures() {
  const { build } = await import('esbuild');
  const bundle = await build({
    stdin: {
      contents: ['format', 'sources', 'backup'].map(name => `export * from './src/shared/open-knowledge/${name}.ts';`).join('\n'),
      resolveDir: root,
    },
    bundle: true, write: false, format: 'esm', platform: 'node',
  });
  const codec = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const time = 1791676800000;
  const source = await codec.createSource({
    kind: 'external', video: null, label: 'Synthetic recovery source', text: 'Offline fixture: preserve both branches.',
    language: null, version: null, capturedAt: time, segments: [], derivedFrom: null, legacyAsset: null,
  });
  const image = await codec.imageAttachment(Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXfoAAAAASUVORK5CYII=', 'base64')));
  const page = {
    pageId: codec.videoPageId('BV1234567890'), kind: 'video', bvid: 'BV1234567890', title: 'Synthetic directory recovery',
    body: 'Complete shared base.', aiNotes: '', topics: ['Recovery QA'], sourceIds: [], attachmentIds: [], legacyIds: [], createdAt: time,
  };
  const base = await codec.createRevision(page, [], 'browser', time);
  const local = await codec.createRevision({ ...page, body: 'Local pending branch.', sourceIds: [source.id], attachmentIds: [image.id] }, [base.id], 'browser', time + 1);
  const remote = await codec.createRevision({ ...page, body: 'Remote-only branch.' }, [base.id], 'codex', time + 2);
  const revisionPath = row => `pages/${row.pageId}/${row.id}.md`;
  const libraryId = '01234567-89ab-4cde-8fab-0123456789ab';
  const localFiles = [
    { path: revisionPath(base), bytes: Array.from(codec.textBytes(codec.serializeRevision(base))), pending: 0, sequence: 1 },
    { path: `sources/${source.id}.json`, bytes: Array.from(codec.jsonBytes(source)), pending: 1, sequence: 2 },
    { path: `attachments/${image.id}.${image.extension}`, bytes: Array.from(image.bytes), pending: 1, sequence: 3 },
    { path: revisionPath(local), bytes: Array.from(codec.textBytes(codec.serializeRevision(local))), pending: 1, sequence: 4 },
  ];
  const remoteFile = { path: revisionPath(remote), bytes: Array.from(codec.textBytes(codec.serializeRevision(remote))) };
  const library = { format: codec.KNOWLEDGE_FORMAT, version: 1, id: libraryId };
  const seed = {
    libraryId, localFiles, remoteFile,
    libraryFile: { path: 'library.json', bytes: Array.from(codec.jsonBytes(library)) },
    state: { key: 'state', epoch: 2, sequence: 4, connectionRevision: 7, libraryId, migration: 'a'.repeat(64) },
  };
  const merged = new Map([...localFiles, remoteFile].map(file => [file.path, Uint8Array.from(file.bytes)]));
  const summary = await codec.validateKnowledgeFiles(merged, libraryId);
  assert.deepEqual([summary.pages, summary.images, summary.sources, summary.versions, summary.conflicts], [1, 1, 1, 3, 1]);
  return { codec, seed, merged, base, local, remote, source, image };
}

// Only picker and unsupported OPFS permission methods are controlled. Storage and handle identity remain native.
function installHarness({ namespace }) {
  if (location.protocol !== 'chrome-extension:' || location.pathname !== '/dashboard/index.html' || window !== top) return;
  const qa = { choice: 'cancel', pickerCalls: [], permissionFallbacks: [] };
  Object.defineProperty(window, '__directoryRecoveryQA', { value: qa });
  const prototype = FileSystemDirectoryHandle.prototype;
  for (const method of ['queryPermission', 'requestPermission']) {
    const original = prototype[method];
    Object.defineProperty(prototype, method, { configurable: true, writable: true, value: async function (options) {
      let unsupported = typeof original !== 'function';
      if (!unsupported) {
        try { return await original.call(this, options); }
        catch (error) {
          if (!['TypeError', 'NotSupportedError'].includes(error.name)) throw error;
          unsupported = true;
        }
      }
      const relative = await (await navigator.storage.getDirectory()).resolve(this);
      if (unsupported && relative?.[0] === namespace) {
        qa.permissionFallbacks.push({ method, path: relative.join('/'), mode: options?.mode });
        return 'granted';
      }
      throw new DOMException('Permission fallback is confined to this synthetic OPFS fixture.', 'NotSupportedError');
    } });
  }
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async options => {
    qa.pickerCalls.push({ choice: qa.choice, options });
    if (qa.choice === 'cancel') throw new DOMException('Synthetic user cancellation', 'AbortError');
    const storage = await navigator.storage.getDirectory();
    const fixture = await storage.getDirectoryHandle(namespace);
    const old = await fixture.getDirectoryHandle('old');
    if (qa.choice === 'source-root') return old;
    if (qa.choice === 'source-empty-child') return old.getDirectoryHandle('empty-child');
    if (qa.choice === 'recover') return fixture.getDirectoryHandle('new-parent');
    throw new Error('Unknown controlled picker choice');
  } });
}

async function seedPage({ namespace, seed }) {
  if (!(indexedDB instanceof IDBFactory)) throw new Error('Native IndexedDB unavailable');
  const storage = await navigator.storage.getDirectory();
  if (!(storage instanceof FileSystemDirectoryHandle)) throw new Error('Native OPFS unavailable');
  const folder = await storage.getDirectoryHandle(namespace, { create: true });
  const old = await folder.getDirectoryHandle('old', { create: true });
  await folder.getDirectoryHandle('new-parent', { create: true });
  async function put(file, incomplete = false) {
    const parts = file.path.split('/'), name = parts.pop();
    let parent = old;
    for (const part of parts) parent = await parent.getDirectoryHandle(part, { create: true });
    const handle = await parent.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    await writer.write(Uint8Array.from(incomplete ? [] : file.bytes));
    await writer.close();
  }
  await put(seed.libraryFile);
  for (const file of seed.localFiles) await put(file, file.pending === 1);
  await put(seed.remoteFile);
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('BiliAnalyticsDB');
    request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('Production database was not initialized')); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    if (!db.objectStoreNames.contains('okFiles') || !db.objectStoreNames.contains('okMeta')) throw new Error('Missing production knowledge stores');
    const transaction = db.transaction(['okFiles', 'okMeta'], 'readwrite');
    const done = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Seed transaction aborted'));
    });
    transaction.objectStore('okFiles').clear();
    for (const file of seed.localFiles) transaction.objectStore('okFiles').put({ ...file, bytes: Uint8Array.from(file.bytes) });
    transaction.objectStore('okMeta').put({ ...seed.state, handle: old });
    await done;
    return { nativeOPFS: true, nativeIndexedDB: true, database: db.name, version: db.version };
  } finally { db.close(); }
}

async function snapshotPage({ namespace }) {
  const storage = await navigator.storage.getDirectory();
  const folder = await storage.getDirectoryHandle(namespace);
  const old = await folder.getDirectoryHandle('old');
  const parent = await folder.getDirectoryHandle('new-parent');
  async function tree(directory) {
    const entries = [], files = [];
    async function visit(current, prefix = '') {
      for await (const handle of current.values()) {
        const filePath = prefix + handle.name;
        entries.push({ path: filePath, kind: handle.kind });
        if (handle.kind === 'directory') await visit(handle, `${filePath}/`);
        else files.push({ path: filePath, bytes: Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer())) });
      }
    }
    await visit(directory);
    const compare = (a, b) => a.path.localeCompare(b.path, 'en');
    return { entries: entries.sort(compare), files: files.sort(compare) };
  }
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('BiliAnalyticsDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  let files, state;
  try {
    const transaction = db.transaction(['okFiles', 'okMeta'], 'readonly');
    const done = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Read transaction aborted'));
    });
    const get = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    [files, state] = await Promise.all([
      get(transaction.objectStore('okFiles').getAll()), get(transaction.objectStore('okMeta').get('state')),
    ]);
    await done;
  } finally { db.close(); }
  if (!state) throw new Error('Missing knowledge state');
  const { handle, ...meta } = state;
  let recovered = null;
  try { recovered = await parent.getDirectoryHandle('Bili-Bill'); }
  catch (error) { if (error.name !== 'NotFoundError') throw error; }
  return {
    old: await tree(old), destination: await tree(parent),
    files: files.map(file => ({ ...file, bytes: Array.from(file.bytes) })).sort((a, b) => a.path.localeCompare(b.path, 'en')),
    meta, pending: files.filter(file => file.pending === 1).length,
    nativeHandle: handle instanceof FileSystemDirectoryHandle,
    boundToOriginal: !!handle && await handle.isSameEntry(old),
    boundToRecovered: !!handle && !!recovered && await handle.isSameEntry(recovered),
    pickerCalls: window.__directoryRecoveryQA.pickerCalls,
    permissionFallbacks: window.__directoryRecoveryQA.permissionFallbacks,
  };
}

function evidence(snapshot) {
  const files = rows => rows.map(({ bytes, ...file }) => ({ ...file, byteLength: bytes.length, sha256: sha(Uint8Array.from(bytes)) }));
  return {
    ...snapshot,
    old: { entries: snapshot.old.entries, files: files(snapshot.old.files) },
    destination: { entries: snapshot.destination.entries, files: files(snapshot.destination.files) },
    files: files(snapshot.files),
  };
}

function assertPreserved(before, after) {
  assert.deepEqual(after.old, before.old, 'Old directory entry list and every file byte must remain unchanged');
  assert.deepEqual(after.destination, before.destination, 'Rejected/cancelled selection must not create nested Bili-Bill');
  assert.deepEqual(after.files, before.files, 'Pending browser content must remain byte-identical');
  assert.deepEqual(after.meta, before.meta, 'Rejected/cancelled recovery must not update connection or state');
  assert.equal(after.pending, 3);
  assert.equal(after.nativeHandle, true);
  assert.equal(after.boundToOriginal, true);
  assert.equal(after.boundToRecovered, false);
}

async function assertRecovered(snapshot, before, fixture) {
  assert.deepEqual(snapshot.old, before.old, 'Successful recovery must preserve the entire old tree, including zero-byte files');
  assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.meta.connectionRevision, before.meta.connectionRevision + 1);
  assert.ok(snapshot.meta.sequence > before.meta.sequence);
  assert.equal(snapshot.meta.epoch, before.meta.epoch);
  assert.equal(snapshot.meta.libraryId, fixture.seed.libraryId);
  assert.equal(snapshot.nativeHandle, true);
  assert.equal(snapshot.boundToOriginal, false);
  assert.equal(snapshot.boundToRecovered, true);
  const destination = new Map(snapshot.destination.files.map(file => {
    assert.ok(file.path.startsWith('Bili-Bill/'), 'Destination writes must stay in the managed child');
    return [file.path.slice('Bili-Bill/'.length), Uint8Array.from(file.bytes)];
  }));
  const library = JSON.parse(new TextDecoder().decode(destination.get('library.json')));
  fixture.codec.validateLibrary(library);
  assert.equal(library.id, fixture.seed.libraryId);
  destination.delete('library.json');
  const local = new Map(snapshot.files.map(file => [file.path, Uint8Array.from(file.bytes)]));
  const plain = entries => [...entries].map(([filePath, bytes]) => [filePath, Array.from(bytes)]).sort(([a], [b]) => a.localeCompare(b, 'en'));
  assert.deepEqual(plain(destination), plain(fixture.merged), 'New directory must contain the complete exact union');
  assert.deepEqual(plain(local), plain(fixture.merged), 'Native IndexedDB must contain the same exact union');
  for (const entries of [destination, local]) {
    const summary = await fixture.codec.validateKnowledgeFiles(entries, fixture.seed.libraryId);
    assert.deepEqual([summary.pages, summary.versions, summary.images, summary.sources, summary.conflicts], [1, 3, 1, 1, 1]);
    const revisions = await Promise.all([...entries].filter(([name]) => name.startsWith('pages/'))
      .map(([, bytes]) => fixture.codec.parseRevision(new TextDecoder().decode(bytes))));
    assert.deepEqual(fixture.codec.revisionHeads(revisions).map(row => row.id).sort(), [fixture.local.id, fixture.remote.id].sort());
    assert.equal((await fixture.codec.parseSource(new TextDecoder().decode(entries.get(`sources/${fixture.source.id}.json`)))).id, fixture.source.id);
    assert.equal((await fixture.codec.imageAttachment(entries.get(`attachments/${fixture.image.id}.${fixture.image.extension}`))).id, fixture.image.id);
  }
}

async function capture(page, out, report, result, label, dialog = null) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector('dialog[open]');
    const rect = dialog?.getBoundingClientRect();
    const overflowingText = [];
    if (dialog) {
      const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        for (const box of range.getClientRects()) {
          if (box.width && (box.left < rect.left - 1 || box.right > rect.right + 1)) {
            overflowingText.push(walker.currentNode.textContent.slice(0, 80)); break;
          }
        }
      }
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentScrollWidth: document.documentElement.scrollWidth,
      dialog: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom,
        scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth } : null,
      overflowingText,
    };
  });
  const file = `screens/${result.browser}-${result.scenario}-${label}-${layout.viewport.width}.png`;
  await page.screenshot({ path: path.join(out, file) });
  report.screenshots.push({ file, browser: result.browser, scenario: result.scenario, ...layout.viewport, layout, productionUI: true, syntheticData: true });
  assert.ok(layout.documentScrollWidth <= layout.viewport.width + 1, 'Page must not overflow horizontally');
  if (dialog) {
    assert.ok(await dialog.isVisible(), 'Recovery dialog must remain visible');
    const box = layout.dialog; assert.ok(box, 'Expected an open production dialog');
    assert.ok(box.x >= -1 && box.y >= -1 && box.right <= layout.viewport.width + 1 && box.bottom <= layout.viewport.height + 1, 'Dialog must fit the viewport');
    assert.ok(box.scrollWidth <= box.clientWidth + 1, 'Dialog must not scroll horizontally');
    assert.deepEqual(layout.overflowingText, [], 'Dialog text must not escape its bounds');
  }
}

async function captureWidths(page, out, report, result, label, dialog) {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await capture(page, out, report, result, label, dialog);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function runScenario(chromium, executablePath, browser, scenario, fixture, out, report) {
  const result = { browser, scenario, status: 'running', checks: [], pageErrors: [], unexpectedDialogs: [], networkAttempts: [], externalResponses: [], realModelCalls: 0 };
  report.results.push(result);
  let context, page;
  const namespace = `directory-recovery-${randomUUID()}`;
  try {
    const profile = await mkdtemp(path.join(tmpdir(), `bb-directory-recovery-${browser.toLowerCase()}-`));
    result.freshProfile = profile;
    context = await chromium.launchPersistentContext(profile, {
      executablePath, headless: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'],
    });
    context.setDefaultTimeout(15000);
    await context.setOffline(true);
    await context.route(/^https?:\/\//, route => route.abort('blockedbyclient'));
    if (context.routeWebSocket) await context.routeWebSocket(/.*/, socket => socket.close());
    context.on('request', request => {
      if (/^https?:/.test(request.url())) result.networkAttempts.push({ origin: new URL(request.url()).origin, method: request.method() });
    });
    context.on('response', response => {
      if (/^https?:/.test(response.url())) result.externalResponses.push({ origin: new URL(response.url()).origin, status: response.status() });
    });
    result.networkGuards = { offline: true, httpRouteAbort: true, dnsBlackhole: true, websocketBlocked: !!context.routeWebSocket, systemNetworkConfigurationChanged: false };
    const cdp = await context.browser().newBrowserCDPSession();
    try {
      result.version = await cdp.send('Browser.getVersion');
      const extension = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') });
      result.extensionId = extension.id;
    } finally { await cdp.detach(); }
    page = await context.newPage();
    page.on('pageerror', error => result.pageErrors.push(error.message));
    page.on('dialog', async dialog => { result.unexpectedDialogs.push({ type: dialog.type(), message: dialog.message() }); await dialog.dismiss(); });
    await page.addInitScript(installHarness, { namespace });
    const url = `chrome-extension://${result.extensionId}/dashboard/index.html#video-wiki`;
    await page.goto(url);
    await page.getByRole('heading', { name: '从一条笔记开始', exact: true }).waitFor();
    await page.waitForFunction(async () => {
      const databases = await indexedDB.databases(); return databases.some(db => db.name === 'BiliAnalyticsDB');
    });
    result.storage = await page.evaluate(seedPage, { namespace, seed: fixture.seed });
    await page.reload();
    await page.locator('.knowledge-card').filter({ hasText: 'Synthetic directory recovery' }).waitFor();
    await page.waitForFunction(() => {
      const button = document.querySelector('.knowledge-sync');
      return button?.textContent.includes('3 项待写入') && !document.querySelector('.knowledge-toolbar button[disabled]');
    });
    const initial = await page.evaluate(snapshotPage, { namespace });
    result.before = evidence(initial);
    assert.equal(initial.pending, 3);
    assert.equal(initial.nativeHandle, true);
    assert.equal(initial.boundToOriginal, true, 'Original OPFS handle must survive native IndexedDB structured cloning');
    assert.equal(initial.meta.connectionRevision, fixture.seed.state.connectionRevision);
    assert.equal(initial.files.some(file => file.path === fixture.seed.remoteFile.path), false, 'Remote branch must start outside IndexedDB');
    assert.equal(initial.old.files.filter(file => file.bytes.length === 0).length, 3);
    assert.deepEqual(initial.destination.entries, []);
    result.checks.push('native OPFS handle round-trips through production IndexedDB; three exact pending files remain zero-byte on disk');
    await page.locator('.knowledge-sync').click();
    const storageDialog = page.getByRole('dialog', { name: '本地目录', exact: true });
    await storageDialog.getByRole('button', { name: '恢复到新目录', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '恢复到新目录', exact: true });
    await dialog.getByRole('button', { name: '检查恢复内容', exact: true }).click();
    await dialog.getByRole('heading', { name: '恢复预览', exact: true }).waitFor();
    const previewText = await dialog.innerText(); result.previewText = previewText;
    assert.match(previewText, /1 个页面.*1 张图片.*1 份资料.*3 个版本/);
    assert.match(previewText, /补全 3 个未写完的文件，保留 1 个待合并分支/);
    const checkbox = dialog.getByRole('checkbox', { name: pauseLabel, exact: true });
    const submit = dialog.getByRole('button', { name: submitLabel, exact: true });
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await submit.isDisabled(), true);
    assertPreserved(initial, await page.evaluate(snapshotPage, { namespace }));
    result.checks.push('production preview merges both branches and resources without writing; acknowledgement defaults off and submit is disabled');
    if (scenario === 'recover') await captureWidths(page, out, report, result, 'unchecked', dialog);
    await checkbox.check();
    assert.equal(await submit.isEnabled(), true);
    if (scenario === 'recover') await captureWidths(page, out, report, result, 'acknowledged', dialog);
    let before = initial;
    if (scenario === 'source-empty-child') {
      // Create this adversarial child after preview; the scanner correctly rejects unknown library directories.
      await page.evaluate(async ({ namespace }) => {
        const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(namespace);
        const old = await folder.getDirectoryHandle('old');
        await old.getDirectoryHandle('empty-child', { create: true });
      }, { namespace });
      before = await page.evaluate(snapshotPage, { namespace });
      result.fixtureMutation = 'Created one synthetic empty descendant after preview, before the selection baseline; no production mutation is exempted.';
      result.beforeSelection = evidence(before);
      assert.ok(before.old.entries.some(entry => entry.path === 'empty-child' && entry.kind === 'directory'));
    }
    await page.evaluate(choice => { window.__directoryRecoveryQA.choice = choice; }, scenario);
    await submit.click();
    if (scenario === 'recover') {
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('status').filter({ hasText: /^已恢复到新目录，原目录已保留。/ }).waitFor();
      const after = await page.evaluate(snapshotPage, { namespace });
      result.after = evidence(after);
      await assertRecovered(after, initial, fixture);
      result.checks.push('old entry list and all bytes unchanged; destination and IndexedDB contain two valid heads, exact source and image; queue is zero and connectionRevision grows');
      await capture(page, out, report, result, 'complete');
      await page.reload();
      await page.getByRole('button', { name: '目录已同步', exact: true }).waitFor();
      const reloaded = await page.evaluate(snapshotPage, { namespace });
      await assertRecovered(reloaded, initial, fixture);
      result.afterReload = evidence(reloaded);
      result.checks.push('native destination handle, both heads, resources and empty queue survive production UI reload');
    } else {
      const message = scenario === 'cancel' ? '已取消，已保存的内容保留。' : '请选择原目录之外的空文件夹，不能选择其上级或子目录。原目录与本地记录均保留。';
      await dialog.getByRole('status').filter({ hasText: message }).waitFor();
      const after = await page.evaluate(snapshotPage, { namespace });
      result.after = evidence(after); assertPreserved(before, after);
      assert.equal(await dialog.getByRole('button', { name: submitLabel, exact: true }).count(), 0, 'A rejected/cancelled preview must be discarded');
      result.checks.push(scenario === 'cancel' ? 'user cancellation preserves the queue, connection, original tree and empty destination' : 'overlapping native handle rejected before creating nested Bili-Bill; original entry list and queue unchanged');
      await captureWidths(page, out, report, result, 'rejected-or-cancelled', dialog);
      if (scenario === 'cancel') {
        await dialog.getByRole('button', { name: '检查恢复内容', exact: true }).click();
        await dialog.getByRole('heading', { name: '恢复预览', exact: true }).waitFor();
        assert.equal(await checkbox.isChecked(), false);
        assert.equal(await submit.isDisabled(), true);
        assertPreserved(before, await page.evaluate(snapshotPage, { namespace }));
        result.checks.push('after cancellation a new preview is available and acknowledgement resets to unchecked');
      }
    }
    const final = await page.evaluate(snapshotPage, { namespace });
    const interaction = result.after;
    assert.equal(interaction.pickerCalls.length, 1);
    assert.deepEqual(interaction.pickerCalls[0], { choice: scenario, options: { mode: 'readwrite', id: 'bili-bill-recovery' } });
    result.permissionFallbacks = scenario === 'recover' ? [...interaction.permissionFallbacks, ...final.permissionFallbacks] : final.permissionFallbacks;
    result.pickerCalls = interaction.pickerCalls;
    assert.deepEqual(result.externalResponses, [], 'No external network response is allowed');
    assert.deepEqual(result.pageErrors, []);
    assert.deepEqual(result.unexpectedDialogs, []);
    result.status = 'pass';
  } catch (error) {
    result.status = 'fail'; result.error = error.stack ?? String(error);
    if (page && !page.isClosed()) {
      try { await capture(page, out, report, result, 'failure'); } catch (captureError) { result.captureError = captureError.message; }
      try { result.failureSnapshot = evidence(await page.evaluate(snapshotPage, { namespace })); } catch (snapshotError) { result.snapshotError = snapshotError.message; }
    }
  } finally {
    if (context) {
      try { await context.close(); }
      catch (error) { result.status = 'fail'; result.closeError = error.stack ?? String(error); }
    }
    result.finishedAt = new Date().toISOString();
  }
}

async function main() {
  const out = path.join(root, 'release-artifacts', `directory-recovery-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const reportFile = path.join(out, 'report.json');
  const report = {
    schemaVersion: 1, out, report: reportFile,
    kind: 'production_extension_directory_recovery_offline_qa', status: 'running', startedAt: new Date().toISOString(),
    sourceCommit: process.env.UX014_SOURCE_COMMIT ?? null,
    sourceCommitProvenance: process.env.UX014_SOURCE_COMMIT ? 'caller-supplied; not checked by Git' : 'unresolved; Git not invoked',
    sourceTree: process.env.UX014_SOURCE_TREE ?? null,
    sourceTreeProvenance: process.env.UX014_SOURCE_TREE ? 'caller-supplied Git tree; not checked by Git' : 'unresolved; Git not invoked',
    workingTreeDirty: process.env.UX014_WORKING_TREE_DIRTY === 'true' ? true : process.env.UX014_WORKING_TREE_DIRTY === 'false' ? false : null,
    dirtyProvenance: process.env.UX014_WORKING_TREE_DIRTY ? 'caller-supplied; not checked by Git' : 'unresolved; Git not invoked',
    sourceContentSha256: null, sourceContentHashKind: 'sha256 of sorted production-source and script file manifest; not a Git tree',
    scriptSha256: null, gitInvoked: false, syntheticData: true, productionExtension: true,
    storage: 'native OPFS and native BiliAnalyticsDB okFiles/okMeta',
    networkBlocked: true, realModelCalls: 0, personalBrowserStateRead: false, personalDirectoryRead: false,
    nativeHostInstalled: false, nativeDirectoryPicker: 'not_completed; controlled OPFS picker stub in fresh extension page only',
    permissionControl: 'native methods retained when supported; unsupported permission methods may grant only this synthetic OPFS subtree',
    realSiteAcceptance: 'not_completed', results: [], screenshots: [], files: {},
  };
  await mkdir(path.join(out, 'screens'), { recursive: true });
  try {
    assert.deepEqual(process.argv.slice(2), [], 'Use --help or run without arguments');
    report.scriptSha256 = sha(await readFile(fileURLToPath(import.meta.url)));
    report.sourceFiles = await sourceManifest();
    report.sourceContentSha256 = sha(JSON.stringify(report.sourceFiles));
    const playwrightModule = process.env.UX014_PLAYWRIGHT_MODULE;
    const chrome = process.env.UX014_CHROME_EXECUTABLE ?? process.env.CHROME_EXECUTABLE;
    const edge = process.env.UX014_EDGE_EXECUTABLE ?? process.env.EDGE_EXECUTABLE;
    assert.ok(playwrightModule, 'Set UX014_PLAYWRIGHT_MODULE to an existing Playwright module file');
    assert.ok(chrome, 'Set UX014_CHROME_EXECUTABLE or CHROME_EXECUTABLE');
    assert.ok(edge, 'Set UX014_EDGE_EXECUTABLE or EDGE_EXECUTABLE');
    if (report.sourceCommit !== null) assert.match(report.sourceCommit, /^[a-f0-9]{40}$/i, 'Source commit must be a full supplied SHA');
    if (report.sourceTree !== null) assert.match(report.sourceTree, /^[a-f0-9]{40}$/i, 'Source tree must be a full supplied Git tree SHA');
    if (process.env.UX014_WORKING_TREE_DIRTY !== undefined) assert.ok(['true', 'false'].includes(process.env.UX014_WORKING_TREE_DIRTY), 'Dirty metadata must be true or false');
    report.distSha256 = await fileManifest(path.join(root, 'dist'));
    const javascript = Object.keys(report.distSha256).filter(name => name.endsWith('.js'));
    const text = (await Promise.all(javascript.map(name => readFile(path.join(root, 'dist', name), 'utf8')))).join('\n');
    const markers = ['恢复到新目录', '检查恢复内容', submitLabel, pauseLabel, 'recovery_destination', 'connectionRevision'];
    const escaped = value => Array.from(value).map(char => char.charCodeAt(0) > 127 ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char).join('');
    for (const marker of markers) assert.ok(text.includes(marker) || text.includes(escaped(marker)), `Build dist with the current recovery UI first: missing ${marker}`);
    const sourceTimes = await Promise.all(recoverySources.map(async name => ({ path: name, modifiedMs: (await stat(path.join(root, name))).mtimeMs })));
    const dashboardTime = (await stat(path.join(root, 'dist/dashboard.js'))).mtimeMs;
    report.buildReadiness = { markers, recoverySourceTimes: sourceTimes, dashboardModifiedMs: dashboardTime,
      method: 'runtime markers, recovery-source mtime guard and before/after source/dist hashes; not a signed build attestation' };
    assert.ok(sourceTimes.every(file => file.modifiedMs <= dashboardTime), 'Recovery sources are newer than dist/dashboard.js; ask the parent to build first');
    const { chromium } = await import(pathToFileURL(path.resolve(playwrightModule)).href);
    const fixture = await buildFixtures();
    report.fixture = { libraryId: fixture.seed.libraryId, base: fixture.base.id, localHead: fixture.local.id, remoteHead: fixture.remote.id,
      image: fixture.image.id, source: fixture.source.id, pending: 3, connectionRevision: fixture.seed.state.connectionRevision,
      files: evidence({ old: { entries: [], files: [] }, destination: { entries: [], files: [] }, files: fixture.seed.localFiles }).files };
    for (const [browser, executable] of [['Chrome', chrome], ['Edge', edge]]) {
      for (const scenario of scenarios) await runScenario(chromium, executable, browser, scenario, fixture, out, report);
    }
    assert.deepEqual(await fileManifest(path.join(root, 'dist')), report.distSha256, 'dist changed during QA; results do not describe one stable build');
    assert.deepEqual(await sourceManifest(), report.sourceFiles, 'Source changed during QA; rerun against a stable parent build');
    assert.equal(report.results.length, 8);
    assert.ok(report.results.every(result => result.status === 'pass'), 'One or more isolated browser scenarios failed');
    report.status = 'pass';
  } catch (error) {
    report.status = 'fail'; report.error = error.stack ?? String(error); process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    for (const { file } of report.screenshots) {
      try { report.files[file] = sha(await readFile(path.join(out, file))); }
      catch (error) { report.status = 'fail'; report.evidenceError = error.message; process.exitCode = 1; }
    }
    const reportBytes = JSON.stringify(report, null, 2) + '\n';
    await writeFile(reportFile, reportBytes);
    console.log(JSON.stringify({ out, status: report.status, report: reportFile, reportSha256: sha(reportBytes),
      results: report.results.map(({ browser, scenario, status, error }) => ({ browser, scenario, status, error })), error: report.error }));
  }
}
