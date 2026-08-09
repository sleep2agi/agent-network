// #434: real-server integration tests must know their DB before importing
// auth/db/server modules. Setting COMMHUB_DB in beforeAll is too late because
// ESM dependencies have already evaluated the db singleton.
if (!process.env.COMMHUB_DB) {
  throw new Error(
    "explicit_test_database_required: run `cd server && bun run test`, " +
    "or set COMMHUB_DB to an isolated temporary path before running this file",
  );
}
