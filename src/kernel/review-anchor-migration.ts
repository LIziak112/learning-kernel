export const reviewAnchorMigration = `
  CREATE TABLE verdict_events_replacement (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL REFERENCES activities (id),
    submission_id TEXT NOT NULL REFERENCES submissions (id),
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
  INSERT INTO verdict_events_replacement SELECT
    id, activity_id, submission_id, target_id, question_id, revision, reviewer_id, operation_id, reason, reviewed_at, action, correct, withdraw_id
    FROM verdict_events;
  DROP TABLE verdict_events;
  ALTER TABLE verdict_events_replacement RENAME TO verdict_events;

  CREATE TABLE response_review_requirements_replacement (
    submission_id TEXT NOT NULL REFERENCES submissions (id),
    question_id TEXT NOT NULL,
    PRIMARY KEY (submission_id, question_id)
  ) STRICT;
  INSERT INTO response_review_requirements_replacement SELECT submission_id, question_id FROM response_review_requirements;
  DROP TABLE response_review_requirements;
  ALTER TABLE response_review_requirements_replacement RENAME TO response_review_requirements;

  DELETE FROM evaluation_tasks WHERE key_id IS NULL;
  CREATE TABLE evaluation_tasks_replacement (
    submission_id TEXT PRIMARY KEY REFERENCES submissions (id),
    key_id TEXT NOT NULL,
    key_version INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
    FOREIGN KEY (key_id, key_version) REFERENCES scoring_keys (id, version)
  ) STRICT;
  INSERT INTO evaluation_tasks_replacement SELECT submission_id, key_id, key_version, target_id, status FROM evaluation_tasks;
  DROP TABLE evaluation_tasks;
  ALTER TABLE evaluation_tasks_replacement RENAME TO evaluation_tasks;
`;
