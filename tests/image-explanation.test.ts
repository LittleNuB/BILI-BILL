import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImageExplanation, renderImageExplanation } from '../src/dev/acceptance/image-explanation.ts';

const answer = { purpose: '说明代码审查所用项目。', observations: ['画面显示一个仓库主页。'],
  captionRelation: '附近字幕记载要审查一个小项目；字幕不能确认仓库的代码质量。', limitations: '小字无法核实，未提供音频。' };
test('bounded explanation validates source-separated prose and renders without exposing schema', () => {
  const parsed = parseImageExplanation(JSON.stringify(answer));
  assert.equal(parsed.ok, true);
  assert.equal(renderImageExplanation(parsed.value!), '说明代码审查所用项目。\n\n画面观察\n- 画面显示一个仓库主页。\n\n字幕与画面的关系\n附近字幕记载要审查一个小项目；字幕不能确认仓库的代码质量。\n\n限制\n小字无法核实，未提供音频。');
});
test('invalid output is rejected without shortening or repairing the original', () => {
  for (const changed of [
    { ...answer, observations: Array(5).fill('相互不同的细节。') },
    { ...answer, purpose: '字'.repeat(81) }, { ...answer, captionRelation: '字'.repeat(141) },
    { ...answer, limitations: '字'.repeat(101) }, { ...answer, observations: ['字'.repeat(81)] },
    { ...answer, observations: [] }, { ...answer, answer: '额外字段' },
    { ...answer, observations: ['- 一项\n- 第二项'] }, { ...answer, purpose: '来源[1]' },
    { ...answer, purpose: '<script>操作</script>' }, { ...answer, purpose: '12:30 已核实' },
    { ...answer, purpose: '字'.repeat(80), observations: Array(3).fill('字'.repeat(80)), captionRelation: '字'.repeat(140), limitations: '字'.repeat(100) },
  ]) {
    const raw = JSON.stringify(changed);
    const result = parseImageExplanation(raw);
    assert.equal(result.ok, false, raw);
    assert.equal(result.value, undefined); assert.equal(raw, JSON.stringify(changed));
  }
  assert.equal(parseImageExplanation('画面观察：自由文本。').ok, false);
});
test('structural pass does not claim factual correctness or rewrite an identifier', () => {
  const wrong = { ...answer, observations: ['仓库名为 temnparse。'] };
  const result = parseImageExplanation(JSON.stringify(wrong));
  assert.equal(result.ok, true);
  assert.match(renderImageExplanation(result.value!), /temnparse/);
});
