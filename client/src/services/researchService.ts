export type SubQuestionType = 'what' | 'how' | 'why' | 'when' | 'who' | 'where' | 'other'

export type IntakeAudience = 'novice' | 'intermediate' | 'expert'

export type ResearchDepth = 'quick' | 'standard' | 'deep'

export type PlanRequest = {
  topic: string
  goal: string
  audience?: IntakeAudience
  depth?: ResearchDepth
}

export type PlannedSubQuestion = {
  id: string
  text: string
  planStepIndex: number
  type: SubQuestionType
  dependsOn: string[]
  priority: number
}

export type PlanResponse = {
  clarificationNeeded: boolean
  clarificationQuestion: string
  ambiguityScore: number
  audience: IntakeAudience
  depth: ResearchDepth
  planSteps?: string[]
  subQuestions: PlannedSubQuestion[]
  notes?: string
}

/** Phase 2 /execute SSE payloads (must stay aligned with server `ResearchSseEvent`). */
export type ResearchSseEvent =
  | { type: 'subquestion_start'; id: string }
  | { type: 'subquestion_done'; id: string; summary: string }
  | { type: 'synthesis_start' }
  | { type: 'complete'; brief: string }
  | { type: 'error'; message: string }

export type ExecuteResearchRequest = PlanRequest & {
  planSteps?: string[]
  subQuestions: PlannedSubQuestion[]
}

function splitBriefIntoChunks(brief: string): string[] {
  const parts = brief
    .split(/\n\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : [brief.trim() || '(empty brief)']
}

async function parseJsonOrThrow(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload && 'message' in payload ? String(payload.message) : 'Request failed.'
    throw new Error(message)
  }
  return payload
}

export async function planResearch(request: PlanRequest): Promise<PlanResponse> {
  const response = await fetch('/api/research/plan', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  })

  const payload = await parseJsonOrThrow(response)

  if (
    typeof payload !== 'object' ||
    !payload ||
    !('subQuestions' in payload) ||
    !Array.isArray(payload.subQuestions) ||
    !('clarificationNeeded' in payload) ||
    typeof (payload as PlanResponse).audience !== 'string' ||
    typeof (payload as PlanResponse).depth !== 'string'
  ) {
    throw new Error('Planner response shape was invalid.')
  }

  return payload as PlanResponse
}

function isResearchSseEvent(value: unknown): value is ResearchSseEvent {
  if (typeof value !== 'object' || value === null || typeof (value as ResearchSseEvent).type !== 'string') {
    return false
  }
  const t = (value as ResearchSseEvent).type
  switch (t) {
    case 'subquestion_start':
      return typeof (value as { id?: unknown }).id === 'string'
    case 'subquestion_done':
      return typeof (value as { id?: unknown }).id === 'string' && typeof (value as { summary?: unknown }).summary === 'string'
    case 'synthesis_start':
      return true
    case 'complete':
      return typeof (value as { brief?: unknown }).brief === 'string'
    case 'error':
      return typeof (value as { message?: unknown }).message === 'string'
    default:
      return false
  }
}

export async function executeResearch(
  request: ExecuteResearchRequest,
  onEvent: (event: ResearchSseEvent) => void,
): Promise<void> {
  const response = await fetch('/api/research/execute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const message =
      typeof payload === 'object' && payload && 'message' in payload ? String(payload.message) : 'Research execution failed.'
    throw new Error(message)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Streaming response was not readable.')
  }

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const rawBlock = buffer.slice(0, boundary).trimEnd()
        buffer = buffer.slice(boundary + 2)

        const line = rawBlock
          .split('\n')
          .map((l) => l.trimEnd())
          .find((l) => l.startsWith('data:'))

        if (line) {
          const jsonText = line.slice('data:'.length).trim()
          try {
            const parsed: unknown = JSON.parse(jsonText)
            if (isResearchSseEvent(parsed)) {
              onEvent(parsed)
            }
          } catch {
            /* ignore malformed SSE payloads */
          }
        }

        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock?.()
  }

  const trailing = buffer.trim()
  if (trailing.length > 0) {
    const line = trailing
      .split('\n')
      .map((l) => l.trimEnd())
      .find((l) => l.startsWith('data:'))
    if (line) {
      const jsonText = line.slice('data:'.length).trim()
      try {
        const parsed: unknown = JSON.parse(jsonText)
        if (isResearchSseEvent(parsed)) {
          onEvent(parsed)
        }
      } catch {
        /* ignore */
      }
    }
  }
}

export { splitBriefIntoChunks }
