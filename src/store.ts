import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Release = {
  id: number;
  tag: string;
  summary: string;
  published: string;
  prerelease: boolean;
};

export type Ban = {
  id: string;
  moderator: string;
  target: string;
  reason: string;
  created: number;
};

export type Job =
  | { kind: "release"; release: Release }
  | {
      kind: "activity";
      event: "issue" | "pull";
      delivery: string;
      number: number;
      title: string;
      author: string;
    }
  | { kind: "welcome"; member: string; joined: number }
  | { kind: "audit"; ban: Ban }
  | { kind: "redirect"; source: string; message: string; thread: string };

type JobRow = {
  id: string;
  payload: string | null;
  status: "pending" | "sent" | "failed";
  attempts: number;
  first_attempt: number | null;
};

type Route = { source: string; created: number; thread: string | null };

export class Store {
  private db: DatabaseSync;

  constructor(directory: string) {
    if (directory !== ":memory:")
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(
      directory === ":memory:" ? directory : join(directory, "benchy.sqlite"),
    );
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        due INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        first_attempt INTEGER,
        result TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, due);
      CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS screening (member TEXT PRIMARY KEY, joined INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS support_routes (
        message TEXT PRIMARY KEY, source TEXT NOT NULL, created INTEGER NOT NULL, thread TEXT
      );
      CREATE TABLE IF NOT EXISTS bans_pending (
        id TEXT PRIMARY KEY, moderator TEXT NOT NULL, target TEXT NOT NULL UNIQUE,
        reason TEXT NOT NULL, created INTEGER NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  enqueue(id: string, job: Job, due = Date.now()) {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO jobs (id, payload, due) VALUES (?, ?, ?)",
        )
        .run(id, JSON.stringify(job), due).changes !== 0
    );
  }

  nextJobs(now = Date.now()) {
    const rows = this.db
      .prepare(
        "SELECT * FROM jobs WHERE status = 'pending' AND due <= ? ORDER BY due, rowid LIMIT 20",
      )
      .all(now) as JobRow[];
    return rows.map((row) => ({
      ...row,
      job: JSON.parse(row.payload!) as Job,
    }));
  }

  startJob(id: string, now = Date.now()) {
    this.db
      .prepare(
        "UPDATE jobs SET first_attempt = COALESCE(first_attempt, ?) WHERE id = ?",
      )
      .run(now, id);
  }

  sent(id: string, result: string) {
    this.db
      .prepare(
        "UPDATE jobs SET status = 'sent', payload = NULL, result = ? WHERE id = ?",
      )
      .run(result, id);
  }

  retry(id: string, result: string, due: number) {
    this.db
      .prepare(
        "UPDATE jobs SET status = 'pending', attempts = attempts + 1, due = ?, result = ? WHERE id = ?",
      )
      .run(due, result, id);
  }

  fail(id: string, result: string) {
    this.db
      .prepare("UPDATE jobs SET status = 'failed', result = ? WHERE id = ?")
      .run(result, id);
  }

  retryFailed(id: string) {
    return (
      this.db
        .prepare(
          "UPDATE jobs SET status = 'pending', attempts = 0, due = ? WHERE id = ? AND status = 'failed'",
        )
        .run(Date.now(), id).changes !== 0
    );
  }

  observeReleases(repository: string, releases: Release[]) {
    return this.transaction(() => {
      const baseline = `release-baseline:${repository.toLowerCase()}`;
      const initialized = Boolean(
        this.db
          .prepare("SELECT value FROM metadata WHERE name = ?")
          .get(baseline),
      );
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO releases (id) VALUES (?)",
      );
      let queued = 0;
      for (const release of releases) {
        const suffix = release.prerelease ? "prerelease" : "stable";
        const key = `release:${repository.toLowerCase()}:${release.id}:${suffix}`;
        const changed = insert.run(key).changes;
        if (!release.prerelease) {
          // A stable release already existed. Ignore a later edit that marks it a prerelease.
          insert.run(
            `release:${repository.toLowerCase()}:${release.id}:prerelease`,
          );
        }
        if (
          changed &&
          initialized &&
          this.enqueue(key, { kind: "release", release })
        )
          queued++;
      }
      if (!initialized)
        this.db
          .prepare("INSERT INTO metadata VALUES (?, ?)")
          .run(baseline, "1");
      return { initialized, queued };
    });
  }

  rememberScreening(member: string, joined: number) {
    this.db
      .prepare(
        `
      INSERT INTO screening VALUES (?, ?) ON CONFLICT(member)
      DO UPDATE SET joined = excluded.joined WHERE excluded.joined > screening.joined
    `,
      )
      .run(member, joined);
  }

  screeningMembers() {
    return this.db.prepare("SELECT * FROM screening").all() as {
      member: string;
      joined: number;
    }[];
  }

  forgetScreening(member: string, joined: number) {
    this.db
      .prepare("DELETE FROM screening WHERE member = ? AND joined = ?")
      .run(member, joined);
  }

  welcome(member: string, joined: number) {
    this.transaction(() => {
      this.enqueue(`welcome:${member}:${joined}`, {
        kind: "welcome",
        member,
        joined,
      });
      this.forgetScreening(member, joined);
    });
  }

  route(message: string) {
    return this.db
      .prepare(
        "SELECT source, created, thread FROM support_routes WHERE message = ?",
      )
      .get(message) as Route | undefined;
  }

  reserveRoute(source: string, message: string) {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO support_routes VALUES (?, ?, ?, NULL)")
        .run(message, source, Date.now()).changes !== 0
    );
  }

  completeRoute(message: string, thread: string) {
    this.transaction(() => {
      const route = this.route(message);
      if (!route || (route.thread && route.thread !== thread))
        throw new Error("Support route changed");
      this.db
        .prepare("UPDATE support_routes SET thread = ? WHERE message = ?")
        .run(thread, message);
      this.enqueue(`redirect:${message}`, {
        kind: "redirect",
        source: route.source,
        message,
        thread,
      });
    });
  }

  clearRoute(message: string) {
    return (
      this.db
        .prepare(
          "DELETE FROM support_routes WHERE message = ? AND thread IS NULL",
        )
        .run(message).changes !== 0
    );
  }

  reserveBan(ban: Ban) {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO bans_pending VALUES (?, ?, ?, ?, ?)")
        .run(ban.id, ban.moderator, ban.target, ban.reason, ban.created)
        .changes !== 0
    );
  }

  pendingBans(before: number) {
    return this.db
      .prepare("SELECT * FROM bans_pending WHERE created <= ?")
      .all(before) as Ban[];
  }

  clearBan(id: string) {
    this.db.prepare("DELETE FROM bans_pending WHERE id = ?").run(id);
  }

  completeBan(ban: Ban) {
    this.transaction(() => {
      this.enqueue(`audit:${ban.id}`, { kind: "audit", ban });
      this.clearBan(ban.id);
    });
  }

  status() {
    return {
      deliveries: this.db
        .prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")
        .all(),
      failed: this.db
        .prepare("SELECT id, result FROM jobs WHERE status = 'failed'")
        .all(),
      pendingSupport: this.db
        .prepare(
          "SELECT message, source, created FROM support_routes WHERE thread IS NULL",
        )
        .all(),
      pendingBans: this.db
        .prepare("SELECT id, target, created FROM bans_pending")
        .all(),
    };
  }
}
