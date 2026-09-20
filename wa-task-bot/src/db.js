import Database from 'better-sqlite3';

const db = new Database('wa-task-bot.db');
db.pragma('journal_mode = WAL');

// ── Schema ────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_jid TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  person_jid TEXT NOT NULL,
  time TEXT NOT NULL,           -- 'HH:MM'
  days_of_week TEXT,            -- '1,2,3,4,5' (0=Minggu..6=Sabtu), NULL kalau one-off
  one_off_date TEXT,            -- 'YYYY-MM-DD', NULL kalau recurring
  active INTEGER DEFAULT 1,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  person_jid TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at TEXT NOT NULL,         -- ISO datetime
  status TEXT DEFAULT 'pending', -- pending | done | missed
  message_id TEXT,
  done_at TEXT,
  escalated INTEGER DEFAULT 0,
  UNIQUE(task_id, due_at)
);
`);

// ── Orgs ──────────────────────────────────────────────────
export function getOrgByGroup(groupJid) {
  return db.prepare('SELECT * FROM orgs WHERE group_jid = ?').get(groupJid);
}

export function listAllOrgs() {
  return db.prepare('SELECT * FROM orgs').all();
}

export function upsertOrg(groupJid, name) {
  const existing = getOrgByGroup(groupJid);
  if (existing) return existing;
  const info = db.prepare('INSERT INTO orgs (group_jid, name) VALUES (?, ?)').run(groupJid, name);
  return { id: info.lastInsertRowid, group_jid: groupJid, name };
}

// ── Tasks ─────────────────────────────────────────────────
export function insertTask({ orgId, title, personJid, time, daysOfWeek, oneOffDate, createdBy }) {
  const info = db.prepare(`
    INSERT INTO tasks (org_id, title, person_jid, time, days_of_week, one_off_date, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(orgId, title, personJid, time, daysOfWeek, oneOffDate, createdBy);
  return info.lastInsertRowid;
}

export function listActiveTasks(orgId) {
  return db.prepare('SELECT * FROM tasks WHERE org_id = ? AND active = 1 ORDER BY time').all(orgId);
}

export function deactivateTask(taskId, orgId) {
  return db.prepare('UPDATE tasks SET active = 0 WHERE id = ? AND org_id = ?').run(taskId, orgId);
}

export function getAllActiveTasks() {
  return db.prepare('SELECT * FROM tasks WHERE active = 1').all();
}

// ── Task instances ────────────────────────────────────────
export function createInstanceIfNotExists({ taskId, orgId, personJid, title, dueAt }) {
  try {
    const info = db.prepare(`
      INSERT INTO task_instances (task_id, org_id, person_jid, title, due_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, orgId, personJid, title, dueAt);
    return info.lastInsertRowid;
  } catch (e) {
    // UNIQUE constraint = instance hari itu udah ada, skip
    return null;
  }
}

export function getDueInstances(nowIso) {
  return db.prepare(`
    SELECT * FROM task_instances WHERE status = 'pending' AND due_at <= ? AND message_id IS NULL
  `).all(nowIso);
}

export function getOverdueUnescalated(thresholdIso) {
  return db.prepare(`
    SELECT * FROM task_instances
    WHERE status = 'pending' AND message_id IS NOT NULL AND escalated = 0 AND due_at <= ?
  `).all(thresholdIso);
}

export function markSent(instanceId, messageId) {
  db.prepare('UPDATE task_instances SET message_id = ? WHERE id = ?').run(messageId, instanceId);
}

export function markEscalated(instanceId) {
  db.prepare('UPDATE task_instances SET escalated = 1 WHERE id = ?').run(instanceId);
}

export function markDoneByMessageId(messageId, doneAtIso) {
  return db.prepare(`
    UPDATE task_instances SET status = 'done', done_at = ? WHERE message_id = ? AND status = 'pending'
  `).run(doneAtIso, messageId);
}

export function findInstanceByMessageId(messageId) {
  return db.prepare('SELECT * FROM task_instances WHERE message_id = ?').get(messageId);
}

export function listPendingForOrg(orgId) {
  return db.prepare(`
    SELECT * FROM task_instances WHERE org_id = ? AND status = 'pending' ORDER BY due_at
  `).all(orgId);
}

export default db;
