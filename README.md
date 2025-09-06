# WhatsApp Expense Bot (Baileys + Express + PostgreSQL)

Bot WhatsApp untuk mencatat pengeluaran dan mengirim ringkasan otomatis harian/mingguan/bulanan.  
Dibangun dengan **@whiskeysockets/baileys**, **Express**, **PostgreSQL**, dan **node-cron**.

---

## Fitur
- Catat pengeluaran via chat WhatsApp (`✅#nominal#keterangan`)
- Ringkasan otomatis:
  - Harian (21:00 WIB)
  - Mingguan (Minggu 21:00 WIB)
  - Bulanan (hari terakhir 21:00 WIB)
- Ringkasan cepat via perintah chat (`✅#harian`, `✅#mingguan`, `✅#bulanan`)
- Endpoint HTTP API: `POST /send-message`

---

## Prasyarat
- Node.js **v18+**
- PostgreSQL **sudah tersedia** (gunakan server DB kamu sendiri)
- Akun WhatsApp aktif

---

## Instalasi Lokal

```bash
git clone <repo-kamu>
cd <repo-kamu>

# install dependency
npm install
```

Buat tabel di PostgreSQL:

```sql
CREATE TABLE IF NOT EXISTS public.pengeluaran (
  id BIGSERIAL PRIMARY KEY,
  nominal BIGINT NOT NULL,
  keterangan TEXT,
  pengirim TEXT,
  waktu TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## Konfigurasi

Edit di file utama atau gunakan ENV. Contoh ENV:

```env
DB_HOST=192.168.13.3
DB_PORT=65432
DB_USER=admin
DB_PASS=admin123
DB_NAME=kipli
```

---

## Menjalankan

```bash
node index.js
```

Saat pertama kali jalan, terminal akan menampilkan **QR** untuk dipindai dengan aplikasi WhatsApp.

---

## HTTP API

### Kirim Pesan

```bash
curl -X POST http://localhost:3000/send-message   -H "Content-Type: application/json"   -d '{"number":"628123456789","message":"Halo dari API!"}'
```

---

## Deployment dengan Docker

### 1. Dockerfile

Buat file `Dockerfile`:

```dockerfile
FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package.json & package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source code
COPY . .

# Expose port
EXPOSE 3000

# Start app
CMD ["node", "index.js"]
```

### 2. Build & Run

```bash
# build image
docker build -t wa-expense-bot .

# jalankan container
docker run -d   --name wa-expense-bot   -p 3000:3000   -v $(pwd)/auth_info:/app/auth_info   --env-file .env   wa-expense-bot
```

> Volume `auth_info` disarankan agar session WhatsApp tetap tersimpan meski container dimatikan.

---

## Troubleshooting
- **QR tidak muncul** → hapus folder `auth_info` dan jalankan ulang
- **WA tidak connect** → pastikan ponsel aktif & internet stabil
- **Ringkasan tidak terkirim** → cek `TARGET_JID_DEFAULT` dan isi DB

---

## Lisensi
MIT
