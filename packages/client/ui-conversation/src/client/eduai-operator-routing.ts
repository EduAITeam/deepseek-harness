import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubmitOutcome } from './contract/input.ts'

const EDUAI_OPERATOR_ROUTE_KEY = Symbol.for('eduai.operator-route')

interface CapturedEduAiOperatorRoute {
  taskId: number
  sessionId: SessionId
  capability: string | undefined
}

interface EduAiRunSnapshot {
  runId?: unknown
  status?: unknown
  result?: { summary?: unknown } | null
  error?: unknown
}

export interface EduAiTranscriptEntry {
  readonly id?: string
  readonly runId?: string
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
  private initialization: Promise<void> | undefined

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

  initialize(): Promise<void> {
    this.initialization ??= this.hydrate()
    return this.initialization
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
      // Publish a terminal transcript only after releasing this request's
      // active state.  InputBar reads that state to decide whether its
      // authoritative session is writable; publishing the completed result
      // first exposed one render where the result was visible but the composer
      // still reported "Session unavailable".
      this.inFlight.delete(text)
      if (this.active === pending) {
        this.active = undefined
        EduAiOperatorRoute.processingSessions.delete(this.sessionId)
      }
      EduAiOperatorRoute.replacePending(this.sessionId, outcome.text ?? 'EduAI operator message could not be delivered.')
    })
    return pending
  }

  private async sendOnce(text: string, signal: AbortSignal): Promise<SubmitOutcome> {
    try {
      if (this.initialization !== undefined) await this.initialization
      if (!(await this.establishSession(signal))) return { kind: 'error', text: 'EduAI operator capability is unavailable. Reopen this task from EduAI.' }
      const response = await this.sendFetch('/api/eduai/operator-message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: this.taskId, message: text }),
        signal,
      })
      if (response.status === 409) return { kind: 'error', text: await EduAiOperatorRoute.conflictText(response) }
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

  private async hydrate(): Promise<void> {
    try {
      if (!(await this.establishSession(new AbortController().signal))) return
      const response = await this.sendFetch(`/api/eduai/operator-transcript?taskId=${this.taskId}`, {
        method: 'GET',
        signal: new AbortController().signal,
      })
      if (!response.ok) return
      const payload = await response.json() as { task_id?: unknown; harness_session_id?: unknown; entries?: unknown }
      if (payload.task_id !== `${this.taskId}` || payload.harness_session_id !== this.sessionId || !Array.isArray(payload.entries)) return
      const hydrated = payload.entries.flatMap(entry => EduAiOperatorRoute.toHydratedEntries(entry))
      if (hydrated.length === 0) return
      const existing = EduAiOperatorRoute.entries(this.sessionId)
      const known = new Set(existing.map(entry => entry.id).filter((id): id is string => id !== undefined))
      const merged = [...existing, ...hydrated.filter(entry => entry.id === undefined || !known.has(entry.id))]
      EduAiOperatorRoute.transcript.set(this.sessionId, merged)
      EduAiOperatorRoute.publish(this.sessionId)
    } catch {
      // Authentication and transport failures remain fail-closed for sending;
      // an unavailable history projection must not change that behavior.
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

  private static async conflictText(response: Response): Promise<string> {
    const payload: unknown = await response.json().catch(() => undefined)
    const code = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : undefined
    switch (code) {
      case 'task_not_resumable':
        return 'This task is not ready for operator correction. It must be moved to NeedsRework first.'
      case 'task_session_conflict':
        return 'This Harness session no longer matches the task. Reopen the task from EduAI.'
      case 'task_state_conflict':
        return 'The task state changed while the correction was being submitted. Reopen the task and try again.'
      default:
        return 'EduAI could not resume this task because its current state conflicts with the request.'
    }
  }

  private static append(sessionId: SessionId, entry: EduAiTranscriptEntry): void {
    EduAiOperatorRoute.transcript.set(sessionId, [...EduAiOperatorRoute.entries(sessionId), entry])
    EduAiOperatorRoute.publish(sessionId)
  }

  private static toHydratedEntries(value: unknown): readonly EduAiTranscriptEntry[] {
    if (typeof value !== 'object' || value === null) return []
    const entry = value as Record<string, unknown>
    if (typeof entry.turn_id !== 'string' || typeof entry.run_id !== 'string'
      || typeof entry.message !== 'string' || typeof entry.status !== 'string') return []
    const detail = typeof entry.summary === 'string'
      ? entry.summary
      : typeof entry.error === 'string' ? entry.error : entry.status === 'queued' || entry.status === 'running'
        ? 'Processing…' : 'No result was returned.'
    return [
      { id: entry.turn_id, runId: entry.run_id, role: 'operator', text: entry.message },
      { id: `${entry.turn_id}:result`, runId: entry.run_id, role: 'eduai', text: `EduAI\n${detail}\nStatus: ${entry.status}`, pending: entry.status === 'queued' || entry.status === 'running' },
    ]
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
