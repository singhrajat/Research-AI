/** Primary interrogative facet emphasized by a sub-question (matches planner prompt). */
export type SubQuestionType = "what" | "how" | "why" | "when" | "who" | "where" | "other";

export type TaskProfile = {
  requiresReasoning: boolean;
  isHighVolume: boolean;
  outputIsStructured: boolean;
  latencySensitive: boolean;
  minContextWindow?: number;
};

export type SubQuestion = {
  id: string;
  text: string;
  /** Which plan step (1-based index matching planSteps array order). */
  planStepIndex: number;
  type: SubQuestionType;
  dependsOn: string[];
  priority: number;
};
