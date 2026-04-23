import { z } from "zod";
import { getModelForTask } from "../config/modelConfig";
import type { TaskProfile } from "../models/taskProfile";
import {
  getTopicPrecheckSystemPrompt,
  getTopicPrecheckUserPrompt,
} from "../prompts/topicPrecheckPrompts";
import { logger } from "../utils/logger";
type TopicPrecheckInput = {
  topic: string;
  goal: string;
};

const precheckProfile: TaskProfile = {
  requiresReasoning: false,
  isHighVolume: false,
  outputIsStructured: true,
  latencySensitive: true,
};

const topicPrecheckResponseSchema = z.object({
  acceptable: z.boolean(),
  issue: z.enum(["none", "vague", "too_broad"]),
  message: z.string().min(1),
  suggestions: z.array(z.string().min(3)).max(5).optional(),
});

export type TopicPrecheckResult = z.infer<typeof topicPrecheckResponseSchema>;

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
        return "";
      })
      .join("\n");
  }
  return "";
}

function extractJsonObject(text: string): string {
  const startIndex = text.indexOf("{");
  const endIndex = text.lastIndexOf("}");
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error("Model response did not contain valid JSON.");
  }
  return text.slice(startIndex, endIndex + 1);
}

export async function runTopicPrecheck(input: TopicPrecheckInput): Promise<TopicPrecheckResult> {
  logger.stepStart("topicPrecheck", "Topic pre-check started", { topic: input.topic });

  try {
    const model = getModelForTask(precheckProfile);
    const response = await model.invoke([
      { role: "system", content: getTopicPrecheckSystemPrompt() },
      { role: "user", content: getTopicPrecheckUserPrompt(input.topic, input.goal) },
    ]);

    const text = normalizeResponseContent((response as { content?: unknown }).content ?? "");
    const jsonText = extractJsonObject(text);
    const parsed = JSON.parse(jsonText) as unknown;
    const parsedResult = topicPrecheckResponseSchema.parse(parsed);

    let result = parsedResult;
    if (result.acceptable && result.issue !== "none") {
      logger.warn("topicPrecheck", "Model marked acceptable but issue was not none; normalizing");
      result = { ...result, issue: "none" };
    } else if (!result.acceptable && result.issue === "none") {
      result = { ...result, issue: "vague" };
    }

    logger.stepSuccess("topicPrecheck", "Topic pre-check complete", {
      acceptable: result.acceptable,
      issue: result.issue,
    });
    return result;
  } catch (error) {
    logger.stepFailure("topicPrecheck", "Topic pre-check failed", {
      reason: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}
