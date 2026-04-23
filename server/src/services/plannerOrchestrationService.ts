import { z } from "zod";
import {
  getAmbiguitySystemPrompt,
  getAmbiguityUserPrompt,
  getPlannerSystemPrompt,
  getPlannerUserPrompt,
  type PlannerPromptInput,
} from "../prompts/plannerPrompts";
import { type SubQuestion, type TaskProfile } from "../models/taskProfile";
import {
  inferIntakeFromAmbiguityScore,
  type IntakeAudience,
  type ResearchDepth,
} from "../utils/inferIntakeFromAmbiguityScore";
import { getModelForTask } from "../config/modelConfig";
import { logger } from "../utils/logger";
import { Langfuse } from "langfuse";
import type { LangfuseTraceClient } from "langfuse";
import { CallbackHandler } from "langfuse-langchain";

const langgraph = require("@langchain/langgraph") as {
  Annotation: any;
  StateGraph: any;
  START: string;
  END: string;
};

const { Annotation, StateGraph, START, END } = langgraph;

export type PlannerRequest = {
  topic: string;
  goal: string;
  audience?: IntakeAudience;
  depth?: ResearchDepth;
};

export type PlannerPlanResult = {
  clarificationNeeded: boolean;
  clarificationQuestion: string;
  ambiguityScore: number;
  audience: IntakeAudience;
  depth: ResearchDepth;
  /** Ordered main steps from the planner (numbered plan outline). */
  planSteps?: string[];
  subQuestions: SubQuestion[];
  notes?: string;
};

export type { IntakeAudience, ResearchDepth } from "../utils/inferIntakeFromAmbiguityScore";

type PlannerGraphState = PlannerRequest & {
  ambiguityScore: number;
  clarificationNeeded: boolean;
  clarificationQuestion: string;
  audience: IntakeAudience;
  depth: ResearchDepth;
  planSteps?: string[];
  subQuestions: SubQuestion[];
  notes?: string;
  error?: string;
};

