// Synthetic QA provider only. This file is never imported by production.
() => {
  self.syntheticLearningRequests = { ai: 0, subtitle: 0, blocked: 0 };
  self.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/x/player/')) return json({ code: 0, data: { subtitle: { subtitles: [{ id: 1, lan: 'zh-CN', lan_doc: '中文', subtitle_url: 'https://aisubtitle.hdslb.com/synthetic-learning.json' }] } } });
    if (url === 'https://aisubtitle.hdslb.com/synthetic-learning.json') {
      self.syntheticLearningRequests.subtitle++;
      return json({ body: [
        { from: 0, to: 2, content: '先明确用户要解决的问题。' },
        { from: 2, to: 4, content: '约束范围，保留一个完整的学习闭环。' },
        { from: 4, to: 6, content: '保存自己的理解，并回到原句验证。' },
      ] });
    }
    if (url.includes('/chat/completions')) {
      self.syntheticLearningRequests.ai++;
      const payload = JSON.parse(init.body);
      const summary = payload.messages.some(message => String(message.content).includes('summarySentences'));
      const result = summary ? {
        summarySentences: [{ text: '明确用户问题，围绕最小学习闭环组织产品。', evidenceLineNumbers: [1, 2] }],
        keyPoints: [{ text: '保存理解后回到原句验证。', evidenceLineNumbers: [3] }],
        highlights: [{ title: '形成学习闭环', description: '约束范围，保存理解并核对原句。', evidenceLineNumbers: [2, 3] }],
      } : { supported: true, answerPoints: [{ text: '先明确问题，再约束范围，最后保存理解并核对原句。', evidenceLineNumbers: [1, 2, 3] }], citations: [{ evidenceLineNumbers: [1, 2, 3] }] };
      return json({ choices: [{ message: { content: JSON.stringify(result) } }] });
    }
    self.syntheticLearningRequests.blocked++;
    throw Error('Synthetic provider blocks all other requests');
  };
}
