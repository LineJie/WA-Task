# WA Task Bot — Internal Reminder Bot

Bot WhatsApp internal buat reminder task per org (Pung Pung Mahjong, Wonderlab, Food Business),
lewat WA group masing-masing bisnis. Cuma admin grup yang bisa nambah/hapus task.

## 1. Persiapan

- Nomor WA baru khusus bot (jangan pakai nomor pribadi — lihat penjelasan risiko di chat)
- Server/VPS kecil yang nyala 24/7 (misal 1GB RAM juga cukup) — Node.js 18+
- Install WA di HP/emulator pakai nomor baru itu dulu (buat scan QR sekali di awal)

## 2. Install

```bash
cd wa-task-bot
npm install
```

## 3. Jalankan pertama kali (scan QR)

```bash
npm start
```

Terminal bakal nampilin QR code. Di HP dengan nomor bot: **WhatsApp → Perangkat Tertaut → Tautkan Perangkat** → scan QR itu.

Setelah konek, sesi tersimpan di folder `auth_session/` — **jangan dihapus**, ini yang bikin bot gak perlu scan ulang tiap restart. Backup folder ini secara berkala.

## 4. Invite bot ke grup

Invite nomor bot sebagai **member biasa** (gak perlu admin) ke 3 grup:
- Grup Pung Pung Mahjong
- Grup Wonderlab
- Grup Food Business

Org otomatis kedaftar begitu ada admin grup yang pertama kali kirim command (`/task`, `/list`, dll) di grup itu — nama org diambil dari nama grup WA-nya.

## 5. Cara pakai (di dalam grup, khusus admin grup)

```
/task besok 10:00 upload IG story @628123456789
/task senin-jumat 19:00 tutup kasir @628123456789
/task setiap-hari 21:00 rekap kas @628123456789
/task 25/09 14:00 meeting supplier @628123456789

/list
/cancel 4
/help
```

- Jam wajib format `HH:MM` (24 jam)
- Hari: `hari-ini`, `besok`, `senin`..`minggu`, rentang (`senin-jumat`), list (`senin,rabu,jumat`), `setiap-hari`, atau tanggal spesifik (`25/09`)
- Yang di-@tag jadi assignee task itu

## 5b. Fitur stok tipis (grup Luckyking)

Staf yang cek stok melapor di grup, yang belanja dapat rekap tiap pagi. **Semua member grup** boleh
lapor dan lihat daftar (tidak harus admin). Hanya `beres` yang dibatasi ke pembeli atau admin grup.

```
/stok tipis telur 2 kg        # lapor hampir habis (jumlah opsional)
/stok abis minyak goreng      # lapor sudah habis
/stok list                    # lihat daftar yang tipis/abis
/stok beres telur             # tandai sudah dibeli (bisa juga: /stok beres #3)
```

- Tiap jam **08:00 WIB** bot kirim rekap ke grup yang punya stok tipis/abis, dan men-tag pembeli.
- Nomor WA pembeli diisi lewat environment variable `STOK_PEMBELI` (format `628xxx`, tanpa `+`).
  Jangan ditulis di kode karena repo ini public.
- Kalau `STOK_PEMBELI` kosong, rekap tetap jalan tapi tanpa tag, dan `beres` hanya bisa oleh admin grup.
- Daftar stok disimpan terpisah per grup (tabel `stock_items` di `wa-task-bot.db`).

## 6. Alur reminder

1. Tiap menit bot cek task yang jatuh tempo → post ke grup + tag orangnya
2. Orang yang di-assign **react ✅** di pesan itu → bot tandai selesai + konfirmasi di grup
3. Kalau lewat **30 menit** belum di-react ✅ → bot auto follow-up nge-tag orangnya lagi

Ubah durasi follow-up di `src/scheduler.js` → konstanta `ESCALATE_AFTER_MINUTES`.

## 7. Jalankan permanen di server (biar gak mati kalau SSH ditutup)

Pakai [pm2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
STOK_PEMBELI=628xxxxxxxxxx pm2 start src/bot.js --name wa-task-bot
pm2 save
pm2 startup   # ikutin instruksi biar auto-start pas server reboot
```

Catatan server:
- Pakai Node 18 atau 20 LTS. Flag `--experimental-modules` tidak diperlukan (project sudah `"type": "module"`).
- Set zona waktu server ke WIB supaya jam reminder tidak meleset: `sudo timedatectl set-timezone Asia/Jakarta`
- Kalau `npm install` gagal di `better-sqlite3`: `sudo apt install -y build-essential python3`, lalu install ulang.
- Mengubah nomor pembeli: `STOK_PEMBELI=628yyy pm2 restart wa-task-bot --update-env`

## Struktur project

```
wa-task-bot/
├── src/
│   ├── bot.js         # koneksi WA, handle command & reaction
│   ├── commands.js     # parsing /task /list /cancel
│   ├── scheduler.js    # cron: generate instance harian, kirim reminder, escalation
│   ├── stock.js        # fitur stok tipis: /stok, tabel stock_items, rekap pagi
│   └── db.js           # schema & query sqlite (file: wa-task-bot.db)
├── package.json
└── README.md
```

## Next steps yang bisa ditambah nanti

- **Auto-sync booking PungRSVP** → generate task_instance otomatis dari tabel booking (belum di scaffold ini, karena butuh akses ke DB PungRSVP)
- Command `/done <id>` manual override buat admin
- Command buat edit task tanpa cancel+create ulang
- Rekap mingguan: siapa paling sering telat/lupa react ✅ (data ini udah ada di `task_instances`, tinggal query)
