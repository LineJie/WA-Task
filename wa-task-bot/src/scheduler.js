import cron from 'node-cron';
import dayjs from 'dayjs';
import {
  getAllActiveTasks, createInstanceIfNotExists, getDueInstances,
  markSent, getOverdueUnescalated, markEscalated,
} from './db.js';

const ESCALATE_AFTER_MINUTES = 30; // follow-up kalau lewat 30 menit belum ✅

// Generate task_instances untuk hari ini dari semua active tasks (recurring + one-off)
function generateTodayInstances() {
  const tasks = getAllActiveTasks();
  const today = dayjs();
  const todayStr = today.format('YYYY-MM-DD');
  const todayDow = today.day(); // 0=Minggu..6=Sabtu

  for (const t of tasks) {
    let shouldRun = false;
    if (t.one_off_date && t.one_off_date === todayStr) {
      shouldRun = true;
    } else if (t.days_of_week) {
      const days = t.days_of_week.split(',').map(Number);
      if (days.includes(todayDow)) shouldRun = true;
    }
    if (!shouldRun) continue;

    const [hh, mm] = t.time.split(':').map(Number);
    const dueAt = today.hour(hh).minute(mm).second(0).format('YYYY-MM-DDTHH:mm:ss');

    createInstanceIfNotExists({
      taskId: t.id,
      orgId: t.org_id,
      personJid: t.person_jid,
      title: t.title,
      dueAt,
    });
  }
}

export function startScheduler(sock, getGroupJidByOrgId) {
  // Generate instance harian jam 00:05
  cron.schedule('5 0 * * *', () => {
    generateTodayInstances();
  });
  // Juga generate sekali pas start, buat jaga-jaga kalau bot baru nyala siang hari
  generateTodayInstances();

  // Cek tiap menit: kirim reminder yang jatuh tempo
  cron.schedule('* * * * *', async () => {
    const now = dayjs().format('YYYY-MM-DDTHH:mm:ss');
    const due = getDueInstances(now);

    for (const inst of due) {
      const groupJid = getGroupJidByOrgId(inst.org_id);
      if (!groupJid) continue;

      try {
        const sent = await sock.sendMessage(groupJid, {
          text: `⏰ *Reminder*\n@${inst.person_jid.split('@')[0]} — ${inst.title}\n\nReact ✅ kalau sudah selesai.`,
          mentions: [inst.person_jid],
        });
        markSent(inst.id, sent.key.id);
      } catch (err) {
        console.error('Gagal kirim reminder:', err.message);
      }
    }

    // Escalation: follow-up kalau lewat threshold belum done
    const threshold = dayjs().subtract(ESCALATE_AFTER_MINUTES, 'minute').format('YYYY-MM-DDTHH:mm:ss');
    const overdue = getOverdueUnescalated(threshold);
    for (const inst of overdue) {
      const groupJid = getGroupJidByOrgId(inst.org_id);
      if (!groupJid) continue;
      try {
        await sock.sendMessage(groupJid, {
          text: `🔴 @${inst.person_jid.split('@')[0]} task "${inst.title}" (jam ${dayjs(inst.due_at).format('HH:mm')}) masih belum di-react ✅. Gimana nih?`,
          mentions: [inst.person_jid],
        });
        markEscalated(inst.id);
      } catch (err) {
        console.error('Gagal kirim escalation:', err.message);
      }
    }
  });
}

export { generateTodayInstances };
