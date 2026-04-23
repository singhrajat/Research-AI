import type { Document } from "@langchain/core/documents";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { TavilySearchAPIRetriever } from "@langchain/community/retrievers/tavily_search_api";
import { env } from "../config/env";
import { getChatModel } from "../config/modelConfig";
import type { SubQuestion } from "../models/taskProfile";
import type { IntakeAudience, ResearchDepth } from "../utils/inferIntakeFromAmbiguityScore";
import {
  formatSearchResultsForPrompt,
  getSearchSummarySystemPrompt,
  getSearchSummaryUserPrompt,
  getSynthesisSystemPrompt,
  getSynthesisUserPrompt,
} from "../prompts/researchExecutionPrompts";
import { logger } from "../utils/logger";

const langgraph = require("@langchain/langgraph") as {
  Annotation: any;
  StateGraph: any;
  START: string;
  END: string;
};

const { Annotation, StateGraph, START, END } = langgraph;

export type ResearchExecuteRequest = {
  topic: string;
  goal: string;
  audience?: IntakeAudience;
  depth?: ResearchDepth;
  planSteps?: string[];
  subQuestions: SubQuestion[];
};

export type ResearchSseEvent =
  | { type: "subquestion_start"; id: string }
  | { type: "subquestion_done"; id: string; summary: string }
  | { type: "synthesis_start" }
  | { type: "complete"; brief: string }
  | { type: "error"; message: string };

type ResearchGraphState = ResearchExecuteRequest & {
  summaries: Record<string, string>;
  brief?: string;
};

function normalizeAiMessageText(message: AIMessage): string {
  const raw = message.content;
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part === "object" && part !== null && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return String(raw ?? "").trim();
}

async function summarizeSearchResults(input: {
  topic: string;
  goal: string;
  subQuestionText: string;
  docs: Document[];
}): Promise<string> {
  const model = getChatModel();
  const searchResultsText = formatSearchResultsForPrompt(input.docs);
  const response = await model.invoke([
    new SystemMessage(getSearchSummarySystemPrompt()),
    new HumanMessage(
      getSearchSummaryUserPrompt({
        topic: input.topic,
        goal: input.goal,
        subQuestionText: input.subQuestionText,
        searchResultsText,
      }),
    ),
  ]);

  const text = normalizeAiMessageText(response as AIMessage);
  return text.length > 0 ? text : "Insufficient evidence from web results to answer this sub-question.";
}

async function synthesizeBrief(state: ResearchGraphState): Promise<string> {
  const model = getChatModel();
  const sorted = [...state.subQuestions].sort((left, right) => left.priority - right.priority);
  const summaries = sorted.map((sq) => ({
    id: sq.id,
    text: sq.text,
    summary: state.summaries[sq.id] ?? "(missing summary)",
  }));

  const response = await model.invoke([
    new SystemMessage(getSynthesisSystemPrompt()),
    new HumanMessage(
      getSynthesisUserPrompt({
        topic: state.topic,
        goal: state.goal,
        audience: state.audience,
        depth: state.depth,
        planSteps: state.planSteps,
        summaries,
      }),
    ),
  ]);

  const text = normalizeAiMessageText(response as AIMessage);
  return text.length > 0 ? text : "## Executive Summary\n\n(No synthesis produced.)";
}

export async function runResearchExecution(
  input: ResearchExecuteRequest,
  onEvent: (event: ResearchSseEvent) => void,
): Promise<void> {
  const apiKey = env.tavilyApiKey;
  if (!apiKey) {
    onEvent({
      type: "error",
      message:
        'Missing TAVILY_API_KEY. Add it to server environment (see server/.env.example) and restart the API.',
    });
    return;
  }

  if (!input.subQuestions.length) {
    onEvent({ type: "error", message: "No sub-questions to research." });
    return;
  }

  const retriever = new TavilySearchAPIRetriever({
    apiKey,
    k: 6,
    searchDepth: "advanced",
  });

  const ResearchState = Annotation.Root({
    topic: Annotation(),
    goal: Annotation(),
    audience: Annotation(),
    depth: Annotation(),
    planSteps: Annotation(),
    subQuestions: Annotation(),
    summaries: Annotation(),
    brief: Annotation(),
  });

  const graph = new StateGraph(ResearchState)
    .addNode(
      "searchAllNode",
      async (state: ResearchGraphState): Promise<Partial<ResearchGraphState>> => {
        logger.stepStart("researchExecution", "searchAllNode started");
        const summaries: Record<string, string> = {};
        const sorted = [...state.subQuestions].sort((left, right) => left.priority - right.priority);

        for (const sq of sorted) {
          onEvent({ type: "subquestion_start", id: sq.id });

          let docs: Document[] = [];
          try {
            const query = `${state.topic} — ${sq.text}`.slice(0, 400);
            docs = await retriever.invoke(query);
          } catch (error) {
            logger.stepFailure("researchExecution", "Tavily retrieval failed", {
              subQuestionId: sq.id,
              reason: error instanceof Error ? error.message : "Unknown Tavily error",
            });
            docs = [];
          }

          let summary: string;
          try {
            summary = await summarizeSearchResults({
              topic: state.topic,
              goal: state.goal,
              subQuestionText: sq.text,
              docs,
            });
          } catch (error) {
            logger.stepFailure("researchExecution", "Summarization failed", {
              subQuestionId: sq.id,
              reason: error instanceof Error ? error.message : "Unknown summarization error",
            });
            summary =
              error instanceof Error
                ? `Summary unavailable due to an error: ${error.message}`
                : "Summary unavailable due to an unknown error.";
          }

          summaries[sq.id] = summary;
          onEvent({ type: "subquestion_done", id: sq.id, summary });
        }

        logger.stepSuccess("researchExecution", "searchAllNode completed", {
          summaryCount: Object.keys(summaries).length,
        });

        return { summaries };
      },
    )
    .addNode(
      "synthesisNode",
      async (state: ResearchGraphState): Promise<Partial<ResearchGraphState>> => {
        logger.stepStart("researchExecution", "synthesisNode started");
        onEvent({ type: "synthesis_start" });
        try {
          const brief = await synthesizeBrief(state);
          logger.stepSuccess("researchExecution", "synthesisNode completed", { briefLength: brief.length });
          return { brief };
        } catch (error) {
          logger.stepFailure("researchExecution", "synthesisNode failed", {
            reason: error instanceof Error ? error.message : "Unknown synthesis error",
          });
          const message = error instanceof Error ? error.message : "Synthesis failed.";
          return {
            brief: `## Executive Summary\n\nSynthesis failed: ${message}`,
          };
        }
      },
    )
    .addEdge(START, "searchAllNode")
    .addEdge("searchAllNode", "synthesisNode")
    .addEdge("synthesisNode", END)
    .compile();

  try {
    const result = (await graph.invoke({
      topic: input.topic,
      goal: input.goal,
      audience: input.audience,
      depth: input.depth,
      planSteps: input.planSteps,
      subQuestions: input.subQuestions,
      summaries: {},
      brief: undefined,
    })) as ResearchGraphState;

    const brief = result.brief?.trim().length ? result.brief!.trim() : "## Executive Summary\n\n(No brief produced.)";
    onEvent({ type: "complete", brief });
  } catch (error) {
    logger.stepFailure("researchExecution", "Graph invocation failed", {
      reason: error instanceof Error ? error.message : "Unknown graph error",
    });
    onEvent({
      type: "error",
      message: error instanceof Error ? error.message : "Research execution failed.",
    });
  }
}
