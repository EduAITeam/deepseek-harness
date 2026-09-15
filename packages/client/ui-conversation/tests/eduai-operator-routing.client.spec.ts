import { describe, expect, it, vi } from 'vitest'
import { EduAiOperatorRoute } from '../src/client/eduai-operator-routing.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { captureEduAiOperatorRoute } from '../../ui-workspace/src/client/navigation.ts'

type TestableInputHub = {
  sink(
    session: { sessionId: string },
    text: string,
    attachments: unknown[],
    mode: 'queue' | 'steer',
    signal: AbortSignal,
  ): Promise<{ kind: string }>
}

type EduAiSessionId = Exclude<Parameters<typeof EduAiOperatorRoute.entries>[0], undefined>

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

describe('EduAI operator browser route', () => {
  it('coalesces duplicate textbox dispatches into one operator-message POST', async () => {
    let resolveResponse!: (response: Response) => void
    const fetch = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => requestPath(input) === '/api/eduai/operator-session'
      ? Promise.resolve(Response.json({ established: true }, { status: 201 }))
      : new Promise<Response>((resolve) => { resolveResponse = resolve }))
    captureEduAiOperatorRoute(
      { pathname: '/', search: '?sessionId=hss_owned&eduaiTaskId=42', hash: '#eduaiCapability=capability' } as Location,
      { state: null, replaceState: vi.fn() } as unknown as History,
    )
    const route = EduAiOperatorRoute.fromLocation(fetch)!

    const first = route.send('Submit once.', new AbortController().signal)
    const duplicate = route.send('Submit once.', new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenCalledWith('/api/eduai/operator-session', expect.anything())
    expect(fetch).toHaveBeenCalledWith('/api/eduai/operator-message', expect.anything())

    resolveResponse(Response.json({
      run: { status: 'needs_human_review', result: { summary: 'Ready for review.' }, error: null },
    }, { status: 202 }))

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { kind: 'success', text: 'EduAI\nReady for review.\nStatus: needs_human_review' },
      { kind: 'success', text: 'EduAI\nReady for review.\nStatus: needs_human_review' },
    ])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry an initial operator-message failure', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => requestPath(input) === '/api/eduai/operator-session'
      ? Response.json({ established: true }, { status: 201 }) : Response.json({ error: 'conflict' }, { status: 409 }))
    captureEduAiOperatorRoute(
      { pathname: '/', search: '?sessionId=hss_owned&eduaiTaskId=42', hash: '#eduaiCapability=capability' } as Location,
      { state: null, replaceState: vi.fn() } as unknown as History,
    )

    const outcome = await EduAiOperatorRoute.fromLocation(fetch)!.send('Submit once.', new AbortController().signal)

    expect(outcome).toEqual({ kind: 'error', text: 'EduAI is still processing the previous request.' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('blocks a distinct operator message while the accepted run is active', async () => {
    let resolveMessage!: (response: Response) => void
    const fetch = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => requestPath(input) === '/api/eduai/operator-session'
      ? Promise.resolve(Response.json({ established: true }, { status: 201 }))
      : new Promise<Response>((resolve) => { resolveMessage = resolve }))
    captureEduAiOperatorRoute(
      { pathname: '/', search: '?sessionId=hss_owned&eduaiTaskId=42', hash: '#eduaiCapability=capability' } as Location,
      { state: null, replaceState: vi.fn() } as unknown as History,
    )
    const route = EduAiOperatorRoute.fromLocation(fetch)!
    const first = route.send('First request.', new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 0))

    await expect(route.send('Second request.', new AbortController().signal))
      .resolves.toEqual({ kind: 'error', text: 'EduAI is still processing the previous request.' })
    expect(fetch).toHaveBeenCalledTimes(2)

    resolveMessage(Response.json({ run: { status: 'needs_human_review', result: { summary: 'Ready.' } } }, { status: 202 }))
    await expect(first).resolves.toMatchObject({ kind: 'success' })
  })

  it('shows a local operator transcript and processing state before the terminal result', async () => {
    let resolveMessage!: (response: Response) => void
    const fetch = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => requestPath(input) === '/api/eduai/operator-session'
      ? Promise.resolve(Response.json({ established: true }, { status: 201 }))
      : new Promise<Response>((resolve) => { resolveMessage = resolve }))
    captureEduAiOperatorRoute(
      { pathname: '/', search: '?sessionId=hss_owned&eduaiTaskId=42', hash: '#eduaiCapability=capability' } as Location,
      { state: null, replaceState: vi.fn() } as unknown as History,
    )
    const route = EduAiOperatorRoute.fromLocation(fetch)!
    const emptyTranscript = EduAiOperatorRoute.entries('hss_owned' as EduAiSessionId)
    expect(emptyTranscript).toBe(EduAiOperatorRoute.entries('hss_owned' as EduAiSessionId))
    expect(emptyTranscript).toBe(EduAiOperatorRoute.entries(undefined))

    const pending = route.send('Create the console app.', new AbortController().signal)
    expect(EduAiOperatorRoute.entries('hss_owned' as EduAiSessionId)).not.toBe(emptyTranscript)
    expect(EduAiOperatorRoute.entries('hss_owned' as EduAiSessionId)).toEqual([
      { role: 'operator', text: 'Create the console app.' },
      { role: 'eduai', text: 'Processing…', pending: true },
    ])

    await new Promise(resolve => setTimeout(resolve, 0))
    resolveMessage(Response.json({ run: { status: 'completed', result: { summary: 'Done.' } } }, { status: 202 }))
    await expect(pending).resolves.toEqual({ kind: 'success', text: 'EduAI\nDone.\nStatus: completed' })
    expect(EduAiOperatorRoute.entries('hss_owned' as EduAiSessionId)).toEqual([
      { role: 'operator', text: 'Create the console app.' },
      { role: 'eduai', text: 'EduAI\nDone.\nStatus: completed' },
    ])
  })

  it('routes the actual InputHub submit when navigation captures the deep link after hub construction', async () => {
    const originalFetch = globalThis.fetch
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => requestPath(input) === '/api/eduai/operator-session'
      ? Response.json({ established: true }, { status: 201 }) : Response.json({ run: {
        runId: 'hrn_5', taskId: '42', sessionId: 'hss_owned',
        status: 'needs_human_review', result: { summary: 'Late capture was delivered.' }, error: null,
      } }, { status: 202 }))
    globalThis.fetch = fetch
    try {
      const nativeSend = vi.fn()
      const hub = new InputHub({ get: () => ({ sendSession: nativeSend }) } as never, (() => '') as never)

      captureEduAiOperatorRoute(
        { pathname: '/', search: '?sessionId=hss_owned&eduaiTaskId=42', hash: '#eduaiCapability=capability' } as Location,
        { state: null, replaceState: vi.fn() } as unknown as History,
      )
      const result = await (hub as unknown as TestableInputHub).sink(
        { sessionId: 'hss_owned' }, 'Submit through the textbox.', [], 'queue', new AbortController().signal,
      )

      expect(result).toEqual({ kind: 'success', text: 'EduAI\nLate capture was delivered.\nStatus: needs_human_review' })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(nativeSend).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('captures an EduAI deep link before URL cleanup and routes the later InputHub through EduAI', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => requestPath(input) === '/api/eduai/operator-session'
      ? Response.json({ established: true }, { status: 201 })
      : Response.json({ run: { status: 'needs_human_review', result: { summary: 'Corrected rubric is ready.' }, error: null } }, { status: 202 }))
    const replaceState = vi.fn()
    captureEduAiOperatorRoute(
      { pathname: '/', search: '?sessionId=hss_owned&eduaiTaskId=42', hash: '#eduaiCapability=capability' } as Location,
      { state: null, replaceState } as unknown as History,
    )
    const route = EduAiOperatorRoute.fromLocation(fetch)!
    const nativeSend = vi.fn()
    const hub = new InputHub({ get: () => ({ sendSession: nativeSend }) } as never, (() => '') as never, route)
    const result = await (hub as unknown as TestableInputHub).sink(
      { sessionId: 'hss_owned' },
      'Apply the corrected rubric.',
      [],
      'queue',
      new AbortController().signal,
    )

    expect(result).toEqual({ kind: 'success', text: 'EduAI\nCorrected rubric is ready.\nStatus: needs_human_review' })
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/?sessionId=hss_owned&eduaiTaskId=42')
    expect(fetch).toHaveBeenCalledTimes(2)
    const [bootstrapPath, bootstrapOptions] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(bootstrapPath).toBe('/api/eduai/operator-session')
    expect(new Headers(bootstrapOptions.headers).get('X-EduAI-Operator-Capability')).toBe('capability')
    const [path, options] = fetch.mock.calls[1] as unknown as [string, RequestInit]
    expect(path).toBe('/api/eduai/operator-message')
    const headers = new Headers(options.headers)
    expect(headers.has('X-EduAI-Operator-Capability')).toBe(false)
    expect(headers.has('authorization')).toBe(false)
    expect(JSON.parse(options.body as string)).toEqual({ taskId: 42, message: 'Apply the corrected rubric.' })
    expect(nativeSend).not.toHaveBeenCalled()
  })

  it('does not fall back to native prompting when a marked EduAI URL lacks a capability', async () => {
    captureEduAiOperatorRoute(
      { pathname: '/', search: '?sessionId=hss_owned&eduaiTaskId=42', hash: '' } as Location,
      { state: null, replaceState: vi.fn() } as unknown as History,
    )
    const route = EduAiOperatorRoute.fromLocation(vi.fn())!
    const nativeSend = vi.fn()
    const hub = new InputHub({ get: () => ({ sendSession: nativeSend }) } as never, (() => '') as never, route)
    const result = await (hub as unknown as TestableInputHub).sink(
      { sessionId: 'hss_owned' },
      'Fix it.',
      [],
      'queue',
      new AbortController().signal,
    )
    expect(result.kind).toBe('error')
    expect(nativeSend).not.toHaveBeenCalled()
  })

  it('fails closed without native prompting when the EduAI request rejects', async () => {
    captureEduAiOperatorRoute(
      { pathname: '/', search: '?sessionId=hss_owned&eduaiTaskId=42', hash: '#eduaiCapability=capability' } as Location,
      { state: null, replaceState: vi.fn() } as unknown as History,
    )
    const fetch = vi.fn(async () => { throw new TypeError('network failure') })
    const route = EduAiOperatorRoute.fromLocation(fetch)!
    const nativeSend = vi.fn()
    const hub = new InputHub({ get: () => ({ sendSession: nativeSend }) } as never, (() => '') as never, route)

    const result = await (hub as unknown as TestableInputHub).sink(
      { sessionId: 'hss_owned' }, 'Fix it.', [], 'queue', new AbortController().signal,
    )

    expect(result.kind).toBe('error')
    expect(fetch).toHaveBeenCalledOnce()
    expect(nativeSend).not.toHaveBeenCalled()
  })

  it('treats a terminal workflow failure as an EduAI failure without native prompting', async () => {
    captureEduAiOperatorRoute(
      { pathname: '/', search: '?sessionId=hss_owned&eduaiTaskId=42', hash: '#eduaiCapability=capability' } as Location,
      { state: null, replaceState: vi.fn() } as unknown as History,
    )
    const route = EduAiOperatorRoute.fromLocation(vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => requestPath(input) === '/api/eduai/operator-session'
      ? Response.json({ established: true }, { status: 201 })
      : Response.json({ run: { status: 'failed', result: null, error: 'executor_failed' } }, { status: 422 })))!
    const nativeSend = vi.fn()
    const hub = new InputHub({ get: () => ({ sendSession: nativeSend }) } as never, (() => '') as never, route)

    const result = await (hub as unknown as TestableInputHub).sink(
      { sessionId: 'hss_owned' }, 'Fix it.', [], 'queue', new AbortController().signal,
    )

    expect(result).toEqual({ kind: 'error', text: 'EduAI operator message was not accepted.' })
    expect(nativeSend).not.toHaveBeenCalled()
  })

  it('calls the browser fetch with the browser global as its receiver', async () => {
    const originalFetch = globalThis.fetch
    const received = vi.fn()
    globalThis.fetch = function (this: unknown, input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
      received(this)
      if (this !== globalThis) throw new TypeError('invalid fetch receiver')
      return Promise.resolve(requestPath(input) === '/api/eduai/operator-session' ? Response.json({ established: true }, { status: 201 }) : Response.json({
        run: { status: 'completed', result: { summary: 'Done.' }, error: null },
      }, { status: 202 }))
    }
    try {
      captureEduAiOperatorRoute(
        { pathname: '/', search: '?sessionId=hss_owned&eduaiTaskId=42', hash: '#eduaiCapability=capability' } as Location,
        { state: null, replaceState: vi.fn() } as unknown as History,
      )
      const outcome = await EduAiOperatorRoute.fromLocation()!.send('Apply the corrected rubric.', new AbortController().signal)

      expect(outcome).toEqual({ kind: 'success', text: 'EduAI\nDone.\nStatus: completed' })
      expect(received).toHaveBeenCalledWith(globalThis)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps normal Harness sessions on the native prompt path', async () => {
    const nativeSend = vi.fn(async () => ({ kind: 'success' as const }))
    const hub = new InputHub({ get: () => ({ sendSession: nativeSend }) } as never, (() => '') as never)

    const result = await (hub as unknown as TestableInputHub).sink(
      { sessionId: 'hss_normal' },
      'Continue normally.',
      [],
      'queue',
      new AbortController().signal,
    )

    expect(result).toEqual({ kind: 'success' })
    expect(nativeSend).toHaveBeenCalledOnce()
  })
})