function createLangfuseClient(): Langfuse | null {
  try {
    logger.stepStart("plannerOrchestration", "Initializing Langfuse client");

    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    const baseUrl = process.env.LANGFUSE_BASE_URL;
    if (!publicKey || !secretKey) {
      logger.warn("plannerOrchestration", "Langfuse keys missing; tracing disabled");
      return null;
    }

    const client = new Langfuse({
      publicKey,
      secretKey,
      baseUrl,
    });
    logger.stepSuccess("plannerOrchestration", "Langfuse client initialized");
    return client;
  } catch (error) {
    logger.stepFailure("plannerOrchestration", "Langfuse client initialization failed", {
      reason: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
}

function normalizeResponseContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part === "object" && part !== null && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        if (typeof part === "object" && part !== null && "type" in part) {
          const block = part as { type?: string; text?: string; reasoning?: string };
          if (block.type === "text" && typeof block.text === "string") {
            return block.text;
          }
          // OpenAI Responses API reasoning summary blocks on AIMessage.content
          if (block.type === "reasoning" && typeof block.reasoning === "string") {
            return block.reasoning;
          }
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

function serializeToolArgsForJsonExtraction(args: unknown): string | null {
  if (args === undefined || args === null) {
    return null;
  }
  if (typeof args === "string") {
    const t = args.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof args === "object") {
    try {
      return JSON.stringify(args);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * When OpenAI reasoning models return an empty `content` string, LangChain preserves the
 * model text in `additional_kwargs.reasoning_content` (see @langchain/openai completions converter).
 *
 * Some models return structured JSON only via `tool_calls` / `function_call` with empty assistant text.
 */
function normalizeAIMessageContentForJsonExtraction(message: unknown): string {
  const m = message as {
    content?: unknown;
    additional_kwargs?: Record<string, unknown>;
    tool_calls?: Array<{ args?: unknown }>;
    invalid_tool_calls?: Array<{ args?: unknown }>;
  };
  const primary = normalizeResponseContent(m.content ?? "");
  if (primary.trim().length > 0) {
    return primary;
  }
  const reasoning = m.additional_kwargs?.reasoning_content;
  if (typeof reasoning === "string" && reasoning.trim().length > 0) {
    return reasoning;
  }

  const parsedOut = m.additional_kwargs?.parsed;
  if (parsedOut !== undefined && parsedOut !== null) {
    const fromParsedKw = serializeToolArgsForJsonExtraction(parsedOut);
    if (fromParsedKw && fromParsedKw.trim().length > 0) {
      return fromParsedKw;
    }
  }

  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      const fromParsed = serializeToolArgsForJsonExtraction(tc?.args);
      if (fromParsed && fromParsed.trim().length > 0) {
        return fromParsed;
      }
    }
  }

  if (Array.isArray(m.invalid_tool_calls)) {
    for (const ic of m.invalid_tool_calls) {
      const fromInvalid = serializeToolArgsForJsonExtraction(ic?.args);
      if (fromInvalid && fromInvalid.trim().length > 0) {
        return fromInvalid;
      }
    }
  }

  const rawCalls = m.additional_kwargs?.tool_calls;
  if (Array.isArray(rawCalls)) {
    for (const rc of rawCalls) {
      const rawArgs = (rc as { function?: { arguments?: string } }).function?.arguments;
      if (typeof rawArgs === "string" && rawArgs.trim().length > 0) {
        return rawArgs;
      }
    }
  }

  const fc = m.additional_kwargs?.function_call as { arguments?: string } | undefined;
  if (typeof fc?.arguments === "string" && fc.arguments.trim().length > 0) {
    return fc.arguments;
  }

  return "";
}

/**
 * Pull the first balanced `{ ... }` from `text`, respecting JSON string quoting
 * so braces inside strings do not throw off depth.
 */
function findBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Prefer JSON inside ``` or ```json fences when the model ignores "no markdown" instructions. */
function extractJsonFromMarkdownFence(text: string): string | null {
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const inner = match[1]?.trim();
    if (!inner) {
      continue;
    }
    const balanced = findBalancedJsonObject(inner);
    if (balanced) {
      return balanced;
    }
  }
  return null;
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Model response did not contain valid JSON.");
  }
  const fromFence = extractJsonFromMarkdownFence(trimmed);
  if (fromFence) {
    return fromFence;
  }
  const balanced = findBalancedJsonObject(trimmed);
  if (balanced) {
    return balanced;
  }
  throw new Error("Model response did not contain valid JSON.");
}

async function invokeJson<T>(args: {
  systemPrompt: string;
  userPrompt: string;
  profile: TaskProfile;
  schema: z.ZodType<T>;
  /** LangChain → Langfuse: creates generation observations with model + usage for cost. */
  langfuseCallback?: CallbackHandler;
  spanName: string;
}): Promise<T> {
  logger.stepStart("plannerOrchestration", `Invoking model for ${args.spanName}`);

  try {
    const model = getModelForTask(args.profile, {
      largeStructuredJsonOutput: args.spanName === "planner-node",
    });
    const callbacks = args.langfuseCallback ? [args.langfuseCallback] : undefined;
    const response = await model.invoke(
      [
        { role: "system", content: args.systemPrompt },
        { role: "user", content: args.userPrompt },
      ],
      {
        callbacks,
        runName: args.spanName,
        tags: ["planner-orchestration", args.spanName],
      },
    );

    const normalizedText = normalizeAIMessageContentForJsonExtraction(response);
    const jsonText = extractJsonObject(normalizedText);
    const parsed = JSON.parse(jsonText) as unknown;
    const result = args.schema.parse(parsed);
    logger.stepSuccess("plannerOrchestration", `Model invocation successful for ${args.spanName}`);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown invokeJson error";

    logger.stepFailure("plannerOrchestration", `Model invocation failed for ${args.spanName}`, {
      reason: msg,
    });

    throw error;
  }
}

const ambiguityResponseSchema = z.object({
  ambiguityScore: z.coerce.number().min(0).max(1),
  notes: z.string().optional(),
});

const interrogativeSchema = z.enum(["what", "how", "why", "when", "who", "where", "other"]);

const plannerResponseSchema = z
  .object({
    topicEcho: z.string().min(1),
    planSteps: z.array(z.string().min(3)).min(3).max(8),
    subQuestions: z
      .array(
        z.object({
          id: z.string().min(1),
          text: z.string().min(5),
          planStepIndex: z.coerce.number().int().min(1),
          type: interrogativeSchema,
          dependsOn: z.array(z.string()).default([]),
          priority: z.coerce.number().int().positive(),
        }),
      )
      .min(6)
      .max(10),
    notes: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    const stepCount = val.planSteps.length;
    for (const sq of val.subQuestions) {
      if (sq.planStepIndex > stepCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `planStepIndex ${sq.planStepIndex} exceeds planSteps length ${stepCount}.`,
          path: ["subQuestions"],
        });
      }
    }
    for (let step = 1; step <= stepCount; step++) {
      const n = val.subQuestions.filter((s) => s.planStepIndex === step).length;
      if (n < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Each plan step needs at least 2 sub-questions (step ${step} has ${n}).`,
          path: ["subQuestions"],
        });
      }
    }
  });

function buildFallbackPlan(topic: string): { planSteps: string[]; subQuestions: SubQuestion[] } {
  const planSteps = [
    `Introduction and framing: ${topic}`,
    `Mechanisms, processes, and how ${topic} operates`,
    `Challenges, stakeholders, context (where/when it applies)`,
    `Outlook, rationale, and why ${topic} matters`,
  ];

  const subQuestions: SubQuestion[] = [
    {
      id: "sq_s1_q1",
      text: `What definitions, scope, and boundaries matter most when researching ${topic}?`,
      planStepIndex: 1,
      type: "what",
      dependsOn: [],
      priority: 1,
    },
    {
      id: "sq_s1_q2",
      text: `Why is clarity on scope important before deeper analysis of ${topic}?`,
      planStepIndex: 1,
      type: "why",
      dependsOn: [],
      priority: 2,
    },
    {
      id: "sq_s2_q1",
      text: `How does ${topic} work in practice — main mechanisms or causal pathways?`,
      planStepIndex: 2,
      type: "how",
      dependsOn: ["sq_s1_q1"],
      priority: 3,
    },
    {
      id: "sq_s2_q2",
      text: `What evidence best demonstrates how outcomes arise in ${topic}?`,
      planStepIndex: 2,
      type: "what",
      dependsOn: ["sq_s2_q1"],
      priority: 4,
    },
    {
      id: "sq_s3_q1",
      text: `Where and when does ${topic} apply, and what constraints vary by context?`,
      planStepIndex: 3,
      type: "where",
      dependsOn: ["sq_s2_q1"],
      priority: 5,
    },
    {
      id: "sq_s3_q2",
      text: `Who are the key stakeholders or actors affected by ${topic}?`,
      planStepIndex: 3,
      type: "who",
      dependsOn: [],
      priority: 6,
    },
    {
      id: "sq_s4_q1",
      text: `Why does ${topic} matter — drivers, incentives, or consequences to prioritize?`,
      planStepIndex: 4,
      type: "why",
      dependsOn: ["sq_s3_q1"],
      priority: 7,
    },
    {
      id: "sq_s4_q2",
      text: `What uncertainties or trade-offs shape the future outlook for ${topic}?`,
      planStepIndex: 4,
      type: "what",
      dependsOn: ["sq_s4_q1"],
      priority: 8,
    },
  ];

  return { planSteps, subQuestions };
}

function resolveIntakeFromScore(
  score: number,
  overrideAudience: IntakeAudience | undefined,
  overrideDepth: ResearchDepth | undefined,
): { audience: IntakeAudience; depth: ResearchDepth } {
  const inferred = inferIntakeFromAmbiguityScore(score);
  return {
    audience: overrideAudience ?? inferred.audience,
    depth: overrideDepth ?? inferred.depth,
  };
}

function toPromptInput(state: PlannerGraphState): PlannerPromptInput {
  return {
    topic: state.topic,
    goal: state.goal,
    audience: state.audience,
    depth: state.depth,
    ambiguityScore: state.ambiguityScore,
  };
}

function ambiguityPromptSlice(state: PlannerGraphState): Pick<PlannerPromptInput, "topic" | "goal"> {
  return { topic: state.topic, goal: state.goal };
}

export async function generateResearchPlan(input: PlannerRequest): Promise<PlannerPlanResult> {
  logger.stepStart("plannerOrchestration", "Phase 1 planning started", {
    topic: input.topic,
  });
  const langfuse = createLangfuseClient();
  const trace: LangfuseTraceClient | undefined = langfuse?.trace({
    name: "phase1-planner-orchestration",
    input,
  });
  const langfuseCallback = trace ? new CallbackHandler({ root: trace }) : undefined;

  const orchestrationSpan = trace?.span({
    name: "graph-entry",
    input,
  });

  const PlannerState = Annotation.Root({
    topic: Annotation(),
    goal: Annotation(),
    ambiguityScore: Annotation(),
    clarificationNeeded: Annotation(),
    clarificationQuestion: Annotation(),
    audience: Annotation(),
    depth: Annotation(),
    planSteps: Annotation(),
    subQuestions: Annotation(),
    notes: Annotation(),
    error: Annotation(),
  });

  const ambiguityNodeProfile: TaskProfile = {
    requiresReasoning: true,
    isHighVolume: false,
    outputIsStructured: true,
    latencySensitive: false,
  };

  const plannerNodeProfile: TaskProfile = {
    requiresReasoning: true,
    isHighVolume: false,
    outputIsStructured: true,
    latencySensitive: false,
  };

  const graph = new StateGraph(PlannerState)
    .addNode("ambiguityNode", async (state: PlannerGraphState): Promise<Partial<PlannerGraphState>> => {
      logger.stepStart("plannerOrchestration", "ambiguityNode started");
      const ambiguityInput = ambiguityPromptSlice(state);
      try {
        const response = await invokeJson({
          systemPrompt: getAmbiguitySystemPrompt(),
          userPrompt: getAmbiguityUserPrompt(ambiguityInput),
          profile: ambiguityNodeProfile,
          schema: ambiguityResponseSchema,
          langfuseCallback,
          spanName: "ambiguity-node",
        });

        const resolved = resolveIntakeFromScore(response.ambiguityScore, state.audience, state.depth);

        return {
          ambiguityScore: response.ambiguityScore,
          clarificationNeeded: false,
          clarificationQuestion: "",
          audience: resolved.audience,
          depth: resolved.depth,
          notes: response.notes,
        };
      } catch (error) {
        logger.stepFailure("plannerOrchestration", "ambiguityNode failed; using fallback", {
          reason: error instanceof Error ? error.message : "Unknown ambiguity node error",
        });
        const fallbackScore = 0.5;
        const resolved = resolveIntakeFromScore(fallbackScore, state.audience, state.depth);
        return {
          ambiguityScore: fallbackScore,
          clarificationNeeded: false,
          clarificationQuestion: "",
          audience: resolved.audience,
          depth: resolved.depth,
          notes: "Ambiguity check fallback used due to model parse failure.",
          error: error instanceof Error ? error.message : "Unknown ambiguity node error.",
        };
      }
    })
    .addNode("plannerNode", async (state: PlannerGraphState): Promise<Partial<PlannerGraphState>> => {
      logger.stepStart("plannerOrchestration", "plannerNode started");

      const promptInput = toPromptInput(state);
      try {
        const response = await invokeJson({
          systemPrompt: getPlannerSystemPrompt(),
          userPrompt: getPlannerUserPrompt(promptInput),
          profile: plannerNodeProfile,
          schema: plannerResponseSchema,
          langfuseCallback,
          spanName: "planner-node",
        });

        const normalized = [...response.subQuestions].sort((left, right) => left.priority - right.priority).map((item, index) => ({
          ...item,
          priority: index + 1,
        }));

        return {
          planSteps: response.planSteps,
          subQuestions: normalized,
          notes: response.notes ?? state.notes,
        };
      } catch (error) {
        logger.stepFailure("plannerOrchestration", "plannerNode failed; using fallback", {
          reason: error instanceof Error ? error.message : "Unknown planner node error",
        });
        const fallback = buildFallbackPlan(state.topic);
        return {
          planSteps: fallback.planSteps,
          subQuestions: fallback.subQuestions,
          notes: "Planner fallback used due to model parse failure.",
          error: error instanceof Error ? error.message : "Unknown planner node error.",
        };
      }
    })
    .addEdge(START, "ambiguityNode")
    .addEdge("ambiguityNode", "plannerNode")
    .addEdge("plannerNode", END)
    .compile();

  const result = (await graph.invoke({
    ...input,
    ambiguityScore: 0,
    clarificationNeeded: false,
    clarificationQuestion: "",
    audience: input.audience ?? ("intermediate" as IntakeAudience),
    depth: input.depth ?? ("standard" as ResearchDepth),
    planSteps: [],
    subQuestions: [],
    notes: undefined,
    error: undefined,
  })) as PlannerGraphState;
  logger.stepSuccess("plannerOrchestration", "Graph execution completed", {
    clarificationNeeded: result.clarificationNeeded,
    subQuestionCount: result.subQuestions.length,
    hasError: Boolean(result.error),
  });

  orchestrationSpan?.end({
    output: {
      clarificationNeeded: result.clarificationNeeded,
      ambiguityScore: result.ambiguityScore,
      audience: result.audience,
      depth: result.depth,
      subQuestionCount: result.subQuestions.length,
      error: result.error,
    },
  });
  trace?.update?.({
    output: {
      clarificationNeeded: result.clarificationNeeded,
      clarificationQuestion: result.clarificationQuestion,
      ambiguityScore: result.ambiguityScore,
      audience: result.audience,
      depth: result.depth,
      planSteps: result.planSteps,
      subQuestions: result.subQuestions,
      notes: result.notes,
    },
  });

  try {
    await langfuse?.flushAsync?.();
    logger.stepSuccess("plannerOrchestration", "Langfuse flush completed");
  } catch (error) {
    logger.stepFailure("plannerOrchestration", "Langfuse flush failed", {
      reason: error instanceof Error ? error.message : "Unknown flush error",
    });
  }

  logger.stepSuccess("plannerOrchestration", "Phase 1 planning finished");
  return {
    clarificationNeeded: false,
    clarificationQuestion: "",
    ambiguityScore: result.ambiguityScore,
    audience: result.audience,
    depth: result.depth,
    planSteps: result.planSteps,
    subQuestions: result.subQuestions,
    notes: result.notes,
  };
}
