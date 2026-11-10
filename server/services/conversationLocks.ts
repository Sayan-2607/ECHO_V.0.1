/**
 * One in-flight agent run per conversation. A second message to the same conversation while
 * one is running is rejected (409) instead of interleaving two runs' memory writes.
 * Different conversations run concurrently.
 */
export class ConversationLocks {
  private active = new Map<string, AbortController>();

  tryAcquire(conversationId: string, controller: AbortController): boolean {
    if (this.active.has(conversationId)) return false;
    this.active.set(conversationId, controller);
    return true;
  }

  release(conversationId: string, controller: AbortController): void {
    if (this.active.get(conversationId) === controller) this.active.delete(conversationId);
  }

  isActive(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  /** Aborts the active run, if any (used when a conversation is deleted mid-run). */
  abort(conversationId: string): void {
    this.active.get(conversationId)?.abort(new Error('conversation deleted'));
  }

  get size(): number {
    return this.active.size;
  }
}
