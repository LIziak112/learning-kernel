type ConfirmationPoint = {
  point: "beforeConfirmationCommit" | "afterConfirmationCommit";
  operationId: string;
};

type EvaluationPoint = {
  point: "beforeEvaluation" | "beforeEvaluationComplete";
  submissionId: string;
};

type AutomaticVerdictPoint = {
  point: "afterAutomaticVerdict";
  submissionId: string;
  questionId: string;
};

export type RuntimeCheckpoint = (event: ConfirmationPoint | EvaluationPoint | AutomaticVerdictPoint) => void;
