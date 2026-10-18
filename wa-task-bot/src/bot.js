import baileys from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import dayjs from 'dayjs';

import db, {
  getOrgByGroup, markDoneByMessageId, findInstanceByMessageId, listAllOrgs,
} from './db.js';
import {
  handleTaskCommand, handleListCommand, handleCancelCommand, ensureOrg,
} from './commands.js';
import { startScheduler } from './scheduler.js';
import { initStock, handleStockCommand, startStockDigest } from './stock.js';

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

const orgCache = new Map(); // org_id -> group_jid, buat scheduler

// ── Fitur stok tipis ──────────────────────────────────────
// Nomor WA orang yang belanja (format 628xxx). Diisi lewat environment variable,
// bukan ditulis di kode, karena repo ini public:
//   STOK_PEMBELI=628123456789 npm start
const BUYER_NUMBER = (process.env.STOK_PEMBELI || '').replace(/\D/g, '');
initStock(db);
let currentSock = null; // socket terbaru, dipakai rekap pagi setelah reconnect
let stockDigestStarted = false;

async function isSenderAdmin(sock, groupJid, senderJid) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const participant = meta.participants.find((p) => p.id === senderJid);
    return participant?.admin === 'admin' || participant?.admin === 'superadmin';
  } catch {
    return false;
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });
  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('Scan QR ini pake nomor WA khusus bot:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus, reconnect:', shouldReconnect);
      if (shouldReconnect) start();
    } else if (connection === 'open') {
      console.log('✅ Bot terkoneksi.');
      // Preload semua org yang udah pernah kedaftar, biar scheduler bisa kirim
      // reminder walau belum ada command baru masuk setelah restart.
      for (const org of listAllOrgs()) {
        orgCache.set(org.id, org.group_jid);
      }
    }
  });

  // ── Handle pesan masuk (command) ──────────────────────────
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid;
    if (!remoteJid.endsWith('@g.us')) return; // cuma proses pesan dari grup

    const text = msg.message.conversation
      || msg.message.extendedTextMessage?.text
      || '';
    if (!text.startsWith('/')) return;

    const senderJid = msg.key.participant || msg.participant;

    // /stok boleh dipakai semua member grup (staf lapor stok), jadi diproses
    // sebelum cek admin. Hanya "/stok beres" yang dibatasi: pembeli atau admin grup.
    if (/^\/stok(\s|$)/i.test(text)) {
      const senderNumber = (senderJid || '').split('@')[0].split(':')[0];
      let canResolve = false;
      if (/^\/stok\s+beres(\s|$)/i.test(text)) {
        canResolve = (BUYER_NUMBER !== '' && senderNumber === BUYER_NUMBER)
          || await isSenderAdmin(sock, remoteJid, senderJid);
      }
      const stokReply = handleStockCommand(db, {
        text, groupId: remoteJid, sender: senderNumber, canResolve,
      });
      if (stokReply) {
        await sock.sendMessage(remoteJid, { text: stokReply }, { quoted: msg });
      }
      return;
    }

    const admin = await isSenderAdmin(sock, remoteJid, senderJid);
    if (!admin) {
      await sock.sendMessage(remoteJid, { text: '⛔ Cuma admin grup yang bisa pakai command ini.' }, { quoted: msg });
      return;
    }

    // Register org kalau belum ada
    const groupMeta = await sock.groupMetadata(remoteJid);
    let org = getOrgByGroup(remoteJid);
    if (!org) {
      org = ensureOrg(remoteJid, groupMeta.subject);
    }
    orgCache.set(org.id, remoteJid);

    const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    let reply = null;

    if (text.startsWith('/task')) {
      reply = handleTaskCommand({ text, mentionedJids, orgId: org.id, createdBy: senderJid });
    } else if (text.startsWith('/list')) {
      reply = handleListCommand(org.id);
    } else if (text.startsWith('/cancel')) {
      reply = handleCancelCommand(text, org.id);
    } else if (text.startsWith('/help')) {
      reply = [
        '*Command yang tersedia:*',
        '/task besok 10:00 upload IG story @orang',
        '/task senin-jumat 19:00 tutup kasir @orang',
        '/task 25/09 14:00 meeting supplier @orang',
        '/list — lihat task aktif',
        '/cancel <id> — batalkan task',
        '',
        '*Stok tipis (semua member):*',
        '/stok tipis telur 2 kg — lapor stok hampir habis',
        '/stok abis minyak goreng — lapor stok habis',
        '/stok list — lihat daftar stok tipis',
        '/stok beres telur — tandai sudah dibeli (pembeli/admin)',
      ].join('\n');
    }

    if (reply) {
      await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
    }
  });

  // ── Handle reaction (mark task done) ──────────────────────
  sock.ev.on('messages.reaction', async (reactions) => {
    for (const r of reactions) {
      const emoji = r.reaction?.text;
      if (emoji !== '✅') continue;

      const messageId = r.reaction?.key?.id;
      if (!messageId) continue;

      const inst = findInstanceByMessageId(messageId);
      if (!inst || inst.status === 'done') continue;

      markDoneByMessageId(messageId, dayjs().format('YYYY-MM-DDTHH:mm:ss'));

      const groupJid = orgCache.get(inst.org_id);
      if (groupJid) {
        await sock.sendMessage(groupJid, {
          text: `✅ "${inst.title}" ditandai selesai oleh @${inst.person_jid.split('@')[0]}.`,
          mentions: [inst.person_jid],
        });
      }
    }
  });

  // ── Scheduler ──────────────────────────────────────────────
  startScheduler(sock, (orgId) => orgCache.get(orgId));

  // Rekap stok pagi: didaftarkan sekali saja (start() dipanggil ulang tiap reconnect)
  if (!stockDigestStarted) {
    stockDigestStarted = true;
    startStockDigest({ db, sock: () => currentSock, buyerNumber: BUYER_NUMBER });
  }
}

start();
