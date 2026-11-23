export const readingMigration = `
  CREATE TABLE materials (
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    definition TEXT NOT NULL,
    PRIMARY KEY (id, version)
  ) STRICT;
  CREATE TABLE practices (
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    material_id TEXT NOT NULL,
    material_version INTEGER NOT NULL,
    definition TEXT NOT NULL,
    PRIMARY KEY (id, version),
    FOREIGN KEY (material_id, material_version) REFERENCES materials (id, version)
  ) STRICT;
  CREATE TABLE activities (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    practice_id TEXT NOT NULL,
    practice_version INTEGER NOT NULL,
    start_operation_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    UNIQUE (student_id, start_operation_id),
    FOREIGN KEY (practice_id, practice_version) REFERENCES practices (id, version)
  ) STRICT;
  CREATE TABLE step_attempts (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL REFERENCES activities (id),
    step_id TEXT NOT NULL,
    UNIQUE (activity_id, step_id)
  ) STRICT;
  CREATE TABLE works (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL REFERENCES activities (id)
  ) STRICT;
  CREATE TABLE work_versions (
    work_id TEXT NOT NULL REFERENCES works (id),
    version INTEGER NOT NULL CHECK (version > 0),
    selection TEXT NOT NULL,
    PRIMARY KEY (work_id, version)
  ) STRICT;
  CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    step_attempt_id TEXT NOT NULL REFERENCES step_attempts (id),
    slot_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    work_id TEXT NOT NULL,
    work_version INTEGER NOT NULL,
    confirmed_at TEXT NOT NULL,
    UNIQUE (step_attempt_id, slot_id),
    UNIQUE (step_attempt_id, operation_id),
    FOREIGN KEY (work_id, work_version) REFERENCES work_versions (work_id, version)
  ) STRICT;
  CREATE TABLE performances (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL REFERENCES submissions (id),
    target_id TEXT NOT NULL,
    UNIQUE (submission_id, target_id)
  ) STRICT;
  CREATE TABLE completions (
    activity_id TEXT PRIMARY KEY REFERENCES activities (id),
    submission_id TEXT NOT NULL UNIQUE REFERENCES submissions (id)
  ) STRICT;
`;
