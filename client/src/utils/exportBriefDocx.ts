import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'

const PLAN_REF = 'plan-outline-numbers'

export type BriefDocxSubQuestion = {
  text: string
  planStepIndex: number
  type: string
  statusLabel: string
}

export type BriefDocxParams = {
  briefTitle: string
  briefMeta: string
  topic: string
  goal: string
  planOutline: string[]
  subQuestions: BriefDocxSubQuestion[]
  agentMessage: string | null
  briefChunks: string[]
}

function textRunsFromInline(text: string): TextRun[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  const runs: TextRun[] = []
  for (const part of parts) {
    if (!part) continue
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true }))
    } else {
      runs.push(new TextRun(part))
    }
  }
  return runs.length > 0 ? runs : [new TextRun(text)]
}

function briefTextToParagraphs(text: string): Paragraph[] {
  const lines = text.split('\n')
  const out: Paragraph[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue

    const headingMatch = t.match(/^(#{1,3})\s+(.+)$/)
    if (headingMatch) {
      const depth = headingMatch[1].length
      const content = headingMatch[2]
      const heading =
        depth <= 1
          ? HeadingLevel.HEADING_1
          : depth === 2
            ? HeadingLevel.HEADING_2
            : HeadingLevel.HEADING_3
      out.push(new Paragraph({ text: content, heading }))
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const content = line.replace(/^\s*[-*]\s+/, '').trim()
      out.push(
        new Paragraph({
          children: textRunsFromInline(content),
          bullet: { level: 0 },
        }),
      )
      continue
    }

    out.push(new Paragraph({ children: textRunsFromInline(t) }))
  }
  return out
}

function h2(text: string): Paragraph {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 },
  })
}

export async function buildResearchBriefDocxBlob(params: BriefDocxParams): Promise<Blob> {
  const {
    briefTitle,
    briefMeta,
    topic,
    goal,
    planOutline,
    subQuestions,
    agentMessage,
    briefChunks,
  } = params

  const children: Paragraph[] = [
    new Paragraph({
      text: briefTitle,
      heading: HeadingLevel.TITLE,
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: textRunsFromInline(briefMeta),
      spacing: { after: 360 },
    }),

    h2('Topic'),
    new Paragraph({
      children: textRunsFromInline(topic.trim() || '(none)'),
      spacing: { after: 200 },
    }),

    h2('Goal'),
    new Paragraph({
      children: textRunsFromInline(goal.trim() || '(none)'),
      spacing: { after: 200 },
    }),

    h2('Plan outline'),
  ]

  if (planOutline.length === 0) {
    children.push(new Paragraph({ text: '(none)', spacing: { after: 200 } }))
  } else {
    for (const step of planOutline) {
      children.push(
        new Paragraph({
          children: textRunsFromInline(step),
          numbering: { reference: PLAN_REF, level: 0 },
          spacing: { after: 80 },
        }),
      )
    }
  }

  children.push(h2('Sub-questions'))

  if (subQuestions.length === 0) {
    children.push(new Paragraph({ text: '(none)', spacing: { after: 200 } }))
  } else {
    for (const sq of subQuestions) {
      const label = `Step ${sq.planStepIndex} · ${sq.type} · ${sq.statusLabel}`
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${label}: `, bold: true }),
            ...textRunsFromInline(sq.text),
          ],
          bullet: { level: 0 },
          spacing: { after: 80 },
        }),
      )
    }
  }

  children.push(h2('Planner status'))
  children.push(
    new Paragraph({
      children: textRunsFromInline(agentMessage?.trim() || '(none)'),
      spacing: { after: 200 },
    }),
  )

  children.push(h2('Research brief'))
  const body = briefChunks.map((c) => c.trim()).filter(Boolean).join('\n\n').trim()
  if (!body) {
    children.push(new Paragraph({ text: '(brief not generated yet)' }))
  } else {
    children.push(...briefTextToParagraphs(body))
  }

  const doc = new Document({
    title: briefTitle,
    creator: 'ResearchAI',
    description: briefMeta,
    numbering: {
      config: [
        {
          reference: PLAN_REF,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children,
      },
    ],
  })

  return Packer.toBlob(doc)
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
