// test.js
console.log('test.js çalıştı.');

const pool = require('./db');

async function testConnection() {
  try {
    console.log('Veritabanına bağlanmayı deniyorum...');

    const [rows] = await pool.query('SELECT 1 AS sonuc');

    console.log('MySQL bağlantısı başarılı! Sonuç:', rows);
  } catch (err) {
    console.error('Bağlantı hatası:', err.message);
  } finally {
    console.log('test.js bitti.');
    process.exit(0);
  }
}

testConnection();
