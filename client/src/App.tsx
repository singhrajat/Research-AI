import { useMemo, useState } from 'react'
import './App.css'
import {
  executeResearch,
  planResearch,
  splitBriefIntoChunks,
  type IntakeAudience,
  type PlanRequest,
  type PlanResponse,
  type PlannedSubQuestion,
  type ResearchDepth,
} from './services'
import { buildResearchBriefDocxBlob, downloadBlob } from './utils/exportBriefDocx'

const MIN_TOPIC_CHARS = 3
const MIN_GOAL_CHARS = 10
const MAX_GOAL_CHARS = 500

type SubQuestionStatus = 'done' | 'active' | 'pending'

type SubQuestion = PlannedSubQuestion & { status: SubQuestionStatus }

type AgentState = 'idle' | 'planning' | 'planned' | 'researching' | 'done' | 'error'

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function statusToLabel(status: SubQuestionStatus): string {
  switch (status) {
    case 'done':
      return 'Done'
    case 'active':
      return 'In progress'
    case 'pending':
      return 'Pending'
  }
}

/** Single source for top badge, brief meta line, and status bar. */
function agentPhaseLabel(state: AgentState): string {
  switch (state) {
    case 'idle':
      return 'Ready'
    case 'planning':
      return 'Planning…'
    case 'planned':
      return 'Plan ready'
    case 'researching':
      return 'Researching…'
    case 'done':
      return 'Research complete'
    case 'error':
      return 'Error'
    default:
      return 'Ready'
  }
}

function agentNavBadgeClass(state: AgentState): string {
  const base = 'ra-nav-badge'
  switch (state) {
    case 'planning':
    case 'researching':
      return `${base} ra-nav-badge--running`
    case 'planned':
    case 'done':
      return `${base} ra-nav-badge--success`
    case 'error':
      return `${base} ra-nav-badge--error`
    default:
      return `${base} ra-nav-badge--idle`
  }
}

function agentStatDotClass(state: AgentState): string {
  switch (state) {
    case 'planning':
    case 'researching':
      return 'ra-stat-dot ra-stat-dot--running'
    case 'planned':
    case 'done':
      return 'ra-stat-dot ra-stat-dot--success'
    case 'error':
      return 'ra-stat-dot ra-stat-dot--error'
    default:
      return 'ra-stat-dot ra-stat-dot--idle'
  }
}

function plannerLogIconClass(state: AgentState): string {
  if (state === 'error') return 'ra-log-icon ra-log-error'
  if (state === 'done' || state === 'planned') return 'ra-log-icon ra-log-done'
  if (state === 'planning' || state === 'researching') return 'ra-log-icon ra-log-active'
  return 'ra-log-icon ra-log-muted'
}

