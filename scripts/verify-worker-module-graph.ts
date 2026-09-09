import type { OutputBundle } from 'rolldown';

export function verifyWorkerModuleGraph(bundle: OutputBundle, entry: string) {
  const pending = [entry]; const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue; visited.add(file);
    const chunk = bundle[file];
    if (!chunk || chunk.type !== 'chunk') throw Error(`Missing worker module: ${file}`);
    if (chunk.dynamicImports.length) throw Error(`MV3 worker cannot dynamically import: ${file} -> ${chunk.dynamicImports.join(', ')}`);
    for (const dependency of chunk.imports) {
      if (!bundle[dependency]) throw Error(`External worker module is not packaged: ${dependency}`);
      pending.push(dependency);
    }
  }
  return visited.size;
}
