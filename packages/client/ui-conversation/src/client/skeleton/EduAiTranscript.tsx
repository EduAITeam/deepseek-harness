import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { EduAiOperatorRoute } from '../eduai-operator-routing.ts'
import css from './EduAiTranscript.module.css'

export function EduAiTranscript({ sessionId }: { readonly sessionId: SessionId }): ReactNode {
  const entries = useSyncExternalStore(
    listener => EduAiOperatorRoute.subscribe(sessionId, listener),
    () => EduAiOperatorRoute.entries(sessionId),
    () => EduAiOperatorRoute.entries(undefined),
  )
  if (!EduAiOperatorRoute.ownsSession(sessionId) || entries.length === 0) return null
  return (
    <div className={css.root} data-eduai-transcript>
      {entries.map((entry, index) => (
        <article
          key={`${entry.role}-${index}`}
          className={entry.role === 'operator' ? css.operator : css.eduai}
          data-eduai-role={entry.role}
          data-eduai-align={entry.role === 'operator' ? 'right' : 'left'}
          aria-live="polite"
        >
          <div className={css.bubble}>{entry.text}</div>
          <div className={css.label}>{entry.role === 'operator' ? 'Operator' : 'EduAI'}</div>
        </article>
      ))}
    </div>
  )
}
