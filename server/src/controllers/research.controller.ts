import type { RequestHandler } from "express";
import { z } from "zod";
import { generateResearchPlan } from "../services/plannerOrchestrationService";
import {
  runResearchExecution,
  type ResearchSseEvent,
} from "../services/researchExecutionService";
import { runTopicPrecheck } from "../services/topicPrecheckService";

const topicGoalSchema = z.object({
  topic: z.string().trim().min(3, "Topic must be at least 3 characters."),
  goal: z.string().trim().min(10, "Goal must be at least 10 characters.").max(500, "Goal must be at most 500 characters."),
});

const planRequestSchema = topicGoalSchema.extend({
  audience: z.enum(["novice", "intermediate", "expert"]).optional(),
  depth: z.enum(["quick", "standard", "deep"]).optional(),
});

const subQuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  planStepIndex: z.number().int().positive(),
  type: z.enum(["what", "how", "why", "when", "who", "where", "other"]),
  dependsOn: z.array(z.string()),
  priority: z.number().int(),
});

const executeRequestSchema = topicGoalSchema.extend({
  audience: z.enum(["novice", "intermediate", "expert"]).optional(),
  depth: z.enum(["quick", "standard", "deep"]).optional(),
  planSteps: z.array(z.string()).optional(),
  subQuestions: z
    .array(subQuestionSchema)
    .min(1, "At least one sub-question is required.")
    .max(10, "At most 10 sub-questions are allowed."),
});

export const researchPrecheckController: RequestHandler = async (req, res, next) => {
  try {
    const parsed = topicGoalSchema.parse(req.body);
    const result = await runTopicPrecheck(parsed);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const researchPlanController: RequestHandler = async (req, res, next) => {
  try {
    const parsed = planRequestSchema.parse(req.body);
    const plan = await generateResearchPlan(parsed);
    res.json(plan);
  } catch (error) {
    next(error);
  }
};

export const researchExecuteController: RequestHandler = async (req, res, next) => {
  try {
    const parsed = executeRequestSchema.parse(req.body);

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.status(200);
    res.flushHeaders();

    const sendEvent = (event: ResearchSseEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    await runResearchExecution(parsed, sendEvent);
    res.end();
  } catch (error) {
    next(error);
  }
};
