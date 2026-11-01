import { FilePlus2, Settings, Image, FolderOpen, Video } from 'lucide-preact';
import { KnowledgeDialog } from './KnowledgeDialog.tsx';
import type { KnowledgeSetup } from './setup-navigation.ts';

interface Props {
  close(): void;
  create(): void;
  video(): void;
  setup(target: KnowledgeSetup): void;
  directory(): void;
  editing: boolean;
  busy: boolean;
}
export function KnowledgeHelp({ close, create, video, setup, directory, editing, busy }: Props) {
  return <KnowledgeDialog title="开始记录" close={close}>
    <div className="knowledge-help">
      <p>不配置 AI 或目录，也可以先保存笔记和图片。</p>
      <div className="knowledge-actions">
        <button className="knowledge-button is-primary" disabled={editing || busy} onClick={create}><FilePlus2 size={17} />新建个人页</button>
        <button className="knowledge-button" onClick={video}><Video size={17} />去 B 站学习</button>
      </div>
      <section><h3>边看边记</h3><p>播放器旁的纸笔记下当前时间点；相机把画面存入笔记。没有字幕也能保存。</p></section>
      <section><h3>保存后找回</h3><p>记录保存在此浏览器，在知识库中按视频或页面查找。连接目录后，才能在其他本地工具中读取。</p></section>
      <details><summary>按需配置</summary>
        <div className="knowledge-actions">
          <button className="knowledge-button" disabled={busy} onClick={() => setup('ai')}><Settings size={16} />文字 AI</button>
          <button className="knowledge-button" disabled={busy} onClick={() => setup('vision')}><Image size={16} />图片模型</button>
          <button className="knowledge-button" disabled={busy} onClick={directory}><FolderOpen size={16} />本地目录</button>
        </div>
        <p>连接检查会发送一条测试消息并产生少量用量，不会自动开启学习资料授权。</p>
      </details>
      <details><summary>在 Codex 中取用</summary>
        <ol>
          <li>连接本地目录，等到“目录已同步”。</li>
          <li>在验收包中找到 Codex 插件包，按其说明填写知识库目录和身份。</li>
          <li>在 Codex 本地插件入口安装；没有该入口时，按包内说明配置 MCP 和 Skill。</li>
        </ol>
        <p>先检索和查看来源；正文修改先展示差异并由你确认。安装或写回不会在这里自动执行。</p>
      </details>
    </div>
  </KnowledgeDialog>;
}