export default function App() {
  const [topic, setTopic] = useState('')
  const [goal, setGoal] = useState('')

  const [agentState, setAgentState] = useState<AgentState>('idle')
  const [agentMessage, setAgentMessage] = useState<string | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [topicBlurHint, setTopicBlurHint] = useState<string | null>(null)
  const [goalBlurHint, setGoalBlurHint] = useState<string | null>(null)
  const [subQuestions, setSubQuestions] = useState<SubQuestion[]>([])
  const [planOutline, setPlanOutline] = useState<string[]>([])
  const [planAudience, setPlanAudience] = useState<IntakeAudience | undefined>(undefined)
  const [planDepth, setPlanDepth] = useState<ResearchDepth | undefined>(undefined)
  const [briefChunks, setBriefChunks] = useState<string[]>([])
  const [activeSection, setActiveSection] = useState<'research' | 'topics'>('research')

  const doneCount = subQuestions.filter((s) => s.status === 'done').length
  const remainingCount = subQuestions.length - doneCount

  const briefTitle = `${topic.trim() || 'Research'} — explained simply`
  const briefMeta = `${doneCount} of ${subQuestions.length} sub-questions complete · ${agentPhaseLabel(agentState)}`

  const exportDocx = async () => {
    try {
      const blob = await buildResearchBriefDocxBlob({
        briefTitle,
        briefMeta,
        topic: topicTrim,
        goal: goalTrim,
        planOutline,
        subQuestions: subQuestions.map((sq) => ({
          text: sq.text,
          planStepIndex: sq.planStepIndex,
          type: sq.type,
          statusLabel: statusToLabel(sq.status),
        })),
        agentMessage,
        briefChunks,
      })
      downloadBlob('research-brief.docx', blob)
    } catch (error) {
      console.error('DOCX export failed:', error)
    }
  }

  const markdownExport = useMemo(() => {
    const planLines =
      planOutline.length > 0
        ? planOutline.map((step, i) => `${i + 1}. ${step}`).join('\n')
        : '(none)'

    const sqLines = subQuestions
      .map((sq, idx) => `- ${idx + 1}. [Step ${sq.planStepIndex} · ${sq.type}] ${sq.text} (${statusToLabel(sq.status)})`)
      .join('\n')

    const body = briefChunks.join('\n\n').trim()

    return `# ${briefTitle}

## Topic
${topic.trim() || '(none)'}

## Goal
${goal.trim() || '(none)'}

## Plan outline
${planLines}

## Sub-questions
${sqLines || '(none)'}

## Planner status
${agentMessage ?? '(none)'}

## Research brief
${body || '(brief not generated yet)'}
`
  }, [agentMessage, briefChunks, briefTitle, goal, planOutline, subQuestions, topic])

  const applyPlan = (plan: PlanResponse) => {
    const plannedQuestions = [...plan.subQuestions]
      .sort((left, right) => left.priority - right.priority)
      .map((item) => ({ ...item, status: 'pending' as const }))

    setSubQuestions(plannedQuestions)
    setPlanOutline(plan.planSteps ?? [])
    setPlanAudience(plan.audience)
    setPlanDepth(plan.depth)
    setAgentMessage(plan.notes ?? `Generated ${plannedQuestions.length} sub-questions. Review before Phase 2.`)
    const outlineChunk =
      plan.planSteps && plan.planSteps.length > 0
        ? `Plan steps:\n${plan.planSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
        : null
    const chunks: string[] = [
      `Ambiguity score: ${plan.ambiguityScore.toFixed(2)}`,
      `Audience: ${plan.audience}`,
      `Research depth: ${plan.depth}`,
      ...(outlineChunk ? [outlineChunk] : []),
      plan.notes ?? 'Plan generated successfully. Approve to continue to Phase 2 execution.',
    ]
    setBriefChunks(chunks)
    setAgentState('planned')
  }

  const topicTrim = topic.trim()
  const goalTrim = goal.trim()
  const topicLongEnough = topicTrim.length >= MIN_TOPIC_CHARS
  const goalLongEnough = goalTrim.length >= MIN_GOAL_CHARS
  const goalWithinLimit = goal.length <= MAX_GOAL_CHARS
  const formReadyForSubmit = topicLongEnough && goalLongEnough && goalWithinLimit

  const startResearch = async () => {
    if (agentState === 'planning' || agentState === 'researching') return

    if (!formReadyForSubmit) {
      if (!topicLongEnough) {
        setRequestError(`Topic must be at least ${MIN_TOPIC_CHARS} characters.`)
      } else if (!goalLongEnough) {
        setRequestError(`Goal must be at least ${MIN_GOAL_CHARS} characters.`)
      } else if (!goalWithinLimit) {
        setRequestError(`Goal must be at most ${MAX_GOAL_CHARS} characters.`)
      }
      return
    }

    setRequestError(null)
    setAgentState('planning')

    try {
      const payload: PlanRequest = {
        topic: topicTrim,
        goal: goalTrim,
      }

      const plan = await planResearch(payload)
      applyPlan(plan)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Planner request failed.'
      setRequestError(message)
      setBriefChunks(['Planner request failed. Resolve the issue and retry.'])
      setAgentState('error')
    }
  }

  const approvePlan = () => {
    void runApprovePlan()
  }

  const runApprovePlan = async () => {
    if (agentState !== 'planned' || subQuestions.length === 0) {
      return
    }

    setRequestError(null)
    setAgentState('researching')
    setAgentMessage('Searching the web for each sub-question…')

    try {
      await executeResearch(
        {
          topic: topicTrim,
          goal: goalTrim,
          audience: planAudience,
          depth: planDepth,
          planSteps: planOutline.length > 0 ? planOutline : undefined,
          subQuestions: subQuestions.map(({ id, text, planStepIndex, type, dependsOn, priority }) => ({
            id,
            text,
            planStepIndex,
            type,
            dependsOn,
            priority,
          })),
        },
        (event) => {
          switch (event.type) {
            case 'subquestion_start':
              setSubQuestions((prev) =>
                prev.map((sq) => {
                  if (sq.id === event.id) {
                    return { ...sq, status: 'active' }
                  }
                  if (sq.status === 'done') {
                    return sq
                  }
                  return { ...sq, status: 'pending' }
                }),
              )
              break
            case 'subquestion_done':
              setSubQuestions((prev) =>
                prev.map((sq) => (sq.id === event.id ? { ...sq, status: 'done' } : sq)),
              )
              break
            case 'synthesis_start':
              setAgentMessage('Synthesizing findings…')
              break
            case 'complete':
              setBriefChunks(splitBriefIntoChunks(event.brief))
              setAgentMessage('Research complete. Your brief is ready — export above if you like.')
              setAgentState('done')
              break
            case 'error':
              setRequestError(event.message)
              setAgentState('error')
              break
            default:
              break
          }
        },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Research execution failed.'
      setRequestError(message)
      setAgentState('error')
    }
  }

  const phaseLabel = agentPhaseLabel(agentState)

  return (
    <div className="ra-page">
      <div className="ra-app-layout">
        <aside className="ra-sidebar">
          <div className="ra-sidebar-brand">
            <div className="ra-logo-dot" aria-hidden />
            <span className="ra-sidebar-title">ResearchAI</span>
          </div>
          <nav className="ra-side-nav" aria-label="Primary">
            <button
              type="button"
              className={['ra-side-tab', activeSection === 'research' ? 'ra-side-tab-active' : ''].join(' ')}
              onClick={() => setActiveSection('research')}
              aria-current={activeSection === 'research' ? 'page' : undefined}
            >
              Research
            </button>
             </nav>
        </aside>
        <div className="ra-main">
          <div className="ra-main-scroll">
            {activeSection === 'research' ? (
              <div className="ra-single-layout">
                <div className="ra-shell ra-shell-single">
                  <header className="ra-topbar">
                    <span className="ra-topbar-section-title">Research</span>
                    <span className={agentNavBadgeClass(agentState)}>{phaseLabel}</span>
                  </header>

                  <div className="ra-hero">
            <p className="ra-hero-title">Research planner</p>
            <p className="ra-hero-sub">
              Enter your topic and goal, generate a structured plan, then review sub-questions and the brief below — all on this page.
            </p>
          </div>

          <div className="ra-input-zone">
            <div className="ra-field-group">
              <label className="ra-field-label" htmlFor="research-topic">
                Topic
              </label>
              <input
                id="research-topic"
                className="ra-topic-input ra-topic-input-full"
                type="text"
                value={topic}
                onChange={(e) => {
                  setTopic(e.target.value)
                  setTopicBlurHint(null)
                }}
                onBlur={() => {
                  if (topic.trim().length === 0) {
                    setTopicBlurHint('Please enter a topic.')
                  }
                }}
                placeholder="e.g. causal inference for observational studies"
                aria-label="Research topic"
                aria-invalid={Boolean(topicBlurHint)}
              />
              {topicBlurHint ? <p className="ra-field-hint-warn">{topicBlurHint}</p> : null}
            </div>

            <div className="ra-field-group">
              <label className="ra-field-label" htmlFor="research-goal">
                Goal
              </label>
              <textarea
                id="research-goal"
                className="ra-goal-input"
                value={goal}
                maxLength={MAX_GOAL_CHARS}
                onChange={(e) => {
                  setGoal(e.target.value)
                  setGoalBlurHint(null)
                }}
                onBlur={() => {
                  if (goal.trim().length === 0) {
                    setGoalBlurHint('Please describe your goal.')
                  }
                }}
                placeholder="What outcome do you want from this research?"
                aria-label="Research goal"
                aria-invalid={Boolean(goalBlurHint)}
              />
              <div className="ra-goal-meta">
                <span
                  className={
                    goal.length >= MAX_GOAL_CHARS
                      ? 'ra-char-count ra-char-count-limit'
                      : 'ra-char-count'
                  }
                >
                  {goal.length} / {MAX_GOAL_CHARS}
                </span>
              </div>
              {goalBlurHint ? <p className="ra-field-hint-warn">{goalBlurHint}</p> : null}
            </div>

            <div className="ra-input-row">
              <button
                className={['ra-go-btn', agentState === 'planning' || agentState === 'researching' ? 'ra-go-btn--working' : '']
                  .filter(Boolean)
                  .join(' ')}
                type="button"
                onClick={() => void startResearch()}
                disabled={agentState === 'planning' || agentState === 'researching' || !formReadyForSubmit}
              >
                {agentState === 'planning'
                  ? 'Planning…'
                  : agentState === 'researching'
                    ? 'Research running…'
                    : 'Generate plan'}
              </button>
            </div>

            <p className="ra-input-hint">
              Topic: {MIN_TOPIC_CHARS}+ characters. Goal: {MIN_GOAL_CHARS}+ characters, max {MAX_GOAL_CHARS}. Submit stays disabled until both are valid.
            </p>
            {requestError ? <p className="ra-input-hint ra-input-hint-error">Error: {requestError}</p> : null}
          </div>

          <div className="ra-planner-section">
            <div className="ra-section-head">
              <p className="ra-section-eyebrow">Output</p>
              <p className="ra-section-title">Plan &amp; review</p>
              <p className="ra-section-sub">Sub-questions, ambiguity score, and export appear here after you generate a plan.</p>
            </div>

            {agentState === 'planned' && subQuestions.length > 0 ? (
              <div className="ra-planner-actions">
                <button className="ra-go-btn ra-planner-approve" type="button" onClick={approvePlan}>
                  Approve &amp; Start Research
                </button>
              </div>
            ) : null}

            <div className="ra-output-zone">
              <div className="ra-output-header">
                <span className="ra-output-label">Research brief</span>
                <div className="ra-export-actions">
                  <button type="button" className="ra-export-btn ra-export-btn-primary" onClick={() => void exportDocx()}>
                    Export .docx
                  </button>
                  <button type="button" className="ra-export-btn" onClick={() => downloadTextFile('research-brief.md', markdownExport)}>
                    Export .md
                  </button>
                </div>
              </div>
              <div className="ra-brief-card">
                <p className="ra-brief-title">{briefTitle}</p>
                <p className="ra-brief-meta">{briefMeta}</p>
                <div className="ra-brief-body">
                  {briefChunks.length === 0 ? (
                    <p className="ra-muted">Run <strong>Generate plan</strong> above to populate the brief with ambiguity score and planner notes.</p>
                  ) : (
                    briefChunks.map((chunk, i) => (
                      <p
                        className="ra-brief-paragraph ra-brief-paragraph--enter"
                        key={i}
                        style={{ animationDelay: `${Math.min(i, 14) * 42}ms` }}
                      >
                        {chunk}
                      </p>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="ra-content">
              <div className="ra-panel ra-panel-left">
                <p className="ra-panel-label">Sub-questions</p>
                <div className="ra-subq-list">
                  {subQuestions.map((sq, idx) => (
                    <div
                      className={['ra-subq-item', sq.status === 'active' && 'ra-subq-item--active'].filter(Boolean).join(' ')}
                      key={sq.id}
                    >
                      <div className="ra-subq-num">{idx + 1}</div>
                      <div className="ra-subq-body">
                        <div className="ra-subq-meta">
                          Step {sq.planStepIndex} · {sq.type}
                        </div>
                        <div className="ra-subq-text">{sq.text}</div>
                      </div>
                      <div
                        className={[
                          'ra-subq-status',
                          sq.status === 'done'
                            ? 'ra-status-done'
                            : sq.status === 'active'
                              ? 'ra-status-active'
                              : 'ra-status-pending',
                        ].join(' ')}
                        aria-label={statusToLabel(sq.status)}
                        title={statusToLabel(sq.status)}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="ra-panel">
                <p className="ra-panel-label">Request summary</p>
                <div className="ra-search-log">
                  <div className="ra-log-item">
                    <div className={['ra-log-icon', 'ra-log-done'].join(' ')} />
                    <div>
                      <div className="ra-log-text">Topic</div>
                      <div className="ra-log-source">{topic.trim() || '(none)'}</div>
                    </div>
                  </div>
                  <div className="ra-log-item">
                    <div className={['ra-log-icon', 'ra-log-done'].join(' ')} />
                    <div>
                      <div className="ra-log-text">Goal</div>
                      <div className="ra-log-source">{goal.trim() || '(none)'}</div>
                    </div>
                  </div>
                  {agentMessage ? (
                    <div className="ra-log-item">
                      <div className={plannerLogIconClass(agentState)} />
                      <div>
                        <div className="ra-log-text">Planner message</div>
                        <div className="ra-log-source">{agentMessage}</div>
                      </div>
                    </div>
                  ) : (
                    <div className="ra-empty">Generate a plan to see the latest planner message here.</div>
                  )}
                </div>
              </div>
            </div>

            <div className="ra-statusbar">
              <div className="ra-stat-pill">
                <div className={agentStatDotClass(agentState)} /> {phaseLabel}
              </div>
              <div className="ra-stat-pill">
                <div className="ra-stat-dot ra-stat-dot--success" /> {subQuestions.length} planned questions
              </div>
              <div className="ra-stat-pill">
                <div className="ra-stat-dot ra-stat-dot--neutral" /> {remainingCount} remaining
              </div>
            </div>
          </div>
                </div>
              </div>
            ) : (
              <div className="ra-single-layout">
                <div className="ra-shell ra-shell-single">
                  <header className="ra-topbar">
                    <span className="ra-topbar-section-title">Topics</span>
                  </header>
                  <div className="ra-topics-view">
                    <div className="ra-topics-hero">
                      <p className="ra-topics-hero-title">Topics</p>
                      <p className="ra-topics-hero-sub">
                        Your active research topic from the planner. Use Research to change the topic, goal, and plan.
                      </p>
                    </div>
                    <div className="ra-topics-card">
                      <p className="ra-topics-card-label">Current topic</p>
                      {topicTrim ? (
                        <p className="ra-topics-current">{topicTrim}</p>
                      ) : (
                        <p className="ra-topics-muted">No topic yet. Open Research, enter a topic and goal, then generate a plan.</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
