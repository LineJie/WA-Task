// Modul "stok tipis" untuk WA Task Bot.
// Mandiri: punya tabel sendiri (stock_items), tidak mengubah db.js / commands.js.
//
// Pemakaian (sudah disambungkan di bot.js):
//   initStock(db);
//   const reply = handleStockCommand(db, { text, groupId, sender, canResolve });
//   startStockDigest({ db, sock: () => currentSock, buyerNumber });
//
// `sock` boleh berupa objek socket atau fungsi yang mengembalikan socket terbaru,
// supaya rekap tetap terkirim lewat socket yang baru setelah bot reconnect.

import cron from 'node-cron';

export function initStock(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id    TEXT NOT NULL,
      name        TEXT NOT NULL,
      qty         TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL CHECK (status IN ('tipis','abis','beres')),
      reported_by TEXT NOT NULL DEFAULT '',
      reported_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stock_group_status
      ON stock_items (group_id, status);
  `);
}

const normalize = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

// "telur 2 kg" -> { name: 'telur', qty: '2 kg' }
// "minyak goreng" -> { name: 'minyak goreng', qty: '' }
function parseItem(rest) {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const i = tokens.findIndex((t) => /^\d/.test(t));
  if (i === 0) return null; // tidak ada nama barang
  const name = normalize(i === -1 ? tokens.join(' ') : tokens.slice(0, i).join(' '));
  const qty = i === -1 ? '' : tokens.slice(i).join(' ');
  if (!name || name.length > 60) return null;
  return { name, qty };
}

function label(item) {
  return item.qty ? `${item.name} (${item.qty})` : item.name;
}

function reportItem(db, { groupId, sender, status, rest }) {
  const parsed = parseItem(rest);
  if (!parsed) {
    return `Format: /stok ${status} <nama barang> [jumlah]\nContoh: /stok ${status} telur 2 kg`;
  }
  const { name, qty } = parsed;
  const existing = db
    .prepare(
      `SELECT id FROM stock_items
       WHERE group_id = ? AND name = ? AND status IN ('tipis','abis')`
    )
    .get(groupId, name);

  if (existing) {
    db.prepare(
      `UPDATE stock_items
       SET status = ?, qty = ?, reported_by = ?, reported_at = datetime('now')
       WHERE id = ?`
    ).run(status, qty, sender || '', existing.id);
    return `Diperbarui: ${label({ name, qty })} -> ${status} (#${existing.id})`;
  }

  const info = db
    .prepare(
      `INSERT INTO stock_items (group_id, name, qty, status, reported_by)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(groupId, name, qty, status, sender || '');
  return `Tercatat: ${label({ name, qty })} -> ${status} (#${info.lastInsertRowid})`;
}

function listItems(db, groupId) {
  const rows = db
    .prepare(
      `SELECT id, name, qty, status FROM stock_items
       WHERE group_id = ? AND status IN ('tipis','abis')
       ORDER BY CASE status WHEN 'abis' THEN 0 ELSE 1 END, name`
    )
    .all(groupId);
  if (rows.length === 0) return 'Tidak ada stok yang tipis. Aman.';
  return formatRows(rows);
}

function formatRows(rows) {
  const abis = rows.filter((r) => r.status === 'abis');
  const tipis = rows.filter((r) => r.status === 'tipis');
  const lines = [];
  if (abis.length) {
    lines.push('*ABIS*');
    abis.forEach((r) => lines.push(`#${r.id} ${label(r)}`));
  }
  if (tipis.length) {
    if (lines.length) lines.push('');
    lines.push('*TIPIS*');
    tipis.forEach((r) => lines.push(`#${r.id} ${label(r)}`));
  }
  return lines.join('\n');
}

function resolveItem(db, { groupId, rest, canResolve }) {
  if (!canResolve) {
    return 'Yang bisa menandai beres hanya yang belanja atau admin grup.';
  }
  const arg = rest.trim();
  if (!arg) return 'Format: /stok beres <nama barang atau nomor>\nContoh: /stok beres telur';

  let row;
  if (/^#?\d+$/.test(arg)) {
    row = db
      .prepare(
        `SELECT id, name, qty FROM stock_items
         WHERE id = ? AND group_id = ? AND status IN ('tipis','abis')`
      )
      .get(Number(arg.replace('#', '')), groupId);
  } else {
    const name = normalize(arg);
    row =
      db
        .prepare(
          `SELECT id, name, qty FROM stock_items
           WHERE group_id = ? AND name = ? AND status IN ('tipis','abis')`
        )
        .get(groupId, name) ||
      db
        .prepare(
          `SELECT id, name, qty FROM stock_items
           WHERE group_id = ? AND name LIKE ? ESCAPE '\\' AND status IN ('tipis','abis')
           ORDER BY name LIMIT 1`
        )
        .get(groupId, `%${name.replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (!row) return `Tidak ketemu barang "${arg}" di daftar tipis. Cek /stok list.`;

  db.prepare(
    `UPDATE stock_items SET status = 'beres', resolved_at = datetime('now') WHERE id = ?`
  ).run(row.id);
  return `Beres: ${label(row)} sudah dibeli.`;
}

const HELP = [
  '*Perintah stok*',
  '/stok tipis <barang> [jumlah]  - lapor stok hampir habis',
  '/stok abis <barang>  - lapor stok sudah habis',
  '/stok list  - lihat daftar yang tipis/abis',
  '/stok beres <barang atau #nomor>  - tandai sudah dibeli (khusus yang belanja/admin)',
  '',
  'Contoh: /stok tipis telur 2 kg',
].join('\n');

// Mengembalikan string balasan, atau null kalau pesan bukan perintah /stok.
//   ctx = { text, groupId, sender, canResolve }
export function handleStockCommand(db, ctx) {
  const text = (ctx.text || '').trim();
  const m = text.match(/^\/stok(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;

  const sub = (m[1] || 'help').toLowerCase();
  const rest = m[2] || '';

  switch (sub) {
    case 'tipis':
    case 'abis':
      return reportItem(db, { groupId: ctx.groupId, sender: ctx.sender, status: sub, rest });
    case 'list':
      return listItems(db, ctx.groupId);
    case 'beres':
      return resolveItem(db, { groupId: ctx.groupId, rest, canResolve: !!ctx.canResolve });
    default:
      return HELP;
  }
}

// Teks rekap untuk satu grup, atau null kalau tidak ada yang tipis.
export function buildDigest(db, groupId, buyerNumber) {
  const rows = db
    .prepare(
      `SELECT id, name, qty, status FROM stock_items
       WHERE group_id = ? AND status IN ('tipis','abis')
       ORDER BY CASE status WHEN 'abis' THEN 0 ELSE 1 END, name`
    )
    .all(groupId);
  if (rows.length === 0) return null;
  const tag = buyerNumber ? ` @${buyerNumber}` : '';
  return `*Rekap stok pagi*${tag}\n\n${formatRows(rows)}\n\nSetelah dibeli: /stok beres <barang>`;
}

// Kirim rekap tiap pagi ke semua grup yang punya stok tipis.
export function startStockDigest({
  db,
  sock,
  buyerNumber,
  schedule = '0 8 * * *', // jam 08:00
  timezone = 'Asia/Jakarta',
  logger = console,
}) {
  const getSock = typeof sock === 'function' ? sock : () => sock;
  return cron.schedule(
    schedule,
    async () => {
      const groups = db
        .prepare(
          `SELECT DISTINCT group_id FROM stock_items WHERE status IN ('tipis','abis')`
        )
        .all();
      for (const { group_id } of groups) {
        const text = buildDigest(db, group_id, buyerNumber);
        if (!text) continue;
        try {
          await getSock().sendMessage(group_id, {
            text,
            mentions: buyerNumber ? [`${buyerNumber}@s.whatsapp.net`] : [],
          });
        } catch (err) {
          logger.error?.({ err, group_id }, 'gagal kirim rekap stok');
        }
      }
    },
    { timezone }
  );
}
