import type { BiliVizContentMessage } from '../../shared/types/messages';

// An extension update can make sendMessage throw before returning a promise.
export function createMonitorSender(
  send: (message: BiliVizContentMessage) => Promise<unknown>,
  onInvalidated: () => void,
): (message: BiliVizContentMessage) => void {
  let invalidated = false;
  const failed = (error: unknown) => {
    if (!invalidated && error instanceof Error && error.message.includes('Extension context invalidated')) {
      invalidated = true;
      onInvalidated();
    }
    // Transient worker failures remain retryable on the next player event.
  };
  return message => {
    if (invalidated) return;
    try { void send(message).catch(failed); } catch (error) { failed(error); }
  };
}
