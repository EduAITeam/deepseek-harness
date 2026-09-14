import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubmitOutcome } from './contract/input.ts'

const EDUAI_OPERATOR_ROUTE_KEY = Symbol.for('eduai.operator-route')

interface CapturedEduAiOperatorRoute {
  taskId: number
  sessionId: SessionId
  capability: string | undefined
}

/** Browser-only, in-memory route for the EduAI deep-link capability. */
export class EduAiOperatorRoute {
  private constructor(
    private readonly taskId: number,
    private readonly sessionId: SessionId,
    private readonly capability: string | undefined,
    private readonly sendFetch: typeof fetch,
  ) {}

  static fromLocation(sendFetch: typeof fetch = globalThis.fetch): EduAiOperatorRoute | undefined {
    const captured = Reflect.get(globalThis, EDUAI_OPERATOR_ROUTE_KEY) as CapturedEduAiOperatorRoute | undefined
    if (captured === undefined) return undefined
    Reflect.deleteProperty(globalThis, EDUAI_OPERATOR_ROUTE_KEY)
    return new EduAiOperatorRoute(captured.taskId, captured.sessionId, captured.capability, sendFetch)
  }

  appliesTo(sessionId: SessionId): boolean { return sessionId === this.sessionId }

  async send(text: string, signal: AbortSignal): Promise<SubmitOutcome> {
    if (!this.capability) return { kind: 'error', text: 'EduAI operator capability is unavailable. Reopen this task from EduAI.' }
    try {
      const response = await this.sendFetch('/api/eduai/operator-message', {
        method: 'POST',
        headers: { 'X-EduAI-Operator-Capability': this.capability, 'content-type': 'application/json' },
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
