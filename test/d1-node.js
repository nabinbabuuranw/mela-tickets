// D1-compatible shim over node:sqlite, used only by the tests.
// batch() runs every statement synchronously inside one BEGIN IMMEDIATE ... COMMIT, the same
// all-or-nothing behaviour D1 gives a batch, so concurrent requests cannot interleave inside it.
import { DatabaseSync } from "node:sqlite";

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  class Stmt {
    constructor(sql, args) { this.sql = sql; this.args = args; }
    bind(...args) { return new Stmt(this.sql, args); }
    async first() { return db.prepare(this.sql).get(...this.args) ?? null; }
    async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
    async run() {
      const r = db.prepare(this.sql).run(...this.args);
      return { meta: { changes: Number(r.changes) }, success: true };
    }
    _runSync() {
      const r = db.prepare(this.sql).run(...this.args);
      return { meta: { changes: Number(r.changes) }, success: true };
    }
  }
  return {
    prepare: (sql) => new Stmt(sql, []),
    async batch(stmts) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = stmts.map((s) => s._runSync());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    raw: db,
  };
}
