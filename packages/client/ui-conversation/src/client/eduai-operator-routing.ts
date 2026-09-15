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

export interface EduAiTranscriptEntry {
  readonly role: 'operator' | 'eduai'
  readonly text: string
  readonly pending?: boolean
}

const EMPTY_TRANSCRIPT: readonly EduAiTranscriptEntry[] = Object.freeze([])

/** Browser-only, in-memory route for the EduAI deep-link capability. */
export class EduAiOperatorRoute {
  private static ownedSessionId: SessionId | undefined
  private static readonly transcript = new Map<SessionId, readonly EduAiTranscriptEntry[]>()
  private static readonly listeners = new Map<SessionId, Set<() => void>>()
  private static readonly processingSessions = new Set<SessionId>()
  private readonly inFlight = new Map<string, Promise<SubmitOutcome>>()
  private active: Promise<SubmitOutcome> | undefined

  private constructor(
    private readonly taskId: number,
    private readonly sessionId: SessionId,
    private bootstrapCapability: string | undefined,
    private readonly sendFetch: typeof fetch,
  ) {}

  static fromLocation(sendFetch: typeof fetch = globalThis.fetch.bind(globalThis)): EduAiOperatorRoute | undefined {
    const captured = Reflect.get(globalThis, EDUAI_OPERATOR_ROUTE_KEY) as CapturedEduAiOperatorRoute | undefined
    if (captured === undefined) return undefined
    Reflect.deleteProperty(globalThis, EDUAI_OPERATOR_ROUTE_KEY)
    EduAiOperatorRoute.ownedSessionId = captured.sessionId
    EduAiOperatorRoute.transcript.delete(captured.sessionId)
    return new EduAiOperatorRoute(captured.taskId, captured.sessionId, captured.capability, sendFetch)
  }

  appliesTo(sessionId: SessionId): boolean { return sessionId === this.sessionId }
  static ownsSession(sessionId: SessionId | undefined): boolean {
    if (sessionId === undefined) return false
    const captured = Reflect.get(globalThis, EDUAI_OPERATOR_ROUTE_KEY) as CapturedEduAiOperatorRoute | undefined
    return sessionId === EduAiOperatorRoute.ownedSessionId || sessionId === captured?.sessionId
  }
  static isProcessing(sessionId: SessionId | undefined): boolean {
    return sessionId !== undefined && EduAiOperatorRoute.processingSessions.has(sessionId)
  }
  static entries(sessionId: SessionId | undefined): readonly EduAiTranscriptEntry[] {
    return sessionId === undefined
      ? EMPTY_TRANSCRIPT
      : EduAiOperatorRoute.transcript.get(sessionId) ?? EMPTY_TRANSCRIPT
  }
  static subscribe(sessionId: SessionId | undefined, listener: () => void): () => void {
    if (sessionId === undefined) return () => {}
    const listeners = EduAiOperatorRoute.listeners.get(sessionId) ?? new Set<() => void>()
    listeners.add(listener)
    EduAiOperatorRoute.listeners.set(sessionId, listeners)
    return () => { listeners.delete(listener) }
  }
  isProcessing(): boolean { return this.active !== undefined }

  send(text: string, signal: AbortSignal): Promise<SubmitOutcome> {
    const existing = this.inFlight.get(text)
    if (existing !== undefined) return existing
    if (this.active !== undefined) {
      return Promise.resolve({ kind: 'error', text: 'EduAI is still processing the previous request.' })
    }
    EduAiOperatorRoute.append(this.sessionId, { role: 'operator', text })
    EduAiOperatorRoute.append(this.sessionId, { role: 'eduai', text: 'Processing…', pending: true })
    const pending = this.sendOnce(text, signal)
    this.active = pending
    EduAiOperatorRoute.processingSessions.add(this.sessionId)
    EduAiOperatorRoute.publish(this.sessionId)
    this.inFlight.set(text, pending)
    void pending.then((outcome) => {
      EduAiOperatorRoute.replacePending(this.sessionId, outcome.text ?? 'EduAI operator message could not be delivered.')
    }).finally(() => {
      this.inFlight.delete(text)
      if (this.active === pending) {
        this.active = undefined
        EduAiOperatorRoute.processingSessions.delete(this.sessionId)
        EduAiOperatorRoute.publish(this.sessionId)
      }
    })
    return pending
  }

  private async sendOnce(text: string, signal: AbortSignal): Promise<SubmitOutcome> {
    try {
      if (!(await this.establishSession(signal))) return { kind: 'error', text: 'EduAI operator capability is unavailable. Reopen this task from EduAI.' }
      const response = await this.sendFetch('/api/eduai/operator-message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: this.taskId, message: text }),
        signal,
      })
      if (response.status === 409) return { kind: 'error', text: 'EduAI is still processing the previous request.' }
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

  private async establishSession(signal: AbortSignal): Promise<boolean> {
    const bootstrap = this.bootstrapCapability
    if (bootstrap === undefined) return true
    const response = await this.sendFetch('/api/eduai/operator-session', {
      method: 'POST', headers: { 'X-EduAI-Operator-Capability': bootstrap, 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: this.taskId }), signal,
    })
    if (!response.ok) return false
    this.bootstrapCapability = undefined
    return true
  }

  private static append(sessionId: SessionId, entry: EduAiTranscriptEntry): void {
    EduAiOperatorRoute.transcript.set(sessionId, [...EduAiOperatorRoute.entries(sessionId), entry])
    EduAiOperatorRoute.publish(sessionId)
  }

  private static replacePending(sessionId: SessionId, text: string): void {
    const entries = EduAiOperatorRoute.entries(sessionId)
    const index = entries.findLastIndex(entry => entry.role === 'eduai' && entry.pending === true)
    if (index < 0) return
    EduAiOperatorRoute.transcript.set(sessionId, entries.map((entry, entryIndex) => entryIndex === index ? { role: 'eduai', text } : entry))
    EduAiOperatorRoute.publish(sessionId)
  }

  private static publish(sessionId: SessionId): void {
    for (const listener of EduAiOperatorRoute.listeners.get(sessionId) ?? []) listener()
  }
}
