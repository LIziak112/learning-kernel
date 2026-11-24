export const selfAssessmentMigration = `
  CREATE TABLE self_assessment_events (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL REFERENCES activities (id),
    submission_id TEXT NOT NULL REFERENCES submissions (id),
    question_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    operation_id TEXT NOT NULL,
    verdict TEXT CHECK (verdict IN ('correct', 'wrong')),
    rubric TEXT CHECK (rubric IS NULL OR (json_valid(rubric) AND json_type(rubric) = 'object')),
    assessed_at TEXT NOT NULL,
    UNIQUE (activity_id, operation_id),
    UNIQUE (submission_id, question_id, revision)
  ) STRICT;
`;
