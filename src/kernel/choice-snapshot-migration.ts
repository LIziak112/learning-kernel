export const choiceSnapshotMigration = `
  CREATE TABLE choice_snapshot_revisions (
    step_attempt_id TEXT NOT NULL REFERENCES step_attempts (id),
    slot_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    previous_question_version INTEGER NOT NULL,
    question_version INTEGER NOT NULL CHECK (question_version = previous_question_version + 1),
    content TEXT NOT NULL,
    reviewer_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    revised_at TEXT NOT NULL,
    PRIMARY KEY (step_attempt_id, slot_id, question_id, revision),
    UNIQUE (step_attempt_id, slot_id, question_id, question_version),
    UNIQUE (step_attempt_id, slot_id, question_id, reviewer_id, operation_id)
  ) STRICT;
`;
