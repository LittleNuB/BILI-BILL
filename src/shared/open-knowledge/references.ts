export interface ReadonlyMarkdownHandle extends FileSystemFileHandle {
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
}
export interface KnowledgeReadonlyReference {
  id: string; name: string; handle: ReadonlyMarkdownHandle; text: string; digest: string;
  available: boolean; checkedAt: number;
}
export const REFERENCE_MAX_BYTES = 2 * 1024 * 1024;
export const REFERENCES_MAX_BYTES = 32 * 1024 * 1024;
export async function pickReadonlyMarkdown(): Promise<ReadonlyMarkdownHandle[]> {
  const picker = (globalThis as unknown as { showOpenFilePicker?: (options: object) => Promise<ReadonlyMarkdownHandle[]> }).showOpenFilePicker;
  if (!picker) throw Error('knowledge_browser_unsupported');
  return picker({ multiple: true, id: 'bili-bill-references', excludeAcceptAllOption: true,
    types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }] });
}
