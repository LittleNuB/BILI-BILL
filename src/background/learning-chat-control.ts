import type { CurrentVideoQaSourceSnapshot } from '../shared/types/current-video-qa-session.ts';

export interface RunningLearningChat {
  controller: AbortController;
  tabId: number | null;
  sessionId: string;
  turnId: string;
  text: string;
  notice?: string;
  source?: CurrentVideoQaSourceSnapshot | null;
}

// Kept separate from transport/storage so lifecycle owners can abort immediately.
export const activeLearningChats = new Map<string, RunningLearningChat>();
export function cancelLearningChats(matches: (chat: RunningLearningChat, requestId: string) => boolean = () => true): void {
  for (const [requestId, chat] of activeLearningChats) {
    if (matches(chat, requestId)) chat.controller.abort();
  }
}
