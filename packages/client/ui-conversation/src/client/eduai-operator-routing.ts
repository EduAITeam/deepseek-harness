import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubmitOutcome } from './contract/input.ts'

const EDUAI_OPERATOR_ROUTE_KEY = Symbol.for('eduai.operator-route')

interface CapturedEduAiOperatorRoute {
  taskId: number
  sessionId: SessionId
  capability: string | undefined
}

interface EduAiRunSnapshot {
  status?: unknown
  result?: { summary?: unknown } | null
  error?: unknown
}

/** Browser-only, in-memory route for the EduAI deep-link capability. */
export class EduAiOperatorRoute {
  private readonly inFlight = new Map<string, Promise<SubmitOutcome>>()

  private constructor(
    private readonly taskId: number,
    private readonly sessionId: SessionId,
    private readonly capability: string | undefined,
    private readonly sendFetch: typeof fetch,
  ) {}

  static fromLocation(sendFetch: typeof fetch = globalThis.fetch.bind(globalThis)): EduAiOperatorRoute | undefined {
    const captured = Reflect.get(globalThis, EDUAI_OPERATOR_ROUTE_KEY) as CapturedEduAiOperatorRoute | undefined
    if (captured === undefined) return undefined
    Reflect.deleteProperty(globalThis, EDUAI_OPERATOR_ROUTE_KEY)
    return new EduAiOperatorRoute(captured.taskId, captured.sessionId, captured.capability, sendFetch)
  }

  appliesTo(sessionId: SessionId): boolean { return sessionId === this.sessionId }

  send(text: string, signal: AbortSignal): Promise<SubmitOutcome> {
    const capability = this.capability
    if (!capability) return Promise.resolve({ kind: 'error', text: 'EduAI operator capability is unavailable. Reopen this task from EduAI.' })
    const existing = this.inFlight.get(text)
    if (existing !== undefined) return existing
    const pending = this.sendOnce(text, signal, capability)
    this.inFlight.set(text, pending)
    void pending.finally(() => { this.inFlight.delete(text) })
    return pending
  }

  private async sendOnce(text: string, signal: AbortSignal, capability: string): Promise<SubmitOutcome> {
    try {
      const response = await this.sendFetch('/api/eduai/operator-message', {
        method: 'POST',
        headers: { 'X-EduAI-Operator-Capability': capability, 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: this.taskId, message: text }),
        signal,
      })
      if (!response.ok) return { kind: 'error', text: 'EduAI operator message was not accepted.' }
      const payload = await response.json() as { run?: EduAiRunSnapshot }
      if (payload.run === undefined || typeof payload.run.status !== 'string') {
        return { kind: 'error', text: 'EduAI operator run status was unavailable.' }
      }
      const summary = typeof payload.run.result?.summary === 'string' ? payload.run.result.summary : undefined
      const detail = summary ?? (typeof payload.run.error === 'string' ? payload.run.error : 'No result was returned.')
      return { kind: 'success', text: `EduAI\n${detail}\nStatus: ${payload.run.status}` }
    } catch {
      return { kind: 'error', text: 'EduAI operator message could not be delivered.' }
    }
  }
}
