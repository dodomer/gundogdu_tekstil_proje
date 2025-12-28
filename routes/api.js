// routes/api.js - API Route Tanımlamaları
const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');

// Configure multer for file uploads
const uploadsDir = path.join(__dirname, '../uploads/machine_fault_reports');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'fault-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: function (req, file, cb) {
    // Allow only images (jpeg, png, webp)
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Sadece resim dosyaları yüklenebilir (JPEG, PNG, WebP)'), false);
    }
  }
});

// ============================================
// 📊 DASHBOARD - İstatistikler
// ============================================
router.get('/dashboard/stats', async (req, res) => {
  try {
    // Tablolar mevcut mu kontrol et
    const [tables] = await pool.query(`
      SELECT TABLE_NAME 
      FROM information_schema.TABLES 
      WHERE TABLE_SCHEMA = DATABASE()
    `);
    
    const tableNames = tables.map(t => t.TABLE_NAME);
    
    const stats = {
      tablolar: tableNames,
      tabloSayisi: tableNames.length,
      veritabani: 'gundogdu_tekstil'
    };

    // Her tablo için kayıt sayısını al
    for (const tableName of tableNames) {
      try {
        const [count] = await pool.query(`SELECT COUNT(*) as sayi FROM \`${tableName}\``);
        stats[tableName] = count[0].sayi;
      } catch (e) {
        stats[tableName] = 'Hata';
      }
    }

    res.json(stats);
  } catch (error) {
    console.error('Dashboard hatası:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 📋 GENEL TABLO İŞLEMLERİ
// ============================================

// Tüm tabloları listele
router.get('/tables', async (req, res) => {
  try {
    const [tables] = await pool.query(`
      SELECT TABLE_NAME, TABLE_ROWS, CREATE_TIME, UPDATE_TIME
      FROM information_schema.TABLES 
      WHERE TABLE_SCHEMA = DATABASE()
    `);
    res.json(tables);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Belirli bir tablonun yapısını al
router.get('/tables/:tableName/structure', async (req, res) => {
  try {
    const { tableName } = req.params;
    const [columns] = await pool.query(`DESCRIBE \`${tableName}\``);
    res.json(columns);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Belirli bir tablonun verilerini al (sayfalama ile)
router.get('/tables/:tableName/data', async (req, res) => {
  try {
    const { tableName } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    // Toplam kayıt sayısı
    const [countResult] = await pool.query(`SELECT COUNT(*) as total FROM \`${tableName}\``);
    const total = countResult[0].total;

    // Veriler
    const [rows] = await pool.query(`SELECT * FROM \`${tableName}\` LIMIT ? OFFSET ?`, [limit, offset]);

    res.json({
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Yeni kayıt ekle
router.post('/tables/:tableName/data', async (req, res) => {
  try {
    const { tableName } = req.params;
    const data = req.body;

    const columns = Object.keys(data).map(k => `\`${k}\``).join(', ');
    const placeholders = Object.keys(data).map(() => '?').join(', ');
    const values = Object.values(data);

    const [result] = await pool.query(
      `INSERT INTO \`${tableName}\` (${columns}) VALUES (${placeholders})`,
      values
    );

    res.status(201).json({ 
      message: 'Kayıt eklendi', 
      insertId: result.insertId 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Kayıt güncelle
router.put('/tables/:tableName/data/:id', async (req, res) => {
  try {
    const { tableName, id } = req.params;
    const data = req.body;

    // İlk sütunu (genelde ID) bul
    const [columns] = await pool.query(`DESCRIBE \`${tableName}\``);
    const idColumn = columns[0].Field;

    const updates = Object.keys(data).map(k => `\`${k}\` = ?`).join(', ');
    const values = [...Object.values(data), id];

    const [result] = await pool.query(
      `UPDATE \`${tableName}\` SET ${updates} WHERE \`${idColumn}\` = ?`,
      values
    );

    res.json({ 
      message: 'Kayıt güncellendi', 
      affectedRows: result.affectedRows 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Kayıt sil
router.delete('/tables/:tableName/data/:id', async (req, res) => {
  try {
    const { tableName, id } = req.params;

    // İlk sütunu (genelde ID) bul
    const [columns] = await pool.query(`DESCRIBE \`${tableName}\``);
    const idColumn = columns[0].Field;

    const [result] = await pool.query(
      `DELETE FROM \`${tableName}\` WHERE \`${idColumn}\` = ?`,
      [id]
    );

    res.json({ 
      message: 'Kayıt silindi', 
      affectedRows: result.affectedRows 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SQL sorgusu çalıştır (dikkatli kullanın!)
router.post('/query', async (req, res) => {
  try {
    const { sql } = req.body;
    
    // Güvenlik: Sadece SELECT sorgularına izin ver
    if (!sql.trim().toUpperCase().startsWith('SELECT')) {
      return res.status(403).json({ error: 'Sadece SELECT sorguları çalıştırılabilir' });
    }

    const [rows] = await pool.query(sql);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 📦 HAMMADDE YÖNETİMİ (BOM)
// ============================================

// Ürün listesi
router.get('/urunler/list', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT urun_id, urun_adi AS urun_ad FROM urunler ORDER BY urun_adi');
    res.json(rows || []);
  } catch (error) {
    console.error('Ürün listesi hatası:', error);
    res.json([]);
  }
});

// Hammadde listesi
router.get('/hammadde/list', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT hammadde_id, hammadde_adi AS hammadde_ad FROM hammadde ORDER BY hammadde_adi');
    res.json(rows || []);
  } catch (error) {
    console.error('Hammadde listesi hatası:', error);
    res.json([]);
  }
});

// Ürün reçetesi (BOM) - ürüne göre hammaddeler
router.get('/urun-recepte', async (req, res) => {
  try {
    const { urun_id } = req.query;
    if (!urun_id) return res.json([]);

    const [rows] = await pool.query(`
      SELECT uh.urun_id, u.urun_adi AS urun_ad, uh.hammadde_id, h.hammadde_adi AS hammadde_ad, uh.miktar, h.birim
      FROM urun_hammadde uh
      JOIN urunler u ON u.urun_id = uh.urun_id
      JOIN hammadde h ON h.hammadde_id = uh.hammadde_id
      WHERE uh.urun_id = ?
      ORDER BY h.hammadde_adi
    `, [urun_id]);
    res.json(rows || []);
  } catch (error) {
    console.error('Ürün reçetesi hatası:', error);
    res.json([]);
  }
});

// Hammadde kullanıldığı ürünler
router.get('/hammadde-urunler', async (req, res) => {
  try {
    const { hammadde_id } = req.query;
    if (!hammadde_id) return res.json([]);

    const [rows] = await pool.query(`
      SELECT uh.hammadde_id, h.hammadde_adi AS hammadde_ad, uh.urun_id, u.urun_adi AS urun_ad, uh.miktar
      FROM urun_hammadde uh
      JOIN urunler u ON u.urun_id = uh.urun_id
      JOIN hammadde h ON h.hammadde_id = uh.hammadde_id
      WHERE uh.hammadde_id = ?
      ORDER BY u.urun_adi
    `, [hammadde_id]);
    res.json(rows || []);
  } catch (error) {
    console.error('Hammadde ürünleri hatası:', error);
    res.json([]);
  }
});

// Hammadde tüketim istatistikleri (global)
router.get('/hammadde/consumption', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const [rows] = await pool.query(`
      SELECT
        uh.hammadde_id,
        h.hammadde_adi AS hammadde_ad,
        h.birim,
        SUM(uh.miktar) AS toplam_miktar
      FROM urun_hammadde uh
      JOIN hammadde h ON h.hammadde_id = uh.hammadde_id
      GROUP BY uh.hammadde_id, h.birim, h.hammadde_adi
      ORDER BY toplam_miktar DESC
      LIMIT ?
    `, [limit]);
    res.json(rows || []);
  } catch (error) {
    console.error('Hammadde tüketim hatası:', error);
    res.json([]);
  }
});

// Kritik hammaddeler (global)
router.get('/hammadde/critical', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const [rows] = await pool.query(`
      SELECT
        uh.hammadde_id,
        h.hammadde_adi AS hammadde_ad,
        h.birim,
        COUNT(DISTINCT uh.urun_id) AS urun_sayisi,
        SUM(uh.miktar) AS toplam_miktar,
        (COUNT(DISTINCT uh.urun_id) * SUM(uh.miktar)) AS kritiklik_skoru
      FROM urun_hammadde uh
      JOIN hammadde h ON h.hammadde_id = uh.hammadde_id
      GROUP BY uh.hammadde_id, h.birim, h.hammadde_adi
      ORDER BY kritiklik_skoru DESC
      LIMIT ?
    `, [limit]);
    res.json(rows || []);
  } catch (error) {
    console.error('Kritik hammadde hatası:', error);
    res.json([]);
  }
});

// Production analytics - Get production by vehicle model (with limit)
router.get('/analytics/production-by-product', async (req, res) => {
  try {
    const { month, limit } = req.query;
    const isAllTime = !month || month === 'all' || month === '';
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    
    let query;
    let params = [];
    
    if (isAllTime) {
      query = `
        SELECT
          am.arac_model_id AS model_id,
          am.model_adi AS model_adi,
          SUM(sd.adet) AS toplam_adet
        FROM siparis_detay sd
        JOIN siparisler s ON s.siparis_id = sd.siparis_id
        JOIN urunler u ON u.urun_id = sd.urun_id
        JOIN arac_modelleri am ON am.arac_model_id = u.arac_model_id
        WHERE s.durumu IN ('TAMAMLANDI', 'SEVK EDILDI')
        GROUP BY am.arac_model_id, am.model_adi
        ORDER BY toplam_adet DESC
        LIMIT ?
      `;
      params = [limitNum];
    } else {
      query = `
        SELECT
          am.arac_model_id AS model_id,
          am.model_adi AS model_adi,
          SUM(sd.adet) AS toplam_adet
        FROM siparis_detay sd
        JOIN siparisler s ON s.siparis_id = sd.siparis_id
        JOIN urunler u ON u.urun_id = sd.urun_id
        JOIN arac_modelleri am ON am.arac_model_id = u.arac_model_id
        WHERE s.durumu IN ('TAMAMLANDI', 'SEVK EDILDI')
          AND DATE_FORMAT(s.siparis_tarihi, '%Y-%m') = ?
        GROUP BY am.arac_model_id, am.model_adi
        ORDER BY toplam_adet DESC
        LIMIT ?
      `;
      params = [month, limitNum];
    }
    
    const [rows] = await pool.query(query, params);
    
    // Map to include etiket for backward compatibility
    const result = rows.map(row => ({
      model_id: row.model_id,
      model_adi: row.model_adi,
      etiket: row.model_adi, // For backward compatibility
      toplam_adet: row.toplam_adet
    }));
    
    res.json(result || []);
  } catch (error) {
    console.error('Production by model error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Production analytics - Get full list of models (no limit, for selector)
router.get('/analytics/production-by-product/list', async (req, res) => {
  try {
    const { month } = req.query;
    const isAllTime = !month || month === 'all' || month === '';
    
    let query;
    let params = [];
    
    if (isAllTime) {
      query = `
        SELECT
          am.arac_model_id AS model_id,
          am.model_adi AS model_adi,
          SUM(sd.adet) AS toplam_adet
        FROM siparis_detay sd
        JOIN siparisler s ON s.siparis_id = sd.siparis_id
        JOIN urunler u ON u.urun_id = sd.urun_id
        JOIN arac_modelleri am ON am.arac_model_id = u.arac_model_id
        WHERE s.durumu IN ('TAMAMLANDI', 'SEVK EDILDI')
        GROUP BY am.arac_model_id, am.model_adi
        ORDER BY toplam_adet DESC
      `;
    } else {
      query = `
        SELECT
          am.arac_model_id AS model_id,
          am.model_adi AS model_adi,
          SUM(sd.adet) AS toplam_adet
        FROM siparis_detay sd
        JOIN siparisler s ON s.siparis_id = sd.siparis_id
        JOIN urunler u ON u.urun_id = sd.urun_id
        JOIN arac_modelleri am ON am.arac_model_id = u.arac_model_id
        WHERE s.durumu IN ('TAMAMLANDI', 'SEVK EDILDI')
          AND DATE_FORMAT(s.siparis_tarihi, '%Y-%m') = ?
        GROUP BY am.arac_model_id, am.model_adi
        ORDER BY toplam_adet DESC
      `;
      params = [month];
    }
    
    const [rows] = await pool.query(query, params);
    
    res.json(rows || []);
  } catch (error) {
    console.error('Production by model list error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Production analytics - Get available months
router.get('/analytics/production-months', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT DISTINCT DATE_FORMAT(siparis_tarihi, '%Y-%m') AS ay
      FROM siparisler
      WHERE durumu IN ('TAMAMLANDI', 'SEVK EDILDI')
      ORDER BY ay DESC
    `);
    
    const months = rows.map(row => row.ay).filter(Boolean);
    res.json(months || []);
  } catch (error) {
    console.error('Production months error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Gündoğdu hammadde stok listesi
router.get('/gundogdu/hammadde-stok', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        h.hammadde_id,
        h.hammadde_adi,
        h.birim,
        COALESCE(gs.mevcut_miktar, 0) AS mevcut_miktar,
        COALESCE(gs.min_miktar, 0) AS min_miktar,
        CASE
          WHEN COALESCE(gs.mevcut_miktar, 0) <= COALESCE(gs.min_miktar, 0) THEN 'KRITIK'
          ELSE 'NORMAL'
        END AS durum
      FROM hammadde h
      LEFT JOIN gundogdu_hammadde_stok gs ON gs.hammadde_id = h.hammadde_id
      WHERE h.aktif_mi = 1
      ORDER BY durum DESC, h.hammadde_adi ASC
    `);
    res.json(rows || []);
  } catch (error) {
    console.error('Gündoğdu hammadde stok hatası:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get critical raw material count for Gündoğdu stock
router.get('/gundogdu/kritik-hammadde-sayisi', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT COUNT(*) AS kritik_sayisi
      FROM gundogdu_hammadde_stok gs
      JOIN hammadde h ON h.hammadde_id = gs.hammadde_id
      WHERE h.aktif_mi = 1
        AND gs.min_miktar > 0
        AND gs.mevcut_miktar <= gs.min_miktar
    `);
    const kritikSayisi = Number(rows[0]?.kritik_sayisi || 0);
    res.json({ 
      success: true,
      kritikHammaddeSayisi: kritikSayisi 
    });
  } catch (error) {
    console.error('Kritik hammadde sayısı hatası:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// API Sağlık kontrolü
router.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status: 'OK', 
      database: 'Bağlı',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'ERROR', 
      database: 'Bağlantı hatası',
      error: error.message 
    });
  }
});

// ============================================
// 🔧 MAKINE ARIZA BILDIRIMLERI
// ============================================

// GET /api/machines - Get active machines
router.get('/machines', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT makine_id, makine_adi, makine_turu
      FROM makine
      WHERE aktif_mi = 1
      ORDER BY makine_adi
    `);
    res.json(rows || []);
  } catch (error) {
    console.error('Machines list error:', error);
    res.status(500).json({ error: 'Makineler yüklenirken hata oluştu' });
  }
});

// GET /api/machine-fault-reports - Get reports for a personnel
router.get('/machine-fault-reports', async (req, res) => {
  try {
    const { personel_id, limit = 5 } = req.query;
    
    if (!personel_id) {
      return res.status(400).json({ error: 'personel_id gerekli' });
    }

    const limitNum = parseInt(limit, 10) || 5;
    
    const [rows] = await pool.query(`
      SELECT 
        r.report_id,
        r.personel_id,
        r.makine_id,
        r.fault_type,
        r.priority,
        r.title,
        r.description,
        r.photo_url,
        r.status,
        r.created_at,
        r.updated_at,
        m.makine_adi
      FROM machine_fault_reports r
      JOIN makine m ON m.makine_id = r.makine_id
      WHERE r.personel_id = ?
      ORDER BY r.created_at DESC
      LIMIT ?
    `, [personel_id, limitNum]);
    
    res.json(rows || []);
  } catch (error) {
    console.error('Machine fault reports list error:', error);
    res.status(500).json({ error: 'Bildirimler yüklenirken hata oluştu' });
  }
});

// POST /api/machine-fault-reports - Create new fault report
router.post('/machine-fault-reports', upload.single('photo'), async (req, res) => {
  try {
    const { personel_id, makine_id, fault_type, priority, title, description } = req.body;

    
    // Validate required fields
    if (!personel_id || !makine_id || !fault_type || !priority || !title || !description) {
      return res.status(400).json({ 
        error: 'Tüm zorunlu alanlar doldurulmalıdır' 
      });
    }

    // Validate title length
    if (title.length > 160) {
      return res.status(400).json({ 
        error: 'Başlık en fazla 160 karakter olabilir' 
      });
    }

    // Handle file upload if present
    let photoUrl = null;
    if (req.file) {
      photoUrl = `/uploads/machine_fault_reports/${req.file.filename}`;
    }

    // Insert report with photo_url
    const [result] = await pool.query(`
      INSERT INTO machine_fault_reports 
        (personel_id, makine_id, fault_type, priority, title, description, photo_url, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Açık', NOW(), NOW())
    `, [personel_id, makine_id, fault_type, priority, title, description, photoUrl]);

    const reportId = result.insertId;

    res.json({ 
      success: true, 
      report_id: reportId,
      photo_url: photoUrl,
      message: 'Bildirim başarıyla oluşturuldu' 
    });
  } catch (error) {
    console.error('Machine fault report create error:', error);
    res.status(500).json({ 
      error: 'Bildirim oluşturulurken hata oluştu: ' + error.message 
    });
  }
});
// ============================================
// 🤖 AI DECISION SUPPORT
// ============================================

// POST /api/ai/decision
router.post("/ai/decision", async (req, res) => {
  try {
    const { question, context } = req.body;

    if (!question || question.trim().length < 5) {
      return res.status(400).json({ success: false, error: "Soru çok kısa." });
    }

    const input = context
      ? `CONTEXT:\n${JSON.stringify(context, null, 2)}\n\nQUESTION:\n${question}`
      : question;

    const response = await openai.responses.create({
      model: "gpt-5",
      instructions:
        "You are a decision support assistant for a textile manufacturing company. Reply in Turkish. Be concise and actionable. Use bullet points. If data is missing, state assumptions.",
      input
    });

    return res.json({ success: true, answer: response.output_text });
  } catch (err) {
    console.error("AI decision error:", err);
    return res.status(500).json({ success: false, error: "AI servisi hatası." });
  }
});


// ============================================
// 🤖 AI INSIGHTS & DECISION SUPPORT
// ============================================

// GET /api/ai/insights - Generate automatic insights from database
router.get('/ai/insights', async (req, res) => {
  try {
    const pool = require('../config/database');
    
    // Build context object from database
    const context = {};
    
    // 1. Dashboard KPIs
    try {
      const [kpiRows] = await pool.query(`
        SELECT
          COUNT(*) AS totalOrders,
          SUM(CASE WHEN UPPER(TRIM(s.durumu)) NOT IN ('TAMAMLANDI','TESLIM_EDILDI') THEN 1 ELSE 0 END) AS activeOrders,
          SUM(CASE WHEN UPPER(TRIM(s.durumu)) = 'IPTAL' THEN 1 ELSE 0 END) AS canceledOrders,
          COALESCE(SUM(CASE WHEN UPPER(TRIM(s.durumu)) <> 'IPTAL' THEN d.toplam_tutar END), 0) AS totalRevenue
        FROM siparisler s
        LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
      `);
      const kpi = kpiRows[0] || {};
      context.kpis = {
        totalOrders: Number(kpi.totalOrders) || 0,
        activeOrders: Number(kpi.activeOrders) || 0,
        totalRevenue: Number(kpi.totalRevenue) || 0,
        cancelRate: kpi.totalOrders > 0 ? ((Number(kpi.canceledOrders) || 0) / Number(kpi.totalOrders)) * 100 : 0
      };
    } catch (err) {
      console.error('KPI query error:', err);
    }
    
    // 2. Order status counts (last 3 months)
    try {
      const [statusRows] = await pool.query(`
        SELECT durumu AS status, COUNT(*) AS count
        FROM siparisler
        WHERE siparis_tarihi >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)
        GROUP BY durumu
      `);
      context.orderStatusCounts = statusRows || [];
    } catch (err) {
      console.error('Order status query error:', err);
    }
    
    // 3. Order completion time distribution + delayed ratio (last 3 months)
    try {
      const [completionRows] = await pool.query(`
        SELECT
          COUNT(*) AS total_completed,
          SUM(CASE WHEN DATEDIFF(COALESCE(s.teslim_plan, s.siparis_tarihi), s.siparis_tarihi) > 7 THEN 1 ELSE 0 END) AS late_completed
        FROM siparisler s
        WHERE s.durumu = 'TAMAMLANDI'
          AND s.siparis_tarihi >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)
      `);
      const comp = completionRows[0] || {};
      context.orderCompletion = {
        totalCompleted: Number(comp.total_completed) || 0,
        lateCompleted: Number(comp.late_completed) || 0,
        lateRate: comp.total_completed > 0 ? ((Number(comp.late_completed) || 0) / Number(comp.total_completed)) * 100 : 0
      };
    } catch (err) {
      console.error('Order completion query error:', err);
    }
    
    // 4. Machine faults (last 14 days)
    try {
      const [faultRows] = await pool.query(`
        SELECT
          COUNT(*) AS total_faults,
          SUM(CASE WHEN status = 'Açık' THEN 1 ELSE 0 END) AS open_faults,
          SUM(CASE WHEN priority = 'Kritik' THEN 1 ELSE 0 END) AS critical_faults
        FROM machine_fault_reports
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
      `);
      const fault = faultRows[0] || {};
      context.machineFaults = {
        totalFaults: Number(fault.total_faults) || 0,
        openFaults: Number(fault.open_faults) || 0,
        criticalFaults: Number(fault.critical_faults) || 0
      };
      
      // Top machines by fault count
      const [topMachines] = await pool.query(`
        SELECT m.makine_adi, COUNT(*) AS fault_count
        FROM machine_fault_reports r
        JOIN makine m ON m.makine_id = r.makine_id
        WHERE r.created_at >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
        GROUP BY m.makine_id, m.makine_adi
        ORDER BY fault_count DESC
        LIMIT 5
      `);
      context.topMachinesByFaults = topMachines || [];
    } catch (err) {
      console.error('Machine faults query error:', err);
    }
    
    // 5. Raw material consumption (top 10)
    try {
      const [rawMatRows] = await pool.query(`
        SELECT
          h.hammadde_id,
          h.hammadde_adi,
          SUM(uh.miktar) AS toplam_miktar
        FROM urun_hammadde uh
        JOIN hammadde h ON h.hammadde_id = uh.hammadde_id
        GROUP BY h.hammadde_id, h.hammadde_adi
        ORDER BY toplam_miktar DESC
        LIMIT 10
      `);
      context.topRawMaterials = rawMatRows || [];
    } catch (err) {
      console.error('Raw materials query error:', err);
    }
    
    // 6. Inflation data (last 3 months)
    try {
      // Use demo values from existing endpoint
      context.inflation = {
        monthly: {
          Eki: 2.8,
          Kas: 3.1,
          Ara: 2.9
        },
        annual: 64.8
      };
    } catch (err) {
      console.error('Inflation query error:', err);
    }
    
    // Call OpenAI with context
    const prompt = `Aşağıda bir tekstil üretim şirketinin veritabanı verileri bulunmaktadır. Bu verilere dayanarak, şirket için 6-10 adet öncelikli, eyleme dönüştürülebilir öneri üret.

VERİLER:
${JSON.stringify(context, null, 2)}

ÖNEMLİ KURALLAR:
1. SADECE verilen verileri kullan. Genel tekstil danışmanlığı yapma.
2. Veritabanında olmayan ürünlerden (tişört, kot pantolon, kumaş türleri vb.) bahsetme.
3. Her öneri şu formatta JSON olmalı:
   {
     "title": "Kısa başlık",
     "priority": "High|Medium|Low",
     "why": "Neden bu öneri önemli (veri referansları ile)",
     "action": "Yapılacak eylem",
     "metric_refs": ["hangi metriklerden bahsedildiği"]
   }
4. Öncelik belirleme: Kritik sorunlar (yüksek iptal oranı, kritik arızalar, gecikmeler) = High, Orta seviye sorunlar = Medium, İyileştirme fırsatları = Low
5. Türkçe yanıt ver.

Yanıtı SADECE JSON formatında ver, başka açıklama ekleme:
{
  "insights": [
    ...
  ]
}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Sen bir tekstil üretim şirketi için veri analisti ve iş danışmanısın. Sadece verilen verilere dayanarak öneriler üret."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7,
      response_format: { type: "json_object" }
    });

    const responseText = completion.choices[0].message.content;
    let insightsData;
    
    try {
      insightsData = JSON.parse(responseText);
    } catch (parseErr) {
      // Fallback if JSON parsing fails
      console.error('JSON parse error:', parseErr);
      insightsData = {
        insights: [{
          title: "Veri analizi tamamlandı",
          priority: "Medium",
          why: "Sistem verilerinizi analiz etti",
          action: "Detaylı raporları inceleyin",
          metric_refs: ["Genel"]
        }]
      };
    }

    res.json({
      success: true,
      insights: insightsData.insights || [],
      context: context // Return context for use in question form
    });
    
  } catch (error) {
    console.error('AI insights error:', error);
    res.status(500).json({
      success: false,
      error: 'İçgörüler oluşturulurken hata oluştu: ' + error.message
    });
  }
});

// POST /api/ai/decision - Get AI decision support with context
router.post('/ai/decision', async (req, res) => {
  try {
    const { question, context } = req.body;
    
    if (!question || !question.trim()) {
      return res.status(400).json({ 
        error: 'Soru alanı boş olamaz' 
      });
    }

    // Use provided context or build minimal context
    let dbContext = context;
    if (!dbContext || Object.keys(dbContext).length === 0) {
      // Build minimal context if not provided
      const pool = require('../config/database');
      try {
        const [kpiRows] = await pool.query(`
          SELECT
            COUNT(*) AS totalOrders,
            SUM(CASE WHEN UPPER(TRIM(s.durumu)) NOT IN ('TAMAMLANDI','TESLIM_EDILDI') THEN 1 ELSE 0 END) AS activeOrders,
            SUM(CASE WHEN UPPER(TRIM(s.durumu)) = 'IPTAL' THEN 1 ELSE 0 END) AS canceledOrders,
            COALESCE(SUM(CASE WHEN UPPER(TRIM(s.durumu)) <> 'IPTAL' THEN d.toplam_tutar END), 0) AS totalRevenue
          FROM siparisler s
          LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
        `);
        const kpi = kpiRows[0] || {};
        dbContext = {
          kpis: {
            totalOrders: Number(kpi.totalOrders) || 0,
            activeOrders: Number(kpi.activeOrders) || 0,
            totalRevenue: Number(kpi.totalRevenue) || 0,
            cancelRate: kpi.totalOrders > 0 ? ((Number(kpi.canceledOrders) || 0) / Number(kpi.totalOrders)) * 100 : 0
          }
        };
      } catch (err) {
        console.error('Context build error:', err);
        dbContext = {};
      }
    }

    const prompt = `VERİLER:\n${JSON.stringify(dbContext, null, 2)}\n\nSORU:\n${question}\n\nYanıtını SADECE verilen veritabanı verilerine dayandır. Veritabanında olmayan ürünlerden bahsetme. Türkçe yanıt ver.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Sen bir tekstil üretim şirketi için veri analisti ve iş danışmanısın. Sadece verilen verilere dayanarak yanıt ver."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7
    });

    const response = completion.choices[0].message.content;

    res.json({ 
      success: true,
      response: response,
      question: question
    });
  } catch (error) {
    console.error('AI decision error:', error);
    res.status(500).json({ 
      error: 'AI karar alınırken hata oluştu: ' + error.message 
    });
  }
});

module.exports = router;

