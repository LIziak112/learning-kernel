import { defaultGradingPolicy, gradingPolicy } from "../contracts/grading-policy.ts";
import type { GradingPolicy, GradingPolicyField, QuestionGrading, QuestionGradingFacts } from "../contracts/grading-policy.ts";

export type ResolvedGradingPolicy = Readonly<{ policy: GradingPolicy; fallbacks: readonly GradingPolicyField[] }>;

const fields = gradingPolicy.keyof().options;

function declaredField(declared: unknown, field: GradingPolicyField) {
  if (typeof declared !== "object" || declared === null || Array.isArray(declared) || !Object.hasOwn(declared, field)) return undefined;
  return gradingPolicy.shape[field].safeParse(Reflect.get(declared, field)).data;
}

export function resolveGradingPolicy(declared: unknown): ResolvedGradingPolicy {
  const fallbacks = fields.filter(field => declaredField(declared, field) === undefined);
  const policy = gradingPolicy.parse(Object.fromEntries(fields.map(field => [field, declaredField(declared, field) ?? defaultGradingPolicy[field]])));
  return { policy, fallbacks };
}

export function questionGrading(policy: GradingPolicy, { automatic, reference }: QuestionGradingFacts): QuestionGrading {
  if (automatic) return "automatic";
  return reference ? policy.withReference : "teacherReview";
}

export function routeQuestions<Question extends Readonly<{ id: string; facts: QuestionGradingFacts }>>(
  policy: GradingPolicy, questions: readonly Question[],
): Readonly<Record<QuestionGrading, readonly string[]>> {
  const routed: Record<QuestionGrading, string[]> = { automatic: [], selfReview: [], teacherReview: [] };
  for (const { id, facts } of questions) routed[questionGrading(policy, facts)].push(id);
  return routed;
}
