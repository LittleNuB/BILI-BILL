import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { X } from 'lucide-preact';
export function KnowledgeDialog({ title, close, children }: { title: string; close(): void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="knowledge-dialog" aria-label={title} onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2>{title}</h2><button className="bb-icon-action" title="关闭" aria-label="关闭" onClick={close}><X size={18} /></button></header>{children}
  </dialog>;
}
