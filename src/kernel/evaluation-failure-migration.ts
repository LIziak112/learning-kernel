export const evaluationFailureMigration = `
  CREATE TABLE evaluation_tasks_replacement (
    submission_id TEXT PRIMARY KEY REFERENCES submissions (id),
    key_id TEXT NOT NULL,
    key_version INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT CHECK (last_error IS NULL OR length(last_error) > 0),
    CHECK (status <> 'failed' OR last_error IS NOT NULL),
    FOREIGN KEY (key_id, key_version) REFERENCES scoring_keys (id, version)
  ) STRICT;
  INSERT INTO evaluation_tasks_replacement (submission_id, key_id, key_version, target_id, status)
    SELECT submission_id, key_id, key_version, target_id, status FROM evaluation_tasks;
  DROP TABLE evaluation_tasks;
  ALTER TABLE evaluation_tasks_replacement RENAME TO evaluation_tasks;
`;
