const express = require('express');
const router = express.Router();
const pool = require('../db');

// ============================================
// 📈 FABRİKA - Hammadde Sipariş Analizi
// ============================================
router.get('/hammadde-siparis-analizi', async (req, res) => {
  const { range } = req.query || {};

  try {
    let dateCondition = 'AND hs.siparis_tarihi >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)'; // default: last 1 month

    if (range === 'last_1_month') {
      dateCondition = 'AND hs.siparis_tarihi >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH)';
    } else if (range === 'last_2_months') {
      dateCondition = 'AND hs.siparis_tarihi >= DATE_SUB(CURDATE(), INTERVAL 2 MONTH)';
    } else if (range === 'last_3_months') {
      dateCondition = 'AND hs.siparis_tarihi >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)';
    }

    const sql = `
      SELECT 
        COALESCE(h.hammadde_adi, 'Bilinmeyen') AS hammadde_adi,
        COALESCE(h.birim, 'birim') AS birim,
        COALESCE(SUM(hs.miktar), 0) AS toplam_miktar
      FROM hammadde_siparisleri hs
      LEFT JOIN hammadde h ON h.hammadde_id = hs.hammadde_id
      WHERE 1 = 1
      ${dateCondition}
      GROUP BY h.hammadde_adi, h.birim
      ORDER BY toplam_miktar DESC
    `;

    const [rows] = await pool.query(sql);

    return res.json(rows || []);
  } catch (err) {
    console.error('Error in /api/fabrika/hammadde-siparis-analizi:', err);
    return res.status(500).json({
      error: 'Hammadde sipariş analizi verileri alınırken bir hata oluştu.'
    });
  }
});

// ============================================
// 📊 FABRİKA - Aylık Hammadde Satışları (2025 Ekim-Kasım-Aralık)
// ============================================
router.get('/aylik-hammadde-satislari', async (req, res) => {
  try {
    const sql = `
      SELECT
        DATE_FORMAT(hs.siparis_tarihi, '%Y-%m') AS ay_kodu,
        CONCAT(
          CASE MONTH(hs.siparis_tarihi)
            WHEN 1 THEN 'Ocak' WHEN 2 THEN 'Şubat' WHEN 3 THEN 'Mart' WHEN 4 THEN 'Nisan'
            WHEN 5 THEN 'Mayıs' WHEN 6 THEN 'Haziran' WHEN 7 THEN 'Temmuz' WHEN 8 THEN 'Ağustos'
            WHEN 9 THEN 'Eylül' WHEN 10 THEN 'Ekim' WHEN 11 THEN 'Kasım' WHEN 12 THEN 'Aralık'
          END, ' ', YEAR(hs.siparis_tarihi)
        ) AS ay_adi,
        COALESCE(h.hammadde_adi, 'Bilinmeyen') AS hammadde_adi,
        COALESCE(SUM(hs.miktar), 0) AS toplam_miktar
      FROM hammadde_siparisleri hs
      LEFT JOIN hammadde h ON h.hammadde_id = hs.hammadde_id
      WHERE hs.siparis_tarihi BETWEEN '2025-10-01' AND '2025-12-31'
      GROUP BY ay_kodu, ay_adi, h.hammadde_adi
      ORDER BY ay_kodu, toplam_miktar DESC
    `;

    const [rows] = await pool.query(sql);
    return res.json(rows || []);
  } catch (err) {
    console.error('Error in /api/fabrika/aylik-hammadde-satislari:', err);
    return res.status(500).json({
      error: 'Aylık hammadde satış verileri alınırken bir hata oluştu.'
    });
  }
});

// ============================================
// 📦 FABRİKA - Hammadde Stok Takibi
// ============================================
router.get('/hammadde-stok', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        h.hammadde_id AS id,
        h.hammadde_adi AS ad,
        COALESCE(s.mevcut_miktar, 0) AS mevcut_miktar,
        COALESCE(s.min_miktar, 0) AS min_miktar,
        h.birim
      FROM hammadde h
      LEFT JOIN hammadde_stok s ON s.hammadde_id = h.hammadde_id
      ORDER BY h.hammadde_adi
    `);

    const withKritik = rows.map(r => ({
      ...r,
      kritik: Number(r.mevcut_miktar) <= Number(r.min_miktar)
    }));

    return res.json(withKritik);
  } catch (err) {
    console.error('Error in /api/fabrika/hammadde-stok:', err);
    return res.status(500).json({
      error: 'Hammadde stok verileri alınırken bir hata oluştu.'
    });
  }
});

module.exports = router;

