export function learningChatErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    CHAT_AUTH: 'AI 服务认证失败，请检查服务地址、密钥及模型访问权限。',
    CHAT_BALANCE: 'AI 服务余额不足，请检查服务账户。',
    CHAT_NOT_FOUND: '服务地址或模型未找到，请检查 AI 设置中的地址与模型名。',
    CHAT_RATE_LIMIT: '请求过于频繁，请稍后重试。',
    CHAT_SERVICE: 'AI 服务暂不可用，请稍后重试。',
    CHAT_NETWORK: '无法连接 AI 服务，请检查网络和服务地址后重试。',
    CHAT_TIMEOUT: 'AI 服务响应超时，请稍后重试。',
    CHAT_BAD_REQUEST: '服务未接受请求参数，请检查服务地址、模型名及图片输入支持。',
    CHAT_IMAGE_UNSUPPORTED: '服务未接受图片输入，请检查模型与图片格式；截图和笔记仍保留。',
    CHAT_PAYLOAD_LIMIT: '服务拒绝了过大的请求，请减少图片数量或使用较小图片。',
    CHAT_REASONING_LIMIT: '模型在思考阶段耗尽了输出预算，尚未返回正文。请切换非思考模型或非思考模式后重试。',
    CHAT_OUTPUT_LIMIT: '回答达到输出长度上限，已收到的正文仍保留。可以缩小问题范围后重试。',
    CHAT_EMPTY: '服务没有返回回答正文，请检查模型兼容性后重试。',
    CHAT_RESPONSE_FORMAT: '服务返回的内容格式无法读取，请检查接口是否兼容聊天请求。',
    CHAT_INTERRUPTED: '回答传输中断，已收到的正文仍保留，请重试。',
  };
  return messages[code] ?? '回答未完成，问题、图片及已收到的正文仍保留，请重试。';
}
