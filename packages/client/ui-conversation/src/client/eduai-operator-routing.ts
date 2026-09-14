import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubmitOutcome } from './contract/input.ts'

const CAPABILITY_FRAGMENT_KEY = 'eduaiCapability'

/** Browser-only, in-memory route for the EduAI deep-link capability. */
export class EduAiOperatorRoute {
  private constructor(
    private readonly taskId: number,
    private readonly sessionId: SessionId,
    private readonly capability: string | undefined,
    private readonly sendFetch: typeof fetch,
  ) {}

  static fromLocation(location: Location | undefined = globalThis.location, history: History | undefined = globalThis.history,
    sendFetch: typeof fetch = globalThis.fetch): EduAiOperatorRoute | undefined {
    if (location === undefined || history === undefined) return undefined
    const query = new URLSearchParams(location.search)
    const taskId = query.get('eduaiTaskId')
    const sessionId = query.get('sessionId')
    if (!taskId || !sessionId || !/^\d+$/u.test(taskId) || !Number.isSafeInteger(Number(taskId)) || Number(taskId) <= 0) return undefined
    const fragment = new URLSearchParams(location.hash.replace(/^#/u, ''))
    const capability = fragment.get(CAPABILITY_FRAGMENT_KEY) || undefined
    // Remove it even when malformed/missing: a marked EduAI session must never fall back to native prompt.
    history.replaceState(history.state, '', `${location.pathname}${location.search}`)
    return new EduAiOperatorRoute(Number(taskId), sessionId as SessionId, capability, sendFetch)
  }

  appliesTo(sessionId: SessionId): boolean { return sessionId === this.sessionId }

  async send(text: string, signal: AbortSignal): Promise<SubmitOutcome> {
    if (!this.capability) return { kind: 'error', text: 'EduAI operator capability is unavailable. Reopen this task from EduAI.' }
    try {
      const response = await this.sendFetch('/api/eduai/operator-message', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.capability}`, 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: this.taskId, message: text }),
        signal,
      })
      return response.ok
        ? { kind: 'success' }
        : { kind: 'error', text: 'EduAI operator message was not accepted.' }
    } catch {
      return { kind: 'error', text: 'EduAI operator message could not be delivered.' }
    }
  }
}
