export const questionPublicationMigration = `
  CREATE TABLE practices_with_optional_material (
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    material_id TEXT,
    material_version INTEGER,
    definition TEXT NOT NULL,
    PRIMARY KEY (id, version),
    CHECK ((material_id IS NULL) = (material_version IS NULL)),
    FOREIGN KEY (material_id, material_version) REFERENCES materials (id, version)
  ) STRICT;
  INSERT INTO practices_with_optional_material (id, version, material_id, material_version, definition)
    SELECT id, version, material_id, material_version, definition FROM practices;
  DROP TABLE practices;
  ALTER TABLE practices_with_optional_material RENAME TO practices;
`;
