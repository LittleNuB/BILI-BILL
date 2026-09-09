import assert from 'node:assert/strict';
import test from 'node:test';
import { readableModelOutput } from '../src/shared/readable-model-output.ts';
import { chatJson } from '../src/background/ai/openai-compatible.ts';

test('prose survives excessive point counts and invalid citation metadata', () => {
  const points = Array.from({length:8},(_,i)=>({text:`第 ${i+1} 个完整回答要点。`,evidenceLineNumbers:[999]}));
  const text = readableModelOutput({answerPoints:points,citations:[{sourceHash:'private',text:'not answer'}]},'qa');
  assert.match(text,/第 8 个/); assert.doesNotMatch(text,/999|private|sourceHash|not answer/);
});
test('summary and highlights remain plain prose without fabricated timeline actions', () => {
  assert.equal(readableModelOutput({summarySentences:[{text:'总结'}],keyPoints:[{text:'要点'}],highlights:[{title:'亮点',description:'详细解释',startSeconds:123}]},'summary'),'总结\n\n要点\n\n亮点\n详细解释');
});
test('plain text and fenced JSON are readable; unrelated object metadata is not dumped', () => {
  assert.equal(readableModelOutput('这是自然语言回答。','qa'),'这是自然语言回答。');
  assert.equal(readableModelOutput('42','qa'),'42');
  assert.equal(readableModelOutput('```json\n{"answer":"保留正文"}\n```','qa'),'保留正文');
  assert.equal(readableModelOutput({sourceHash:'secret',citations:[1]},'qa'),'');
  assert.doesNotMatch(readableModelOutput({answer:'正文\nsourceHash=private\nsubtitle_url=https://private.invalid'},'qa'),/private|sourceHash|subtitle_url/);
});
test('plain-text response is opt-in and does not loosen other JSON callers', async () => {
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'可读的自然语言回答'}}]}));
  const config={apiKey:'synthetic',baseURL:'https://example.invalid',chatModel:'synthetic'};
  try {
    await assert.rejects(chatJson(config,[]),/AI_RESPONSE_INVALID_JSON/);
    assert.equal(await chatJson(config,[],{allowTextResponse:true}),'可读的自然语言回答');
  } finally {globalThis.fetch=original;}
});
