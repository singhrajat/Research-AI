/** Matches intake-style enums used across the planner API. */
export type IntakeAudience = 'novice' | 'intermediate' | 'expert';
export type ResearchDepth = 'quick' | 'standard' | 'deep';

/** Upper bound for "low ambiguity" tier (clear / technical — verification emphasis). */
export const AMBIGUITY_LOW_THRESHOLD = 0.33;

/** Upper bound for "mid ambiguity" tier (semi-clear — targeted deep dive). Exclusive above AMBIGUITY_LOW_THRESHOLD. */
export const AMBIGUITY_HIGH_THRESHOLD = 0.66;

/**
 * Maps model ambiguity score (0 = specific, 1 = very ambiguous) to default audience and research depth.
 *
 * Policy:
 * - score > 0.66 — vague: broad exploration first → intermediate + standard
 * - score in (0.33, 0.66] — semi-clear → intermediate + deep
 * - score ≤ 0.33 — clear/technical → expert + deep (verification via planner prompt)
 */
export function inferIntakeFromAmbiguityScore(score: number): {
  audience: IntakeAudience;
  depth: ResearchDepth;
} {
  const s = Math.min(1, Math.max(0, score));
  if (s > AMBIGUITY_HIGH_THRESHOLD) {
    return { audience: 'intermediate', depth: 'standard' };
  }
  if (s > AMBIGUITY_LOW_THRESHOLD) {
    return { audience: 'intermediate', depth: 'deep' };
  }
  return { audience: 'expert', depth: 'deep' };
}
