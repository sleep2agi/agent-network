import { isAbsolute, join, resolve } from "path";

const DB_PATH_ENV = "ANET_BOOTSTRAP_DB_PATH";
const USER_ID_ENV = "ANET_BOOTSTRAP_USER_ID";

export interface BootstrapPasswordUpdateInvocation {
  argv: string[];
  env: NodeJS.ProcessEnv;
  script: string;
}

/**
 * Resolve the database selected for the local Hub into an explicit absolute
 * path before launching the bootstrap helper. The helper must never infer a
 * database from its own HOME/cwd: those can differ from the parent process.
 */
export function resolveBootstrapDatabasePath(
  env: NodeJS.ProcessEnv,
  home: string,
  cwd: string,
): string {
  if (/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL || "")) {
    throw new Error("[anet] REFUSING SQLite bootstrap update for a PostgreSQL Hub");
  }
  const configured = env.COMMHUB_DB;
  if (configured?.includes("\0")) {
    throw new Error("[anet] REFUSING bootstrap database path containing NUL");
  }
  if (configured) {
    if (!isAbsolute(cwd)) {
      throw new Error("[anet] REFUSING to resolve bootstrap database from a non-absolute cwd");
    }
    return isAbsolute(configured) ? resolve(configured) : resolve(cwd, configured);
  }
  if (!isAbsolute(home) || home.includes("\0")) {
    throw new Error("[anet] REFUSING bootstrap database default without an absolute HOME");
  }
  return join(home, ".commhub", "commhub.db");
}

export const BOOTSTRAP_PASSWORD_UPDATE_SCRIPT = String.raw`
import { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";

const dbPath = process.env.ANET_BOOTSTRAP_DB_PATH;
const userId = process.env.ANET_BOOTSTRAP_USER_ID;
if (!dbPath || !isAbsolute(dbPath) || dbPath.includes("\0")) {
  throw new Error("REFUSING bootstrap update without an explicit absolute database path");
}
if (!userId || userId.includes("\0")) {
  throw new Error("REFUSING bootstrap update without a valid user id");
}

const db = new Database(dbPath);
try {
  db.query("UPDATE users SET must_change_password = 1 WHERE user_id = ?1").run(userId);
} finally {
  db.close();
}
`;

export function buildBootstrapPasswordUpdateInvocation(
  userId: string,
  dbPath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): BootstrapPasswordUpdateInvocation {
  if (!dbPath || !isAbsolute(dbPath) || dbPath.includes("\0")) {
    throw new Error("[anet] REFUSING bootstrap update without an explicit absolute database path");
  }
  if (!userId || userId.includes("\0")) {
    throw new Error("[anet] REFUSING bootstrap update without a valid user id");
  }
  return {
    argv: ["bun", "-e", BOOTSTRAP_PASSWORD_UPDATE_SCRIPT],
    env: {
      ...baseEnv,
      [DB_PATH_ENV]: dbPath,
      [USER_ID_ENV]: userId,
    },
    script: BOOTSTRAP_PASSWORD_UPDATE_SCRIPT,
  };
}
