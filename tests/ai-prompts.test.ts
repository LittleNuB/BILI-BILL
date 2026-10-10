import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_PROMPTS_KEY, DEFAULT_PROMPTS, normalizePromptState, promptFingerprint, promptText, withPromptPreference } from '../src/shared/ai-prompts.ts';
import { promptSnapshot, editPrompt, rewritePrompt, handlePromptSettings } from '../src/background/ai/prompt-settings.ts';
import { DEFAULT_CONFIG } from '../src/shared/types/config.ts';
import { clearStoredUserConfigAndAdvanceRevision } from '../src/background/storage/config-store.ts';
import { buildCurrentVideoSummaryHighlightsCacheKey } from '../src/background/storage/current-video-summary-highlights-repo.ts';
import { buildLearningChatMessages } from '../src/shared/learning-chat.ts';
import { SUBTITLE_CORRECTION_PROMPT, parseCorrection } from '../src/shared/subtitle-correction.ts';
import { IMAGE_GROUNDING_PROMPT } from '../src/shared/image-grounding-prompt.ts';
const originalFetch = globalThis.fetch;

test('prompt settings serialize concurrent edits, preview without applying, undo/reset and reject stale data after clear', async () => {
  const listeners = new Set<Function>();
  const storage: Record<string, any> = { userConfig: { ...structuredClone(DEFAULT_CONFIG), ai: { baseURL:'https://example.invalid',apiKey:'synthetic',chatModel:'test' } } };
  globalThis.chrome = { storage: { local: {
    get: async (keys: string | string[]) => Object.fromEntries((typeof keys==='string'?[keys]:keys).map(key=>[key,structuredClone(storage[key])])),
    set: async values => { for (const [key,value] of Object.entries(values)) { storage[key]=structuredClone(value); for (const fn of listeners) fn({[key]:{newValue:value}},'local'); } },
    remove: async (keys: string | string[]) => { for (const key of typeof keys==='string'?[keys]:keys) delete storage[key]; },
  }, onChanged: { addListener: (fn: Function) => listeners.add(fn), removeListener: (fn: Function) => listeners.delete(fn) } } } as any;
  try {
    const start=await promptSnapshot();
    const first=await editPrompt({...start,mode:'save',feature:'chat',text:'先举一个例子，再说明原理。'});
    assert.equal(promptText(first,'chat'),'先举一个例子，再说明原理。');
    await assert.rejects(editPrompt({...start,mode:'save',feature:'overview',text:'并发覆盖'}),/PROMPT_STALE/);
    const undone=await editPrompt({...first,mode:'undo',feature:'chat'});
    assert.equal(promptText(undone,'chat'),DEFAULT_PROMPTS.chat);
    const changed=await editPrompt({...undone,mode:'save',feature:'overview',text:'分为问题、做法、结论。'});
    const reset=await editPrompt({...changed,mode:'reset',feature:'overview'});
    assert.equal(promptText(reset,'overview'),DEFAULT_PROMPTS.overview);
    const before=structuredClone(storage), payloads:any[]=[];
    globalThis.fetch=async(_url,options)=>{payloads.push(JSON.parse(String(options?.body)));return new Response(JSON.stringify({choices:[{message:{content:'先用一句话回答，再解释概念。'}}]}));};
    const rewrite={...reset,mode:'rewrite',feature:'chat',text:DEFAULT_PROMPTS.chat,instruction:'更加简洁',requestId:'rewrite-one'};
    assert.equal((await rewritePrompt(rewrite)).text,'先用一句话回答，再解释概念。');
    assert.deepEqual(storage,before);assert.equal(payloads.length,1);
    assert.deepEqual(Object.keys(JSON.parse(payloads[0].messages[1].content)),['feature','prompt','request']);
    let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
    globalThis.fetch=async(_url,options)=>new Response(new ReadableStream({start(controller){options?.signal?.addEventListener('abort',()=>controller.error(new Error('stop')));started();}}));
    const pending=rewritePrompt({...rewrite,requestId:'cancelled'});await ready;
    await handlePromptSettings({mode:'cancel',requestId:'cancelled'});await assert.rejects(pending);assert.equal(listeners.size,0);
    await clearStoredUserConfigAndAdvanceRevision();delete storage[AI_PROMPTS_KEY];
    await assert.rejects(editPrompt({...reset,mode:'save',feature:'chat',text:'清理前的旧草稿'}),/PROMPT_STALE/);
    assert.equal(storage[AI_PROMPTS_KEY],undefined);
  } finally { globalThis.fetch=originalFetch; }
});

