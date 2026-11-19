export const choiceAmendmentMigration = `
  CREATE TABLE choice_draft_amendments (
    work_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    reviewer_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    amended_at TEXT NOT NULL,
    PRIMARY KEY (work_id, revision),
    UNIQUE (work_id, reviewer_id, operation_id),
    FOREIGN KEY (work_id, revision) REFERENCES work_versions (work_id, version)
  ) STRICT;
`;
