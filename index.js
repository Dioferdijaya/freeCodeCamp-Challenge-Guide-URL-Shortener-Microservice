require('dotenv').config(); // Memuat variabel lingkungan dari file .env
var express = require('express');
var RateLimit = require('express-rate-limit'); // Untuk membatasi request
const cors = require('cors'); // Untuk mengizinkan Cross-Origin Resource Sharing
const app = express();
const urlparser = require('url'); // Modul untuk memparsing URL
const { MongoClient } = require('mongodb'); // Driver MongoDB
const dns = require('dns'); // Modul DNS untuk lookup hostname

// --- Konfigurasi Dasar ---
const port = process.env.PORT || 3000; // Port server, default 3000
const cdb = new MongoClient(process.env.URI); // Inisialisasi klien MongoDB dengan URI dari .env
const db = cdb.db("url_service"); // Menggunakan database "url_service"
const urlsCollection = db.collection('urls'); // Koleksi untuk menyimpan URL
const countersCollection = db.collection('counters'); // Koleksi baru untuk counter ID pendek

// --- Middleware Rate Limiter ---
// Batasi 100 request per 15 menit dari satu IP
var limiter = RateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 100, // Maksimal 100 request
  message: "Terlalu banyak permintaan dari IP ini, coba lagi setelah 15 menit."
});
app.use(limiter); // Terapkan rate limiter ke semua request

// --- Middleware Lainnya ---
app.use(cors()); // Mengizinkan semua CORS
app.use('/public', express.static(`${process.cwd()}/public`)); // Menyajikan file statis dari folder public
app.use(express.urlencoded({ extended: true })); // Mengizinkan parsing body URL-encoded
app.use(express.json()); // Mengizinkan parsing body JSON

// --- Routes ---

// Route utama untuk menyajikan file HTML
app.get('/', function(req, res) {
  res.sendFile(process.cwd() + '/views/index.html');
});

// Endpoint API untuk membuat URL pendek baru
app.post('/api/shorturl', function(req, res) {
  const urlString = req.body.url;

  // Validasi URL dasar
  let parsedUrl;
  try {
    parsedUrl = urlparser.parse(urlString);
  } catch (err) {
    return res.json({ error: "Invalid URL" });
  }

  // Periksa apakah URL memiliki hostname yang valid
  if (!parsedUrl.hostname) {
    // URL tidak memiliki hostname, misalnya "ftp://example.com" atau "invalid"
    return res.json({ error: "Invalid URL" });
  }

  // Lakukan DNS lookup untuk memvalidasi hostname
  dns.lookup(parsedUrl.hostname, async (err, address) => {
    if (err || !address) {
      // DNS lookup gagal atau tidak menemukan alamat (hostname tidak valid/tidak dapat dijangkau)
      return res.json({ error: "Invalid URL" });
    } else {
      // Hostname valid, lanjutkan proses shortening
      try {
        // 1. Periksa apakah URL asli sudah ada di database
        let existingUrlDoc = await urlsCollection.findOne({ original_url: urlString });

        if (existingUrlDoc) {
          // Jika URL sudah ada, kembalikan URL pendek yang sudah ada
          return res.json({
            original_url: existingUrlDoc.original_url,
            short_url: existingUrlDoc.short_url
          });
        }

        // 2. Dapatkan ID pendek yang unik secara atomik
        // Gunakan findOneAndUpdate untuk menaikkan counter dan mendapatkan nilai baru
        const counterDoc = await countersCollection.findOneAndUpdate(
          { _id: 'urlid' }, // Cari dokumen counter dengan ID 'urlid'
          { $inc: { seq: 1 } }, // Naikkan nilai 'seq' sebanyak 1
          { upsert: true, returnDocument: 'after' } // upsert:true akan membuat dokumen jika tidak ada, returnDocument:'after' akan mengembalikan dokumen setelah diupdate
        );

        const newShortUrl = counterDoc.value.seq; // Ambil nilai counter yang baru

        // 3. Simpan URL baru dengan ID pendek yang dihasilkan
        const result = await urlsCollection.insertOne({
          original_url: urlString,
          short_url: newShortUrl
        });

        console.log(`URL baru disimpan dengan ID: ${result.insertedId} dan short_url: ${newShortUrl}`);
        res.json({
          original_url: urlString,
          short_url: newShortUrl
        });
      } catch (dbError) {
        console.error("Terjadi error database saat memproses URL:", dbError);
        res.json({ error: "Gagal membuat URL pendek karena error database." });
      }
    }
  });
});

// Endpoint API untuk mengarahkan ke URL asli berdasarkan ID pendek
app.get("/api/shorturl/:short_url", async (req, res) => {
  const shorturlParam = req.params.short_url;

  // Validasi apakah parameter short_url adalah angka
  if (isNaN(shorturlParam)) {
    return res.json({ error: "Format URL pendek salah. Harus berupa angka." });
  }

  try {
    // Cari dokumen URL berdasarkan short_url (konversi ke number menggunakan '+')
    const urlDoc = await urlsCollection.findOne({ short_url: +shorturlParam });

    if (urlDoc) {
      // Jika ditemukan, redirect ke URL asli
      res.redirect(urlDoc.original_url);
    } else {
      // Jika tidak ditemukan
      res.json({ error: "URL pendek tidak ditemukan untuk input tersebut." });
    }
  } catch (dbError) {
    console.error("Terjadi error database saat mengambil URL:", dbError);
    res.json({ error: "Gagal mengambil URL karena error database." });
  }
});

// --- Inisialisasi Server ---
// Lakukan koneksi ke MongoDB terlebih dahulu, lalu jalankan server Express
cdb.connect()
  .then(async () => {
    console.log("Berhasil terhubung ke MongoDB!");

    // Pastikan dokumen counter 'urlid' ada dan diinisialisasi jika belum
    const existingCounter = await countersCollection.findOne({ _id: 'urlid' });
    if (!existingCounter) {
      await countersCollection.insertOne({ _id: 'urlid', seq: 0 });
      console.log("Counter 'urlid' di koleksi 'counters' telah diinisialisasi.");
    }

    // Jalankan server Express setelah koneksi DB berhasil
    app.listen(port, function() {
      console.log(`Server mendengarkan di port ${port}`);
    });
  })
  .catch(err => {
    // Jika koneksi MongoDB gagal, log error dan hentikan aplikasi
    console.error("Gagal terhubung ke MongoDB:", err);
    process.exit(1); // Keluar dari proses dengan kode error
  });