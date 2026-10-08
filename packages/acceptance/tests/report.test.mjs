import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlReport, verdict } from '../report.mjs';
const report = row => ({plan:{id:'synthetic',steps:[{}]},planHash:'synthetic',legacy:{tokens:0,calls:0,callLimit:48},rows:[row],evidence:{mock:true},pause:null});
test('readable explanation and exact raw response remain local and escaped; format success is not a grade', () => {
  const row = {id:'image',state:'complete',checks:{format:true},displayText:'画面观察\n- <img src=x onerror=alert(1)>',text:'{"purpose":"<script>"}'};
  const html = htmlReport(report(row));
  assert.match(html, /画面观察/); assert.match(html, /&lt;img/); assert.match(html, /&lt;script/);
  assert.doesNotMatch(html, /<img|<script/); assert.match(html, /原始模型输出/);
  assert.equal(verdict(row), '待审阅');
  const failed = htmlReport(report({...row,checks:{format:false}}));
  assert.doesNotMatch(failed, /画面观察/); assert.match(failed, /结构未通过/); assert.match(failed, /&lt;script/);
});
