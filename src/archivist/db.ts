import initSqlJs, { type Database } from "sql.js";
import type { CompressedEvent, Connection } from "../shared/types.js";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";

/**
 * SQLite database for storing compressed events and connections.
 * Uses sql.js (pure JS, no native bindings) for maximum portability.
 * Periodically saves the in-memory DB to disk.
 */
export class SynapticDB {
  private db: Database | null = null;
  private dbPath: string;
  private saveInterval: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    const SQL = await initSqlJs();

    // Load existing DB from disk if it exists
    if (existsSync(this.dbPath)) {
      try {
        const buffer = readFileSync(this.dbPath);
        this.db = new SQL.Database(buffer);
        console.log("[Archivist/DB] Loaded existing database");
      } catch {
        console.warn("[Archivist/DB] Could not load existing DB, creating new one");
        this.db = new SQL.Database();
      }
    } else {
      this.db = new SQL.Database();
      console.log("[Archivist/DB] Created new database");
    }

    this.createTables();

    // Auto-save every 30 seconds if dirty
    this.saveInterval = setInterval(() => {
      if (this.dirty) this.saveToDisk();
    }, 30_000);
  }

  private createTables() {
    this.db!.run(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        time TEXT NOT NULL,
        type TEXT NOT NULL,
        project TEXT NOT NULL,
        file TEXT,
        summary TEXT NOT NULL,
        concepts TEXT NOT NULL,
        significance REAL NOT NULL DEFAULT 0.5,
        error_verbatim TEXT,
        resolution TEXT,
        resolves TEXT,
        embedding TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db!.run(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        source_event_id TEXT NOT NULL,
        target_event_id TEXT NOT NULL,
        relationship TEXT NOT NULL,
        confidence REAL NOT NULL,
        discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (source_event_id) REFERENCES events(id),
        FOREIGN KEY (target_event_id) REFERENCES events(id)
      )
    `);

    this.db!.run("CREATE INDEX IF NOT EXISTS idx_events_time ON events(time)");
    this.db!.run("CREATE INDEX IF NOT EXISTS idx_events_project ON events(project)");
    this.db!.run("CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)");
    this.db!.run("CREATE INDEX IF NOT EXISTS idx_events_significance ON events(significance)");
    this.db!.run("CREATE INDEX IF NOT EXISTS idx_connections_source ON connections(source_event_id)");
    this.db!.run("CREATE INDEX IF NOT EXISTS idx_connections_target ON connections(target_event_id)");
  }

  private saveToDisk() {
    if (!this.db) return;
    try {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
      this.dirty = false;
    } catch (error) {
      console.error("[Archivist/DB] Failed to save to disk:", error);
    }
  }

  private query(sql: string, params: any[] = []): any[] {
    const stmt = this.db!.prepare(sql);
    stmt.bind(params);

    const results: any[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push(row);
    }
    stmt.free();
    return results;
  }

  insertEvent(event: CompressedEvent): void {
    this.db!.run(
      `INSERT INTO events (id, time, type, project, file, summary, concepts, significance, error_verbatim, resolution, resolves, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.time,
        event.type,
        event.project,
        event.file,
        event.summary,
        JSON.stringify(event.concepts),
        event.significance,
        event.error_verbatim,
        event.resolution,
        event.resolves,
        event.embedding ? JSON.stringify(event.embedding) : null,
      ]
    );
    this.dirty = true;
  }

  insertConnection(conn: Omit<Connection, "id" | "discovered_at">): void {
    this.db!.run(
      `INSERT INTO connections (id, source_event_id, target_event_id, relationship, confidence)
       VALUES (?, ?, ?, ?, ?)`,
      [randomUUID(), conn.source_event_id, conn.target_event_id, conn.relationship, conn.confidence]
    );
    this.dirty = true;
  }

  getRecentEvents(hours: number = 2): CompressedEvent[] {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const rows = this.query("SELECT * FROM events WHERE time > ? ORDER BY time DESC", [cutoff]);
    return rows.map(this.rowToEvent);
  }

  getEventsByProject(project: string, limit = 50): CompressedEvent[] {
    const rows = this.query("SELECT * FROM events WHERE project = ? ORDER BY time DESC LIMIT ?", [project, limit]);
    return rows.map(this.rowToEvent);
  }

  getHighSignificanceEvents(minSignificance = 0.7, limit = 100): CompressedEvent[] {
    const rows = this.query("SELECT * FROM events WHERE significance >= ? ORDER BY time DESC LIMIT ?", [minSignificance, limit]);
    return rows.map(this.rowToEvent);
  }

  searchByConcept(concept: string, limit = 20): CompressedEvent[] {
    const rows = this.query(
      `SELECT * FROM events WHERE concepts LIKE ? ORDER BY significance DESC, time DESC LIMIT ?`,
      [`%"${concept}"%`, limit]
    );
    return rows.map(this.rowToEvent);
  }

  getAllEventsWithEmbeddings(): CompressedEvent[] {
    const rows = this.query("SELECT * FROM events WHERE embedding IS NOT NULL ORDER BY time DESC");
    return rows.map(this.rowToEvent);
  }

  getUnresolvedErrors(): CompressedEvent[] {
    const rows = this.query(`
      SELECT e.* FROM events e
      WHERE e.type = 'terminal_error'
      AND NOT EXISTS (
        SELECT 1 FROM events r WHERE r.resolves = e.id
      )
      ORDER BY e.time DESC
    `);
    return rows.map(this.rowToEvent);
  }

  getConnectionsForEvent(eventId: string): Connection[] {
    return this.query(
      "SELECT * FROM connections WHERE source_event_id = ? OR target_event_id = ?",
      [eventId, eventId]
    ) as Connection[];
  }

  getStats(): { totalEvents: number; totalConnections: number; projects: string[] } {
    const eventCount = this.query("SELECT COUNT(*) as count FROM events")[0];
    const connCount = this.query("SELECT COUNT(*) as count FROM connections")[0];
    const projects = this.query("SELECT DISTINCT project FROM events");

    return {
      totalEvents: eventCount?.count || 0,
      totalConnections: connCount?.count || 0,
      projects: projects.map((p: any) => p.project),
    };
  }

  getProjectStats(): Array<{
    project: string;
    eventCount: number;
    errorCount: number;
    lastActive: string;
    topConcepts: string[];
  }> {
    const rows = this.query(`
      SELECT
        project,
        COUNT(*) as event_count,
        SUM(CASE WHEN type = 'terminal_error' THEN 1 ELSE 0 END) as error_count,
        MAX(time) as last_active,
        GROUP_CONCAT(concepts, '|||') as all_concepts
      FROM events
      GROUP BY project
      ORDER BY last_active DESC
    `);

    return rows.map((r: any) => {
      const conceptStrings: string[] = r.all_concepts
        ? r.all_concepts.split("|||").filter(Boolean)
        : [];
      const freq = new Map<string, number>();
      conceptStrings.forEach((raw) => {
        try {
          const parsed: string[] = JSON.parse(raw);
          parsed.forEach((c) => freq.set(c, (freq.get(c) || 0) + 1));
        } catch {}
      });
      const topConcepts = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([c]) => c);

      return {
        project: r.project,
        eventCount: r.event_count || 0,
        errorCount: r.error_count || 0,
        lastActive: r.last_active || "",
        topConcepts,
      };
    });
  }

  clearEvents(olderThanDays?: number): void {
    if (olderThanDays !== undefined) {
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
      this.db!.run("DELETE FROM events WHERE time < ?", [cutoff]);
    } else {
      this.db!.run("DELETE FROM events");
    }
    this.dirty = true;
  }

  pruneOldEvents(retentionDays: { low: number; medium: number; high: number }): number {
    const now = Date.now();

    const lowCutoff = new Date(now - retentionDays.low * 24 * 60 * 60 * 1000).toISOString();
    this.db!.run("DELETE FROM events WHERE significance < 0.4 AND time < ?", [lowCutoff]);

    const medCutoff = new Date(now - retentionDays.medium * 24 * 60 * 60 * 1000).toISOString();
    this.db!.run("DELETE FROM events WHERE significance >= 0.4 AND significance < 0.7 AND time < ?", [medCutoff]);

    const highCutoff = new Date(now - retentionDays.high * 24 * 60 * 60 * 1000).toISOString();
    this.db!.run("DELETE FROM events WHERE significance >= 0.7 AND time < ?", [highCutoff]);

    this.dirty = true;
    return this.db!.getRowsModified();
  }

  private rowToEvent(row: any): CompressedEvent {
    return {
      ...row,
      concepts: typeof row.concepts === "string" ? JSON.parse(row.concepts) : row.concepts,
      embedding: row.embedding && typeof row.embedding === "string" ? JSON.parse(row.embedding) : row.embedding || null,
    };
  }

  close() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    this.saveToDisk(); // Final save
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
