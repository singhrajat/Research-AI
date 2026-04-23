import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type { TaskProfile } from "../models/taskProfile";
import { logger } from "../utils/logger";

const modelRegistryEntrySchema = z.object({
  id: z.string().min(1),
  tier: z.number().int().positive(),
  reasoningClass: z.boolean().default(false),
  supportsStructuredOutput: z.boolean().default(true),
  contextWindow: z.number().int().positive().optional(),
});

type ModelRegistryEntry = z.infer<typeof modelRegistryEntrySchema>;

const configSchema = z.object({
  OPENAI_MODEL: z.string().min(1),
  OPENAI_TEMPERATURE: z.coerce.number(),
  OPENAI_MAX_TOKENS: z.coerce.number().int().positive(),
  OPENAI_BRS_REVIEWER_MODEL: z.string().min(1),
  MODEL_REGISTRY: z.string().min(2),
  MAX_TIER: z.coerce.number().int().positive(),
});

type ResolvedModelConfig = {
  chatModelId: string;
  reviewerModelId: string;
  temperature: number;
  maxTokens: number;
  maxTier: number;
  registry: ModelRegistryEntry[];
};

let cachedConfig: ResolvedModelConfig | null = null;

/**
 * Reasoning-class models bill internal reasoning against the same completion budget as visible text.
 * The Phase-1 planner emits a large JSON payload; when `OPENAI_MAX_TOKENS` is modest (e.g. 2000),
 * the model can exhaust the budget before producing any assistant-visible output — yielding empty
 * content and empty tool-call arguments. This floor is applied only when
 * {@link GetModelForTaskOptions.largeStructuredJsonOutput} is true (planner-node).
 */
const PLANNER_JSON_COMPLETION_TOKEN_FLOOR = 16_384;

export type GetModelForTaskOptions = {
  largeStructuredJsonOutput?: boolean;
};

function isReasoningModelId(modelId: string): boolean {
  return /^o\d/i.test(modelId.trim());
}

function parseModelRegistry(rawRegistry: string): ModelRegistryEntry[] {
  logger.stepStart("modelConfig", "Parsing MODEL_REGISTRY");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawRegistry);
  } catch (error) {
    logger.stepFailure("modelConfig", "MODEL_REGISTRY parsing failed", {
      reason: error instanceof Error ? error.message : "Invalid JSON",
    });
    throw new Error("MODEL_REGISTRY must be valid JSON.");
  }

  const schema = z.array(modelRegistryEntrySchema).min(1);
  const registry = schema.parse(parsed);

  const duplicateIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const item of registry) {
    if (seenIds.has(item.id)) {
      duplicateIds.add(item.id);
    }
    seenIds.add(item.id);
  }

  if (duplicateIds.size > 0) {
    logger.stepFailure("modelConfig", "MODEL_REGISTRY validation failed", {
      reason: `Duplicate model ids: ${Array.from(duplicateIds).join(", ")}`,
    });
    throw new Error(`MODEL_REGISTRY contains duplicate model ids: ${Array.from(duplicateIds).join(", ")}`);
  }

  logger.stepSuccess("modelConfig", "MODEL_REGISTRY parsed successfully", { count: registry.length });
  return registry;
}

function getConfig(): ResolvedModelConfig {
  if (cachedConfig) {
    logger.stepSuccess("modelConfig", "Using cached model configuration");
    return cachedConfig;
  }

  logger.stepStart("modelConfig", "Resolving model configuration from environment");
  let parsedEnv: z.infer<typeof configSchema>;
  try {
    parsedEnv = configSchema.parse(process.env);
  } catch (error) {
    logger.stepFailure("modelConfig", "Environment validation failed for modelConfig", {
      reason: error instanceof Error ? error.message : "Invalid environment values",
    });
    throw error;
  }
  const registry = parseModelRegistry(parsedEnv.MODEL_REGISTRY);

  const modelIds = new Set(registry.map((item) => item.id));
  if (!modelIds.has(parsedEnv.OPENAI_MODEL)) {
    logger.stepFailure("modelConfig", "OPENAI_MODEL not present in registry", { modelId: parsedEnv.OPENAI_MODEL });
    throw new Error("OPENAI_MODEL must exist in MODEL_REGISTRY.");
  }
  if (!modelIds.has(parsedEnv.OPENAI_BRS_REVIEWER_MODEL)) {
    logger.stepFailure("modelConfig", "OPENAI_BRS_REVIEWER_MODEL not present in registry", {
      modelId: parsedEnv.OPENAI_BRS_REVIEWER_MODEL,
    });
    throw new Error("OPENAI_BRS_REVIEWER_MODEL must exist in MODEL_REGISTRY.");
  }

  cachedConfig = {
    chatModelId: parsedEnv.OPENAI_MODEL,
    reviewerModelId: parsedEnv.OPENAI_BRS_REVIEWER_MODEL,
    temperature: parsedEnv.OPENAI_TEMPERATURE,
    maxTokens: parsedEnv.OPENAI_MAX_TOKENS,
    maxTier: parsedEnv.MAX_TIER,
    registry,
  };

  logger.stepSuccess("modelConfig", "Model configuration resolved", {
    chatModelId: cachedConfig.chatModelId,
    reviewerModelId: cachedConfig.reviewerModelId,
    maxTier: cachedConfig.maxTier,
    registrySize: cachedConfig.registry.length,
  });
  return cachedConfig;
}

