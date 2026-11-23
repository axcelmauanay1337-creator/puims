// Preload: point migration tooling at the test database.
process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_DATABASE_URL;
