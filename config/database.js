// config/database.js
const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'gundogdu_tekstil',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Test connection
pool.getConnection()
  .then(connection => {
    console.log('✅ MySQL veritabanına bağlandı');
    connection.release();
  })
  .catch(err => {
    console.error('❌ MySQL bağlantı hatası:', err.message);
  });

module.exports = pool;

