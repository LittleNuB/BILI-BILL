import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_PROMPTS_KEY, DEFAULT_PROMPTS, normalizePromptState, promptFingerprint, promptText, withPromptPreference } from '../src/shared/ai-prompts.ts';
import { promptSnapshot, editPrompt, rewritePrompt, handlePromptSettings } from '../src/background/ai/prompt-settings.ts';
import { DEFAULT_CONFIG } from '../src/shared/types/config.ts';
import { clearStoredUserConfigAndAdvanceRevision } from '../src/background/storage/config-store.ts';
import { buildCurrentVideoSummaryHighlightsCacheKey } from '../src/background/storage/current-video-summary-highlights-repo.ts';
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

test('custom prompt cannot replace fixed contract and summary cache binds only the effective customization', () => {
  const state=normalizePromptState(null), custom={...state,values:{overview:'简短输出'}};
  const key={identity:{sourceIdentityKey:'same-source'},model:'same-model'};
  assert.notEqual(buildCurrentVideoSummaryHighlightsCacheKey(key),buildCurrentVideoSummaryHighlightsCacheKey({...key,promptFingerprint:promptFingerprint(custom,'overview')}));
  assert.equal(buildCurrentVideoSummaryHighlightsCacheKey(key),buildCurrentVideoSummaryHighlightsCacheKey({...key,promptFingerprint:promptFingerprint(state,'overview')}));
  assert.match(withPromptPreference('必须引用真实行号','使用更通俗的文字'),/固定规则：\n必须引用真实行号$/);
  assert.throws(()=>normalizePromptState({revision:'1',values:{chat:'x'.repeat(4001)},previous:{}}),/PROMPT_INPUT/);
});
