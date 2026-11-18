export const verdictMigration = `
  ALTER TABLE automatic_verdicts ADD COLUMN valid INTEGER NOT NULL DEFAULT 1 CHECK (valid IN (0, 1));

  CREATE TABLE verdict_events (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL REFERENCES activities (id),
    submission_id TEXT NOT NULL REFERENCES evaluation_tasks (submission_id),
    target_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    reviewer_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (length(reason) > 0),
    reviewed_at TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('override', 'withdraw')),
    correct INTEGER CHECK (correct IN (0, 1)),
    withdraw_id TEXT REFERENCES verdict_events (id),
    CHECK (
      (action = 'override' AND correct IS NOT NULL AND withdraw_id IS NULL)
      OR (action = 'withdraw' AND correct IS NULL AND withdraw_id IS NOT NULL)
    ),
    UNIQUE (activity_id, reviewer_id, operation_id),
    UNIQUE (submission_id, target_id, question_id, revision),
    UNIQUE (withdraw_id)
  ) STRICT;
`;
