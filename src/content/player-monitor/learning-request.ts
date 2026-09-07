import type {
  BiliVizResponse,
  RequestAction,
} from "../../shared/types/messages.ts";

const CONNECTION_MESSAGE = "连接已中断，请重试确认保存结果。";

export async function requestLearning<T>(
  action: RequestAction,
  params?: Record<string, unknown>,
): Promise<T> {
  let response: BiliVizResponse<T>;
  try {
    response = await chrome.runtime.sendMessage({ action, params });
  } catch {
    throw Error(CONNECTION_MESSAGE);
  }
  if (!response?.success) throw Error(response?.error ?? CONNECTION_MESSAGE);
  return response.data as T;
}
