const bcrypt = require('bcrypt');
const pool = require('../db'); // db bağlantı dosyan

(async () => {
  try {
    const plainPassword = '123456';
    const hash = await bcrypt.hash(plainPassword, 10);

    const [result] = await pool.query(
      `UPDATE musteriler SET password_hash = ? WHERE musteri_id BETWEEN 1 AND 65`,
      [hash]
    );

    console.log(`✅ ${result.affectedRows} müşterinin şifresi 123456 yapıldı`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Hata:', err);
    process.exit(1);
  }
})();
