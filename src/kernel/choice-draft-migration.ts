export const choiceDraftMigration = `
  ALTER TABLE works ADD COLUMN question_id TEXT CHECK (question_id IS NULL OR step_attempt_id IS NOT NULL);

  CREATE UNIQUE INDEX choice_work_per_question ON works (step_attempt_id, slot_id, question_id)
    WHERE question_id IS NOT NULL;

  CREATE TABLE choice_draft_operations (
    work_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
    revision INTEGER NOT NULL,
    PRIMARY KEY (work_id, operation_id),
    FOREIGN KEY (work_id, revision) REFERENCES work_versions (work_id, version)
  ) STRICT;
`;

export const currentChoiceDraftMigration = `
  CREATE TABLE choice_draft_latest_operations (
    work_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    FOREIGN KEY (work_id, operation_id) REFERENCES choice_draft_operations (work_id, operation_id)
  ) STRICT;

  INSERT INTO choice_draft_latest_operations (work_id, operation_id)
  SELECT o.work_id, MIN(o.operation_id)
  FROM choice_draft_operations o
  WHERE NOT EXISTS (
    SELECT 1 FROM work_versions v WHERE v.work_id = o.work_id AND v.version > o.revision
  )
  GROUP BY o.work_id HAVING COUNT(*) = 1;
`;
