// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { EduAiOperatorRoute } from '../src/client/eduai-operator-routing.ts'
import { EduAiTranscript } from '../src/client/skeleton/EduAiTranscript.tsx'
import { captureEduAiOperatorRoute } from '../../ui-workspace/src/client/navigation.ts'

describe('EduAI transcript presentation', () => {
  it('renders independent right-side operator and left-side EduAI conversation entries', async () => {
    const sessionId = 'hss_eduai_transcript' as SessionId
    const fetch: typeof globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return path === '/api/eduai/operator-session'
        ? Response.json({ established: true }, { status: 201 })
        : Response.json({ run: { status: 'needs_human_review', result: { summary: 'Corrected output.' } } }, { status: 202 })
    }
    captureEduAiOperatorRoute(
      { pathname: '/', search: `?sessionId=${sessionId}&eduaiTaskId=42`, hash: '#eduaiCapability=capability' } as Location,
      { state: null, replaceState: vi.fn() } as unknown as History,
    )
    const route = EduAiOperatorRoute.fromLocation(fetch)!
    const view = render(<EduAiTranscript sessionId={sessionId} />)

    expect(view.container.querySelector('[data-eduai-transcript]')).toBeNull()
    await act(async () => { await route.send('Print pig.', new AbortController().signal) })

    const messages = view.container.querySelectorAll('[data-eduai-role]')
    expect(messages).toHaveLength(2)
    expect(messages[0]?.getAttribute('data-eduai-role')).toBe('operator')
    expect(messages[0]?.getAttribute('data-eduai-align')).toBe('right')
    expect(messages[0]?.textContent).toContain('Print pig.')
    expect(messages[1]?.getAttribute('data-eduai-role')).toBe('eduai')
    expect(messages[1]?.getAttribute('data-eduai-align')).toBe('left')
    expect(messages[1]?.textContent).toContain('Corrected output.')
    expect(view.container.querySelectorAll('[data-eduai-transcript]')).toHaveLength(1)
  })
})
