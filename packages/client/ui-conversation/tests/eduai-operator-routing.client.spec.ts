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

describe('EduAI operator browser route', () => {
  it('captures an EduAI deep link before URL cleanup and routes the later InputHub through EduAI', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }))
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

    expect(result).toEqual({ kind: 'success' })
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/?sessionId=hss_owned&eduaiTaskId=42')
    expect(fetch).toHaveBeenCalledOnce()
    const [path, options] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/eduai/operator-message')
    const headers = new Headers(options.headers)
    expect(headers.get('X-EduAI-Operator-Capability')).toBe('capability')
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

  it('calls the browser fetch with the browser global as its receiver', async () => {
    const originalFetch = globalThis.fetch
    const received = vi.fn()
    globalThis.fetch = function (this: unknown): Promise<Response> {
      received(this)
      if (this !== globalThis) throw new TypeError('invalid fetch receiver')
      return Promise.resolve(new Response(null, { status: 202 }))
    }
    try {
      captureEduAiOperatorRoute(
        { pathname: '/', search: '?sessionId=hss_owned&eduaiTaskId=42', hash: '#eduaiCapability=capability' } as Location,
        { state: null, replaceState: vi.fn() } as unknown as History,
      )
      const outcome = await EduAiOperatorRoute.fromLocation()!.send('Apply the corrected rubric.', new AbortController().signal)

      expect(outcome).toEqual({ kind: 'success' })
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
