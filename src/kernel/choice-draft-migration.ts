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