test('custom prompt cannot replace fixed contract and summary cache binds the effective default or customization', () => {
  const state=normalizePromptState(null), custom={...state,values:{overview:'简短输出'}};
  const key={identity:{sourceIdentityKey:'same-source'},model:'same-model'};
  assert.notEqual(buildCurrentVideoSummaryHighlightsCacheKey(key),buildCurrentVideoSummaryHighlightsCacheKey({...key,promptFingerprint:promptFingerprint(custom,'overview')}));
  assert.notEqual(buildCurrentVideoSummaryHighlightsCacheKey(key),buildCurrentVideoSummaryHighlightsCacheKey({...key,promptFingerprint:promptFingerprint(state,'overview')}));
  assert.notEqual(promptFingerprint(state,'overview'),promptFingerprint(custom,'overview'));
  assert.equal(promptFingerprint(state,'overview'),promptFingerprint({...state,values:{chat:'另一个对话风格'}},'overview'));
  assert.match(withPromptPreference('必须引用真实行号','使用更通俗的文字'),/固定规则：\n必须引用真实行号$/);
  assert.throws(()=>normalizePromptState({revision:'1',values:{chat:'x'.repeat(4001)},previous:{}}),/PROMPT_INPUT/);
});

test('prose and structured capabilities have distinct formats without overwriting preferences', () => {
  const defaults=normalizePromptState(null);
  for (const value of Object.values(DEFAULT_PROMPTS)) assert.ok(value.length < 4000);
  const custom={...defaults,values:{chat:'先举例再解释。'}};
  assert.equal(promptText(custom,'chat'),'先举例再解释。');
  const input={question:'解释这个概念',session:null,videoText:'',videoTitle:null,preference:promptText(custom,'chat')};
  const plain=buildLearningChatMessages(input)[0].content;
  assert.match(plain,/先举例再解释/);assert.match(plain,/可读 Markdown/);assert.match(plain,/不输出 JSON/);
  assert.match(plain,/简单问题不强行分节/);assert.match(plain,/不可把以前的观点归给新视频/);
  const image=buildLearningChatMessages({...input,imagePreference:DEFAULT_PROMPTS.image})[0].content;
  assert.match(image,/画面观察/);assert.match(image,/看不清的文字或数字不补写/);
  assert.match(DEFAULT_PROMPTS.overview,/JSON/);assert.match(DEFAULT_PROMPTS.subtitles,/JSON/);
  assert.match(SUBTITLE_CORRECTION_PROMPT,/每行一一对应/);
  assert.throws(()=>parseCorrection('{"lines":[{"id":"different","text":"捏造"}]}',[{id:'original',text:'原文'}]),/CORRECTION_FORMAT/);
  assert.deepEqual(parseCorrection('{"lines":[{"id":"original","text":"原文。"}]}',[{id:'original',text:'原文'}]),{original:'原文。'});
});

test('image requests use one image contract after both preferences, without nesting chat instructions', () => {
  const input = { question: '说明画面与字幕的关系', session: null, videoText: '可能有识别错误的原字幕', videoTitle: '合成视频',
    preference: '语气简洁。', imagePreference: '先说明图片用途。' };
  const messages = buildLearningChatMessages(input);
  const system = messages[0].content + IMAGE_GROUNDING_PROMPT;
  assert.equal(system.split('固定规则：').length - 1, 1);
  assert.ok(system.indexOf('语气简洁。') < system.indexOf('固定规则：'));
  assert.ok(system.indexOf('先说明图片用途。') < system.indexOf('固定规则：'));
  assert.doesNotMatch(system, /引用视频观点的段落用「视频内容」标注/);
  assert.match(system, /不列文件清单、提交哈希、版本号或界面计数/);
  assert.match(system, /字幕可能有误/);
  assert.match(system, /历史问答.*不是.*证据/);
  assert.match(system, /不.*声称.*保存、记忆、跳转/);
  assert.ok(messages.some(message => message.content.includes(input.videoText)));
  assert.equal(messages.at(-1)?.content, input.question);
  // Each preference has its own existing 4000-character bound, not one combined bound.
  assert.doesNotThrow(() => buildLearningChatMessages({ ...input, preference: '甲'.repeat(2500), imagePreference: '乙'.repeat(2500), budget: 65536 }));
});
