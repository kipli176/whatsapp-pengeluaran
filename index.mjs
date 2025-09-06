import * as baileys from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import express from 'express';
import pkg from 'pg';
import cron from 'node-cron';

const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = baileys;
const { Pool } = pkg;

const app = express();
app.use(express.json());

let sock = null;
let isConnected = false;

// ====== KONFIG ======
const TARGET_JID_DEFAULT = '628562603077@s.whatsapp.net';
const TZ = 'Asia/Jakarta';
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7, tanpa DST

// PostgreSQL connection
const db = new Pool({
  host: '192.168.13.3',
  port: 65432,
  user: 'admin',
  password: 'admin123',
  database: 'kipli',
});

// ====== UTIL WAKTU (WIB) ======
// Trik: geser waktu ke WIB (tambah 7 jam), lalu gunakan getUTC* agar komponen = komponen WIB.
function nowWIB() {
  return new Date(Date.now() + WIB_OFFSET_MS);
}

// Buat rentang harian (00:00–23:59:59.999 WIB) -> kembalikan dalam UTC Date untuk query DB
function rangeHarianWIB(baseWIB = nowWIB()) {
  const Y = baseWIB.getUTCFullYear();
  const M = baseWIB.getUTCMonth();
  const D = baseWIB.getUTCDate();
  const startUTC = new Date(Date.UTC(Y, M, D, 0, 0, 0, 0) - WIB_OFFSET_MS);
  const endUTC = new Date(Date.UTC(Y, M, D, 23, 59, 59, 999) - WIB_OFFSET_MS);
  return { startUTC, endUTC };
}

// Rentang mingguan (Minggu 00:00 WIB s/d Sabtu 23:59:59.999 WIB)
function rangeMingguanWIB(baseWIB = nowWIB()) {
  const dow = baseWIB.getUTCDay(); // 0=Min, ... 6=Sab
  const startWIB = new Date(Date.UTC(
    baseWIB.getUTCFullYear(), baseWIB.getUTCMonth(), baseWIB.getUTCDate() - dow, 0, 0, 0, 0
  ));
  const endWIB = new Date(Date.UTC(
    startWIB.getUTCFullYear(), startWIB.getUTCMonth(), startWIB.getUTCDate() + 6, 23, 59, 59, 999
  ));
  const startUTC = new Date(startWIB.getTime() - WIB_OFFSET_MS);
  const endUTC = new Date(endWIB.getTime() - WIB_OFFSET_MS);
  return { startUTC, endUTC };
}

// Rentang bulanan (1 00:00 WIB s/d akhir bulan 23:59:59.999 WIB)
function rangeBulananWIB(baseWIB = nowWIB()) {
  const Y = baseWIB.getUTCFullYear();
  const M = baseWIB.getUTCMonth();
  const startUTC = new Date(Date.UTC(Y, M, 1, 0, 0, 0, 0) - WIB_OFFSET_MS);
  const endUTC = new Date(Date.UTC(Y, M + 1, 0, 23, 59, 59, 999) - WIB_OFFSET_MS);
  return { startUTC, endUTC };
}

// Cek apakah "hari ini (WIB)" adalah hari terakhir bulan
function isHariTerakhirBulanWIB(baseWIB = nowWIB()) {
  const besokWIB = new Date(Date.UTC(
    baseWIB.getUTCFullYear(), baseWIB.getUTCMonth(), baseWIB.getUTCDate() + 1, 0, 0, 0, 0
  ));
  return besokWIB.getUTCDate() === 1; // besok tgl 1 -> hari ini last day
}