function getModelRegistryEntry(modelId: string): ModelRegistryEntry {
  const config = getConfig();
  const match = config.registry.find((entry) => entry.id === modelId);
  if (!match) {
    throw new Error(`Model "${modelId}" is not available in MODEL_REGISTRY.`);
  }
  return match;
}

function resolveTemperature(modelId: string): number {
  const { temperature } = getConfig();
  return isReasoningModelId(modelId) ? 1 : temperature;
}

function buildChatModel(modelId: string, maxOutputTokens?: number): ChatOpenAI {
  logger.stepStart("modelConfig", "Creating ChatOpenAI model instance", { modelId });
  const { maxTokens } = getConfig();
  const resolvedMaxTokens = maxOutputTokens ?? maxTokens;

  const model = new ChatOpenAI({
    model: modelId,
    temperature: resolveTemperature(modelId),
    maxTokens: resolvedMaxTokens,
  });
  logger.stepSuccess("modelConfig", "ChatOpenAI model instance created", {
    modelId,
    maxTokens: resolvedMaxTokens,
  });
  return model;
}

function sortCandidateModels(candidates: ModelRegistryEntry[], profile: TaskProfile): ModelRegistryEntry[] {
  return candidates.sort((left, right) => {
    const leftStructuredPenalty = profile.outputIsStructured && !left.supportsStructuredOutput ? 100 : 0;
    const rightStructuredPenalty = profile.outputIsStructured && !right.supportsStructuredOutput ? 100 : 0;

    const leftReasoningPenalty = !profile.requiresReasoning && left.reasoningClass ? 5 : 0;
    const rightReasoningPenalty = !profile.requiresReasoning && right.reasoningClass ? 5 : 0;

    const leftVolumePenalty = profile.isHighVolume ? left.tier * 2 : left.tier;
    const rightVolumePenalty = profile.isHighVolume ? right.tier * 2 : right.tier;

    const leftLatencyPenalty = profile.latencySensitive ? left.tier : 0;
    const rightLatencyPenalty = profile.latencySensitive ? right.tier : 0;

    const leftScore = leftStructuredPenalty + leftReasoningPenalty + leftVolumePenalty + leftLatencyPenalty;
    const rightScore = rightStructuredPenalty + rightReasoningPenalty + rightVolumePenalty + rightLatencyPenalty;

    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }
    if (left.tier !== right.tier) {
      return left.tier - right.tier;
    }
    return left.id.localeCompare(right.id);
  });
}

export function getOpenAiChatModelId(): string {
  return getConfig().chatModelId;
}

export function getChatModel(): ChatOpenAI {
  return buildChatModel(getConfig().chatModelId);
}

export function getReviewerChatModel(): ChatOpenAI {
  logger.stepStart("modelConfig", "Resolving reviewer model");
  const reviewerModelId = getConfig().reviewerModelId;
  const reviewerRegistryEntry = getModelRegistryEntry(reviewerModelId);
  if (!reviewerRegistryEntry.reasoningClass && !isReasoningModelId(reviewerModelId)) {
    logger.stepFailure("modelConfig", "Reviewer model must be reasoning-class", { reviewerModelId });
    throw new Error("OPENAI_BRS_REVIEWER_MODEL must be a reasoning-class model.");
  }

  logger.stepSuccess("modelConfig", "Reviewer model resolved", { reviewerModelId });
  return buildChatModel(reviewerModelId);
}

export function getModelForTask(profile: TaskProfile, options?: GetModelForTaskOptions): ChatOpenAI {
  logger.stepStart("modelConfig", "Selecting model for task profile", profile);
  const { registry, maxTier, maxTokens } = getConfig();

  const completionCap =
    options?.largeStructuredJsonOutput === true
      ? Math.max(maxTokens, PLANNER_JSON_COMPLETION_TOKEN_FLOOR)
      : maxTokens;

  const candidates = registry.filter((entry) => {
    if (entry.tier > maxTier) {
      return false;
    }
    if (profile.requiresReasoning && !entry.reasoningClass && !isReasoningModelId(entry.id)) {
      return false;
    }
    if (profile.minContextWindow && (!entry.contextWindow || entry.contextWindow < profile.minContextWindow)) {
      return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    logger.stepFailure("modelConfig", "No model candidate matched task profile", { profile, maxTier });
    throw new Error("No model in MODEL_REGISTRY satisfies the TaskProfile within MAX_TIER.");
  }

  const [selected] = sortCandidateModels([...candidates], profile);
  logger.stepSuccess("modelConfig", "Selected model for task profile", {
    selectedModelId: selected.id,
    candidateCount: candidates.length,
    resolvedCompletionTokens: completionCap,
    plannerFloorApplied: options?.largeStructuredJsonOutput === true && completionCap > maxTokens,
  });
  return buildChatModel(selected.id, completionCap);
}

export function getModelRegistry(): ReadonlyArray<ModelRegistryEntry> {
  return getConfig().registry;
}

export function getMaxTier(): number {
  return getConfig().maxTier;
}
