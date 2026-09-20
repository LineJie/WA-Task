import dayjs from 'dayjs';
import {
  insertTask, listActiveTasks, deactivateTask, upsertOrg,
} from './db.js';

const DAY_MAP = {
  minggu: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, sabtu: 6,
};
const DAY_ORDER = ['minggu', 'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu'];

// Parse "senin-jumat" / "senin,rabu,jumat" / "setiap-hari" -> "1,2,3,4,5"
function parseDays(token) {
  const t = token.toLowerCase();
  if (t === 'setiap-hari' || t === 'harian') {
    return '0,1,2,3,4,5,6';
  }
  if (t.includes('-')) {
    const [start, end] = t.split('-');
    const si = DAY_ORDER.indexOf(start);
    const ei = DAY_ORDER.indexOf(end);
    if (si === -1 || ei === -1) return null;
    const days = [];
    let i = si;
    while (true) {
      days.push(i);
      if (i === ei) break;
      i = (i + 1) % 7;
    }
    return days.join(',');
  }
  if (t.includes(',')) {
    const days = t.split(',').map((d) => DAY_MAP[d.trim()]).filter((d) => d !== undefined);
    return days.length ? days.join(',') : null;
  }
  if (DAY_MAP[t] !== undefined) return String(DAY_MAP[t]);
  return null;
}

/**
 * Format command:
 *   /task besok 10:00 upload IG story
 *   /task senin-jumat 19:00 tutup kasir
 *   /task 25/09 14:00 meeting supplier
 * Person didapat dari mentionedJid (tag @orang di pesan yang sama)
 */
export function parseTaskCommand(text, mentionedJids) {
  const parts = text.trim().split(/\s+/);
  if (parts[0].toLowerCase() !== '/task') return { error: 'not_task_command' };
  if (parts.length < 4) {
    return { error: 'format', message: 'Format: /task <hari/tanggal> <jam> <judul task> @orang' };
  }

  const dateToken = parts[1].toLowerCase();
  const timeToken = parts[2];
  const titleParts = parts.slice(3);
  const title = titleParts.join(' ').replace(/@\d+/g, '').trim();

  if (!/^\d{1,2}:\d{2}$/.test(timeToken)) {
    return { error: 'format', message: 'Format jam harus HH:MM, contoh 19:00' };
  }

  if (!mentionedJids || mentionedJids.length === 0) {
    return { error: 'format', message: 'Tag orang yang di-assign, contoh @628123456789' };
  }
  const personJid = mentionedJids[0];

  let daysOfWeek = null;
  let oneOffDate = null;

  if (dateToken === 'hari-ini' || dateToken === 'hariini') {
    oneOffDate = dayjs().format('YYYY-MM-DD');
  } else if (dateToken === 'besok') {
    oneOffDate = dayjs().add(1, 'day').format('YYYY-MM-DD');
  } else if (/^\d{1,2}\/\d{1,2}$/.test(dateToken)) {
    const [d, m] = dateToken.split('/');
    const year = dayjs().year();
    oneOffDate = dayjs(`${year}-${m}-${d}`, 'YYYY-M-D').format('YYYY-MM-DD');
  } else {
    const parsedDays = parseDays(dateToken);
    if (!parsedDays) {
      return {
        error: 'format',
        message: 'Hari tidak dikenali. Pakai: besok, hari-ini, tanggal (25/09), nama-hari (senin), rentang (senin-jumat), atau setiap-hari',
      };
    }
    daysOfWeek = parsedDays;
  }

  if (!title) {
    return { error: 'format', message: 'Judul task tidak boleh kosong' };
  }

  return { title, personJid, time: timeToken, daysOfWeek, oneOffDate };
}

export function handleTaskCommand({ text, mentionedJids, orgId, createdBy }) {
  const parsed = parseTaskCommand(text, mentionedJids);
  if (parsed.error === 'not_task_command') return null;
  if (parsed.error) return `⚠️ ${parsed.message}`;

  const taskId = insertTask({
    orgId,
    title: parsed.title,
    personJid: parsed.personJid,
    time: parsed.time,
    daysOfWeek: parsed.daysOfWeek,
    oneOffDate: parsed.oneOffDate,
    createdBy,
  });

  const scheduleDesc = parsed.oneOffDate
    ? `tanggal ${parsed.oneOffDate}`
    : `setiap ${parsed.daysOfWeek.split(',').map((d) => DAY_ORDER[Number(d)]).join('/')}`;

  return `✅ Task #${taskId} tersimpan: "${parsed.title}" jam ${parsed.time} (${scheduleDesc})`;
}

export function handleListCommand(orgId) {
  const tasks = listActiveTasks(orgId);
  if (tasks.length === 0) return 'Belum ada task aktif.';
  const lines = tasks.map((t) => {
    const sched = t.one_off_date
      ? t.one_off_date
      : t.days_of_week.split(',').map((d) => DAY_ORDER[Number(d)]).join('/');
    return `#${t.id} — ${t.time} (${sched}) — ${t.title} → @${t.person_jid.split('@')[0]}`;
  });
  return `📋 Task aktif:\n${lines.join('\n')}`;
}

export function handleCancelCommand(text, orgId) {
  const parts = text.trim().split(/\s+/);
  const id = Number(parts[1]);
  if (!id) return '⚠️ Format: /cancel <id_task>';
  const info = deactivateTask(id, orgId);
  return info.changes > 0 ? `🗑️ Task #${id} dibatalkan.` : `Task #${id} tidak ditemukan.`;
}

export function ensureOrg(groupJid, groupName) {
  return upsertOrg(groupJid, groupName);
}
