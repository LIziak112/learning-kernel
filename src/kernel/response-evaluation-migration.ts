export const responseEvaluationMigration = `
  CREATE TABLE response_review_requirements (
    submission_id TEXT NOT NULL REFERENCES evaluation_tasks (submission_id),
    question_id TEXT NOT NULL,
    PRIMARY KEY (submission_id, question_id)
  ) STRICT;
`;