// ====== WHATSAPP ======
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: Browsers.ubuntu('BaileysDocker'),
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) qrcode.generate(qr, { small: true });

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) start();
    } else if (connection === 'open') {
      isConnected = true;
      console.log('✅ WhatsApp connected!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Handle incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    const from = msg.key.remoteJid;
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

    if (!text?.startsWith('✅#')) return;

    // Perintah laporan cepat
    const low = text.trim().toLowerCase();

    if (low === '✅#harian'.toLowerCase()) {
      const { startUTC, endUTC } = rangeHarianWIB();
      await kirimRingkasan('harian', startUTC, endUTC, from);
      return;
    }
    if (low === '✅#mingguan'.toLowerCase()) {
      const { startUTC, endUTC } = rangeMingguanWIB();
      await kirimRingkasan('mingguan', startUTC, endUTC, from);
      return;
    }
    if (low === '✅#bulanan'.toLowerCase()) {
      const { startUTC, endUTC } = rangeBulananWIB();
      await kirimRingkasan('bulanan', startUTC, endUTC, from);
      return;
    }

    // Jika bukan perintah di atas, anggap input pengeluaran: ✅#nominal#keterangan
    const parts = text.split('#');
    if (parts.length < 3) {
      await sock.sendMessage(from, { text: '❌ Format salah. Gunakan ✅#nominal#keterangan atau ✅#harian/✅#mingguan/✅#bulanan' });
      return;
    }

    const nominal = parseInt(parts[1].replace(/\D/g, ''), 10);
    const keterangan = parts.slice(2).join('#');

    if (isNaN(nominal)) {
      await sock.sendMessage(from, { text: '❌ Nominal tidak valid.' });
      return;
    }

    try {
      await db.query(
        'INSERT INTO public.pengeluaran (nominal, keterangan, pengirim) VALUES ($1, $2, $3)',
        [nominal, keterangan, from]
      );
      await sock.sendMessage(from, {
        text: `✅ Tercatat: Rp${nominal.toLocaleString()} untuk "${keterangan}"`,
      });
    } catch (err) {
      console.error(err);
      await sock.sendMessage(from, { text: '⚠️ Gagal mencatat pengeluaran.' });
    }
  });
}

// ====== RINGKASAN ======
async function kirimRingkasan(tipe, start, end, toJid = TARGET_JID_DEFAULT) {
  try {
    const result = await db.query(
      `SELECT SUM(nominal) AS total, COUNT(*) AS jumlah
       FROM public.pengeluaran
       WHERE waktu BETWEEN $1 AND $2`,
      [start, end]
    );

    const { total, jumlah } = result.rows[0] || { total: 0, jumlah: 0 };

    const resList = await db.query(
      `SELECT nominal, keterangan 
       FROM public.pengeluaran 
       WHERE waktu BETWEEN $1 AND $2 
       ORDER BY waktu ASC`,
      [start, end]
    );

    const detail = resList.rows
      .map((r, i) => `${i + 1}. Rp${Number(r.nominal).toLocaleString()} - ${r.keterangan}`)
      .join('\n');

    const label =
      tipe === 'harian' ? 'Hari Ini' :
      tipe === 'mingguan' ? 'Minggu Ini' :
      'Bulan Ini';

    const pesan =
      `📊 Ringkasan Pengeluaran ${label} (WIB):\n\n` +
      `Jumlah Transaksi: ${jumlah || 0}\n` +
      `Total: Rp${Number(total || 0).toLocaleString()}\n\n` +
      `📝 Rincian:\n${detail || `Tidak ada pengeluaran ${tipe} ini.`}`;

    if (isConnected && sock) {
      await sock.sendMessage(toJid, { text: pesan });
      console.log(`✅ Ringkasan ${tipe} dikirim ke ${toJid}`);
    } else {
      console.log(`ℹ️ WA belum terkoneksi, ringkasan ${tipe} tidak terkirim`);
    }
  } catch (err) {
    console.error(`❌ Gagal mengirim ringkasan ${tipe}:`, err);
  }
}

// ====== JADWAL (Asia/Jakarta) ======
// 1) Harian — setiap hari 21:00 WIB
cron.schedule('0 21 * * *', async () => {
  const { startUTC, endUTC } = rangeHarianWIB();
  await kirimRingkasan('harian', startUTC, endUTC);
}, { timezone: TZ });

// 2) Mingguan — setiap Minggu 21:00 WIB
cron.schedule('0 21 * * 0', async () => {
  const { startUTC, endUTC } = rangeMingguanWIB();
  await kirimRingkasan('mingguan', startUTC, endUTC);
}, { timezone: TZ });

// 3) Bulanan — hari terakhir bulan 21:00 WIB (aman utk Feb)
cron.schedule('0 21 * * *', async () => {
  const wib = nowWIB();
  if (!isHariTerakhirBulanWIB(wib)) return;
  const { startUTC, endUTC } = rangeBulananWIB(wib);
  await kirimRingkasan('bulanan', startUTC, endUTC);
}, { timezone: TZ });

// ====== HTTP ======
app.post('/send-message', async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }

  const { number, message } = req.body;
  if (!number || !message) {
    return res.status(400).json({ error: 'Missing number or message' });
  }

  const jid = number.includes('@s.whatsapp.net') ? number : number + '@s.whatsapp.net';

  try {
    await sock.sendMessage(jid, { text: message });
    res.json({ status: 'sent', to: number });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ====== START ======
start();
app.listen(3000, () => console.log('🚀 API ready on http://localhost:3000'));
