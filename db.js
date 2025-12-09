// db.js
const mysql = require('mysql2/promise');

// Burayı kendi veritabanına göre düzenle
const pool = mysql.createPool({
  host: 'localhost',          // Genelde localhost
  user: 'root',               // XAMPP kullanıyorsan root
  password: '',               // Şifren varsa buraya yaz
  database: 'gundogdu_tekstil', // Veritabanı adın
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = pool;
