import type { Document } from "@langchain/core/documents";
import type { IntakeAudience, ResearchDepth } from "../utils/inferIntakeFromAmbiguityScore";

export function formatSearchResultsForPrompt(docs: Document[]): string {
  if (!docs.length) {
    return "(No web results returned for this query.)";
  }
  return docs
    .map((doc, index) => {
      const title =
        typeof doc.metadata?.title === "string" && doc.metadata.title.trim().length > 0
          ? doc.metadata.title
          : "Source";
      const url =
        typeof doc.metadata?.source === "string" && doc.metadata.source.trim().length > 0
          ? doc.metadata.source
          : "";
      const body = typeof doc.pageContent === "string" ? doc.pageContent.trim() : "";
      return [`### Result ${index + 1}: ${title}`, url ? `URL: ${url}` : null, body].filter(Boolean).join("\n");
    })
    .join("\n\n---\n\n");
}

export function getSearchSummarySystemPrompt(): string {
  return [
    "You are a careful research assistant.",
    "Given a sub-question and raw web search snippets, write a concise summary (2–4 sentences).",
    "Use only what the snippets support; if evidence is thin, say so briefly.",
    "Do not invent citations or URLs. Output plain text only (no markdown headings).",
  ].join(" ");
}

export function getSearchSummaryUserPrompt(input: {
  topic: string;
  goal: string;
  subQuestionText: string;
  searchResultsText: string;
}): string {
  return [
    `Research topic: ${input.topic}`,
    `Research goal: ${input.goal}`,
    "",
    `Sub-question to answer: ${input.subQuestionText}`,
    "",
    "Web search excerpts:",
    input.searchResultsText,
    "",
    "Summarize the answer to the sub-question in 2–4 sentences.",
  ].join("\n");
}

export function getSynthesisSystemPrompt(): string {
  return [
    "You write clear, readable research briefs for a general audience.",
    "Combine the per-question summaries into one cohesive markdown document.",
    "Structure the output with these sections (use ## headings exactly):",
    "## Executive Summary",
    "## Findings",
    "## Key Takeaways",
    "Under Findings, include one short subsection per sub-question (use ### with a descriptive title).",
    "Be concise; prefer bullets where helpful. Do not fabricate facts beyond the supplied summaries.",
  ].join(" ");
}

export function getSynthesisUserPrompt(input: {
  topic: string;
  goal: string;
  audience?: IntakeAudience;
  depth?: ResearchDepth;
  planSteps?: string[];
  summaries: Array<{ id: string; text: string; summary: string }>;
}): string {
  const audienceLine = input.audience ? `Audience: ${input.audience}` : null;
  const depthLine = input.depth ? `Depth: ${input.depth}` : null;
  const planLines =
    input.planSteps && input.planSteps.length > 0
      ? ["Plan outline:", ...input.planSteps.map((step, i) => `${i + 1}. ${step}`)].join("\n")
      : null;

  const blocks = input.summaries
    .map((row) => [`### Sub-question (${row.id})`, row.text, "", "Evidence summary:", row.summary].join("\n"))
    .join("\n\n---\n\n");

  return [
    `Topic: ${input.topic}`,
    `Goal: ${input.goal}`,
    audienceLine,
    depthLine,
    planLines,
    "",
    "Per-sub-question evidence summaries:",
    blocks,
    "",
    "Write the full markdown brief as specified in the system message.",
  ]
    .filter((line) => line !== null && line !== "")
    .join("\n");
}
