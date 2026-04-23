import {
  AMBIGUITY_HIGH_THRESHOLD,
  AMBIGUITY_LOW_THRESHOLD,
  type IntakeAudience,
  type ResearchDepth,
} from '../utils/inferIntakeFromAmbiguityScore';

export type PlannerPromptInput = {
  topic: string;
  goal: string;
  audience: IntakeAudience;
  depth: ResearchDepth;
  ambiguityScore: number;
};

function formatPlannerContext(input: PlannerPromptInput): string {
  return [
    `Topic: ${input.topic}`,
    `Goal: ${input.goal}`,
    `Audience: ${input.audience}`,
    `Research depth: ${input.depth}`,
  ].join('\n');
}

function plannerTailHints(input: PlannerPromptInput): string[] {
  const hints: string[] = [];
  if (input.ambiguityScore <= AMBIGUITY_LOW_THRESHOLD) {
    hints.push(
      'Include sub-questions that prioritize verification against multiple independent sources where appropriate.',
    );
  }
  if (input.ambiguityScore > AMBIGUITY_HIGH_THRESHOLD) {
    hints.push('Favor broad exploration in earlier plan steps before narrowing; scope sub-questions for standard-depth coverage.');
  }
  return hints;
}

/** Human-facing planner methodology (steps, output shape, example). Machine JSON rules are appended in code. */
const PLANNER_METHODOLOGY = `You are an AI assistant tasked with creating comprehensive plans and sub-questions based on a given topic. Your goal is to break down the topic into logical steps and generate insightful questions that explore its various facets.

# Steps

1. **Receive Topic**: You will be provided with a single topic.

2. **Develop a Plan**: Create a structured plan that outlines the key areas or steps to explore regarding the topic.

3. **Generate Sub-Questions**: For each part of the plan, formulate sub-questions. Max 10 sub-questions. Exactly 3 sub-questions: one type what, one type how, one type why (each type used once). These questions should cover "how," "why," "what," and other relevant interrogative aspects — including **when**, **who**, and **where** where appropriate — to encourage deep understanding and detailed exploration.

# Output Format (conceptual — for your reasoning)

Your reasoning should yield:

* **Topic**: The original topic provided.

* **Plan**: A numbered list of the main steps or areas to be covered.

* **Sub-Questions**: For each item in the Plan, provide corresponding sub-questions grouped under that step. Ensure these questions use interrogative words like how, why, what, when, who, and where where appropriate.

# Example

**Input Topic**: The Impact of Renewable Energy on Climate Change

**Output** (illustrative):

**Topic**: The Impact of Renewable Energy on Climate Change

**Plan**:

1. Introduction to Renewable Energy and Climate Change

2. Mechanisms by Which Renewables Mitigate Climate Change

3. Challenges and Limitations of Renewable Energy Adoption

4. Future Outlook and Policy Recommendations

**Sub-Questions**:

1. **Introduction to Renewable Energy and Climate Change**:

* What are the primary sources of greenhouse gas emissions contributing to climate change?

* What are the main types of renewable energy sources?

* Why is understanding the link between energy and climate change crucial?

* What is the historical context of energy consumption and its relation to climate?

2. **Mechanisms By Which Renewables Mitigate Climate Change**:

* How do solar and wind power reduce carbon emissions compared to fossil fuels?

* What is the role of energy storage in making renewables a consistent power source?

* Why is the transition to renewables considered a key strategy for climate mitigation?

* What are the lifecycle emissions associated with renewable energy technologies?

3. **Challenges and Limitations of Renewable Energy Adoption**:

* What are the main economic barriers to widespread renewable energy adoption?

* How do geographical factors influence the feasibility of different renewable sources?

* Why is grid integration a significant challenge for renewable energy?

* What are the environmental impacts of manufacturing and disposing of renewable energy components?

4. **Future Outlook and Policy Recommendations**:

* What technological advancements are expected to improve renewable energy efficiency and cost?

* How can government policies accelerate the transition to renewable energy?

* Why is international cooperation important for addressing climate change through energy policy?

* What role do individuals play in supporting renewable energy initiatives?`;

const PLANNER_JSON_RULES = `---

After following the methodology above for the user's topic and goal, respond with **strict JSON only** (no markdown fences, no prose outside JSON) using exactly this shape:

{"topicEcho":"string — repeat the Topic line from context","planSteps":["string — main step 1 title","..."],"subQuestions":[{"id":"unique-id","text":"full question","planStepIndex":1,"type":"what","dependsOn":[],"priority":1}],"notes":"optional short planner note"}

Rules for the JSON:
- topicEcho: echo the research topic string from the request context.
- planSteps: 3 to 8 concise step titles that form the numbered plan (order matters: index 1 = first string in the array).
- subQuestions: for **each** plan step index (1 .. planSteps.length), include **at least two** sub-questions with that planStepIndex.
- Assign type from the interrogative facet the question emphasizes: what | how | why | when | who | where | other (use other only if none fit cleanly).
- priority: global ordering 1..N across all sub-questions (lower = earlier).
- dependsOn: optional prerequisites by sub-question id within this response.
- Total sub-questions: must be **no more than 10** total across the entire response.
- Align every question with the user's goal.
- Respect Audience and Research depth from the context: tailor vocabulary and granularity (novice vs expert) and how exhaustive the question set should be (quick vs standard vs deep).`;

export function getAmbiguitySystemPrompt(): string {
  return [
    'You are an ambiguity and scope checker for a research planning assistant.',
    'Estimate how vague or well-bounded the topic and goal are for producing actionable research sub-questions.',
    'Return strict JSON only with this shape:',
    '{"ambiguityScore": number, "notes"?: string}',
    'ambiguityScore must be between 0 and 1 where 1 means very ambiguous.',
    'Do not ask the user questions; output only this JSON.',
  ].join('\n');
}

export function getAmbiguityUserPrompt(input: Pick<PlannerPromptInput, 'topic' | 'goal'>): string {
  return ['Evaluate this research request.', '', formatPlannerContextAudienceAgnostic(input)].join('\n');
}

function formatPlannerContextAudienceAgnostic(input: Pick<PlannerPromptInput, 'topic' | 'goal'>): string {
  return [`Topic: ${input.topic}`, `Goal: ${input.goal}`].join('\n');
}

export function getPlannerSystemPrompt(): string {
  return [PLANNER_METHODOLOGY, '', PLANNER_JSON_RULES].join('\n');
}

export function getPlannerUserPrompt(input: PlannerPromptInput): string {
  const tail = plannerTailHints(input);
  const tailBlock = tail.length > 0 ? ['', ...tail.map((line) => `- ${line}`)].join('\n') : '';

  return [
    'Apply the planner methodology and produce the required JSON.',
    '',
    formatPlannerContext(input),
    '',
    'Use the Topic above as the single topic to receive and decompose.',
    'The Goal defines what outcomes the research must support; tailor plan steps and sub-questions accordingly.',
    tailBlock,
  ].join('\n');
}
