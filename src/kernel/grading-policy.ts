import { defaultGradingPolicy, gradingPolicy } from "../contracts/grading-policy.ts";
import type { GradingPolicy, GradingPolicyField, QuestionGrading, QuestionGradingFacts } from "../contracts/grading-policy.ts";

export type ResolvedGradingPolicy = Readonly<{ policy: GradingPolicy; fallbacks: readonly GradingPolicyField[]; ignored: readonly string[] }>;

const fields = gradingPolicy.keyof().options;
const fieldNames: ReadonlySet<string> = new Set(fields);

function declaredObject(declared: unknown) {
  return typeof declared === "object" && declared !== null && !Array.isArray(declared) ? declared : undefined;
}

function declaredField(declared: object, field: GradingPolicyField) {
  return Object.hasOwn(declared, field) ? gradingPolicy.shape[field].safeParse(Reflect.get(declared, field)).data : undefined;
}

function unknownVersion(declared: object) {
  return Object.hasOwn(declared, "version") && declaredField(declared, "version") === undefined;
}

export function resolveGradingPolicy(input: unknown): ResolvedGradingPolicy {
  const declared = declaredObject(input);
  const ignored = declared ? Object.keys(declared).filter(field => !fieldNames.has(field)) : [];
  if (!declared || unknownVersion(declared)) return { policy: { ...defaultGradingPolicy }, fallbacks: fields, ignored };
  const fallbacks = fields.filter(field => declaredField(declared, field) === undefined);
  const policy = gradingPolicy.parse(Object.fromEntries(fields.map(field => [field, declaredField(declared, field) ?? defaultGradingPolicy[field]])));
  return { policy, fallbacks, ignored };
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
