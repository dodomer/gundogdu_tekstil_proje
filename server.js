require("dotenv").config();
// server.js - Ana Express Sunucusu
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');

// Routes
const apiRoutes = require('./routes/api');
const fabrikaRoutes = require('./routes/fabrika');

// Database connection
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helpers
const parseCustomerId = (customerCode = '') => {
  if (!customerCode) return null;
  const digits = String(customerCode).replace(/\D/g, '');
  const id = parseInt(digits, 10);
  return Number.isNaN(id) ? null : id;
};

const buildCustomerName = (row = {}) => {
  return (row.musteri_bilgisi || '').trim();
};

const ensureCustomerColumns = async () => {
  try {
    const [cols] = await pool.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'musteriler'
    `);
    const existing = new Set(cols.map(c => c.COLUMN_NAME.toLowerCase()));
    const alters = [];
    if (!existing.has('password_hash')) {
      alters.push("ALTER TABLE musteriler ADD COLUMN password_hash VARCHAR(255) NULL AFTER sehir");
    }
    if (!existing.has('created_at')) {
      alters.push("ALTER TABLE musteriler ADD COLUMN created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP AFTER password_hash");
    }
    for (const sql of alters) {
      await pool.query(sql);
    }
    if (alters.length) {
      console.log(`[musteriler] Added columns: ${alters.length}`);
    }
  } catch (err) {
    console.error('[musteriler] Column check failed:', err.message);
  }
};

const getNextUnusedCustomerId = async () => {
  const [rows] = await pool.query('SELECT musteri_id FROM musteriler ORDER BY musteri_id ASC');
  let expected = 1;
  for (const row of rows) {
    const id = row.musteri_id;
    if (id > expected) break;
    if (id === expected) expected += 1;
  }
  return expected;
};

// Run one-time column check at startup (non-blocking)
ensureCustomerColumns();

// Customer Register
app.post('/api/customers/register', async (req, res) => {
  try {
    const { firstName, lastName, password, confirmPassword } = req.body;
    const cityRaw = req.body?.city ?? req.body?.sehir ?? '';
    const resolvedCity = String(cityRaw).trim();

    if (!firstName || !lastName || !resolvedCity || !password || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'Ad, soyad, şehir ve şifre alanları zorunludur'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Şifre en az 6 karakter olmalıdır'
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'Şifreler eşleşmiyor'
      });
    }

    console.log('REGISTER BODY:', req.body);
    console.log('REGISTER city resolved:', resolvedCity);

    const passwordHash = await bcrypt.hash(password, 10);
    const displayName = `${firstName.trim()} ${lastName.trim()}`.trim();

    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const nextId = await getNextUnusedCustomerId();
      try {
        await pool.query(
          `INSERT INTO musteriler (musteri_id, musteri_bilgisi, sehir, password_hash, created_at)
           VALUES (?, ?, ?, ?, NOW())`,
          [nextId, displayName, resolvedCity, passwordHash]
        );

        const [verify] = await pool.query(
          'SELECT musteri_id, musteri_bilgisi, sehir FROM musteriler WHERE musteri_id = ?',
          [nextId]
        );
        console.log('REGISTER inserted row:', verify[0]);

        const musteriKodu = `M${String(nextId).padStart(2, '0')}`;
        return res.status(201).json({
          success: true,
          musteriId: nextId,
          musteriKodu,
          musteriAdi: displayName,
          sehir: resolvedCity,
          customerId: nextId,      // backward compatibility
          customerCode: musteriKodu
        });
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY' && attempt < maxAttempts - 1) {
          continue; // retry with a fresh gap
        }
        throw error;
      }
    }

    return res.status(500).json({
      success: false,
      message: 'Kayıt sırasında beklenmedik bir hata oluştu'
    });
  } catch (error) {
    console.error('Customer register error:', error);
    return res.status(500).json({
      success: false,
      message: 'Kayıt sırasında bir hata oluştu'
    });
  }
});

// Static files (Frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Static file serving for uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ============================================
// 🧮 HELPER: BUSINESS DAY COUNT (Hafta içi gün sayısı)
// ============================================

function countBusinessDays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    return 0;
  }

  let count = 0;
  const current = new Date(start);
  while (current <= end) {
    const day = current.getDay(); // 0 = Pazar, 6 = Cumartesi
    if (day !== 0 && day !== 6) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }
  return count;
}

// ============================================
// 🔐 LOGIN API ENDPOINTS
// ============================================

// Admin Login
app.post('/api/login/admin', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (username === 'admin' && password === '123') {
      return res.json({
        success: true,
        role: 'admin',
        redirect: '/admin-dashboard.html'
      });
    }
    
    return res.status(401).json({
      success: false,
      message: 'Geçersiz kullanıcı adı veya şifre'
    });
  } catch (error) {
    console.error('Admin login error:', error);
    return res.status(500).json({
      success: false,
      message: 'Sunucu hatası'
    });
  }
});

// Factory Login
app.post('/api/login/factory', async (req, res) => {
  try {
    const { code, password } = req.body;
    
    if (code === 'F01' && password === '123') {
      return res.json({
        success: true,
        role: 'factory',
        redirect: '/factory-dashboard.html'
      });
    }
    
    return res.status(401).json({
      success: false,
      message: 'Geçersiz fabrika kodu veya şifre'
    });
  } catch (error) {
    console.error('Factory login error:', error);
    return res.status(500).json({
      success: false,
      message: 'Sunucu hatası'
    });
  }
});

// Personnel Login
app.post('/api/login/personnel', async (req, res) => {
  try {
    const { code, password } = req.body;
    
    // Check password first
    if (password !== '123') {
      return res.status(401).json({
        success: false,
        message: 'Geçersiz şifre'
      });
    }
    
    // Extract numeric ID from code (P1, P01, P12 -> 1, 1, 12)
    const numericId = parseInt(code.replace(/\D/g, ''), 10);
    
    if (isNaN(numericId)) {
      return res.status(401).json({
        success: false,
        message: 'Geçersiz personel kodu formatı'
      });
    }
    
    // Query the database
    const [rows] = await pool.query(
      'SELECT * FROM personel WHERE Personel_ID = ?',
      [numericId]
    );
    
    if (rows.length > 0) {
      const row = rows[0];
      const userName = row.personel_ad_soyad;
      return res.json({
        success: true,
        role: 'personnel',
        id: numericId,
        userName: userName,
        redirect: '/personnel-dashboard.html'
      });
    }
    
    return res.status(401).json({
      success: false,
      message: 'Personel bulunamadı'
    });
  } catch (error) {
    console.error('Personnel login error:', error);
    return res.status(500).json({
      success: false,
      message: 'Sunucu hatası'
    });
  }
});

// Customer Login
const handleCustomerLogin = async (req, res) => {
  try {
    const codeInput = (req.body.musteriKodu || req.body.customerCode || req.body.code || '').trim();
    const { password } = req.body;
    const bodyId = req.body.musteriId || req.body.customerId || req.body.id;

    if ((!codeInput && !bodyId) || !password) {
      return res.status(400).json({
        success: false,
        message: 'Müşteri kodu ve şifre gereklidir'
      });
    }

    let numericId = parseCustomerId(codeInput);
    if (!numericId && bodyId) {
      const parsed = parseInt(bodyId, 10);
      numericId = Number.isNaN(parsed) ? null : parsed;
    }

    if (!numericId) {
      return res.status(400).json({
        success: false,
        message: 'Geçersiz müşteri kodu formatı (örn: M12)'
      });
    }

    const [rows] = await pool.query(
      `SELECT musteri_id, musteri_bilgisi, password_hash 
       FROM musteriler 
       WHERE musteri_id = ? 
       LIMIT 1`,
      [numericId]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Müşteri bulunamadı'
      });
    }

    const customer = rows[0];

    if (!customer.password_hash) {
      return res.status(401).json({
        success: false,
        message: 'Bu müşteri için şifre tanımlı değil.'
      });
    }

    const passwordOk = await bcrypt.compare(password, customer.password_hash);
    if (!passwordOk) {
      return res.status(401).json({
        success: false,
        message: 'Müşteri kodu veya şifre hatalı'
      });
    }

    const userName = buildCustomerName(customer) || `M${customer.musteri_id}`;
    const musteriKodu = `M${String(customer.musteri_id).padStart(2, '0')}`;

    return res.json({
      success: true,
      role: 'customer',
      id: customer.musteri_id,
      musteriId: customer.musteri_id,
      musteriKodu,
      musteriAdi: userName,
      customerCode: musteriKodu, // backward compatibility
      userName,
      redirect: '/customer-dashboard.html'
    });
  } catch (error) {
    console.error('Customer login error:', error);
    return res.status(500).json({
      success: false,
      message: 'Sunucu hatası'
    });
  }
};

// New + legacy endpoints share the same handler
app.post('/api/customers/login', handleCustomerLogin);
app.post('/api/login/customer', handleCustomerLogin);

// ============================================
// 📊 ADMIN API ENDPOINTS
// ============================================

// Get all personnel with performance stats
app.get('/api/admin/personnel', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        p.personel_id,
        p.personel_ad_soyad,
        p.aktif_mi,
        COALESCE(COUNT(v.vardiya_id), 0) AS vardiya_sayisi,
        COALESCE(SUM(v.calisilmasi_gereken_dk), 0) AS toplam_planlanan_dk,
        COALESCE(SUM(v.calisilan_dk), 0) AS toplam_calisilan_dk,
        COALESCE(AVG(v.verimlilik), 0) AS ort_verimlilik
      FROM personel p
      LEFT JOIN vardiya_kayit v ON v.personel_id = p.personel_id
      GROUP BY p.personel_id, p.personel_ad_soyad, p.aktif_mi
      ORDER BY p.personel_id
    `);
    
    res.json(rows);
  } catch (error) {
    console.error('Admin personnel error:', error);
    return res.status(500).json({
      success: false,
      message: 'Sunucu hatası'
    });
  }
});

// Get machine fault reports with filters and pagination
app.get('/api/admin/machine-fault-reports', async (req, res) => {
  try {
    const { status, priority, makine_id, page = 1, limit = 20 } = req.query;
    
    const statusFilter = status && status !== 'All' ? status : null;
    const priorityFilter = priority && priority !== 'All' ? priority : null;
    const makineIdFilter = makine_id ? parseInt(makine_id, 10) : null;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 20);
    const offset = (pageNum - 1) * limitNum;
    
    // Build WHERE clause conditions
    const whereConditions = [];
    const queryParams = [];
    
    if (statusFilter) {
      whereConditions.push('r.status = ?');
      queryParams.push(statusFilter);
    }
    if (priorityFilter) {
      whereConditions.push('r.priority = ?');
      queryParams.push(priorityFilter);
    }
    if (makineIdFilter) {
      whereConditions.push('r.makine_id = ?');
      queryParams.push(makineIdFilter);
    }
    
    const whereClause = whereConditions.length > 0 
      ? 'WHERE ' + whereConditions.join(' AND ')
      : '';
    
    // Get total count for pagination
    const [countRows] = await pool.query(`
      SELECT COUNT(*) as total
      FROM machine_fault_reports r
      JOIN makine m ON m.makine_id = r.makine_id
      JOIN personel p ON p.personel_id = r.personel_id
      ${whereClause}
    `, queryParams);
    
    const total = countRows[0]?.total || 0;
    const totalPages = Math.ceil(total / limitNum);
    
    // Get paginated data
    const [rows] = await pool.query(`
      SELECT
        r.report_id,
        r.personel_id,
        p.personel_ad_soyad AS personel_adsoyad,
        r.makine_id,
        m.makine_adi,
        m.makine_turu,
        r.fault_type,
        r.priority,
        r.title,
        r.description,
        r.photo_url,
        r.status,
        r.created_at,
        r.updated_at
      FROM machine_fault_reports r
      JOIN makine m ON m.makine_id = r.makine_id
      JOIN personel p ON p.personel_id = r.personel_id
      ${whereClause}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `, [...queryParams, limitNum, offset]);
    
    res.json({
      success: true,
      data: rows || [],
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: total,
        totalPages: totalPages
      }
    });
  } catch (error) {
    console.error('Admin machine fault reports error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Bildirimler yüklenirken hata oluştu' 
    });
  }
});

// GET /api/admin/machine-fault-reports/:id - Get single fault report detail
app.get('/api/admin/machine-fault-reports/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const reportId = parseInt(id, 10);
    
    if (!reportId || isNaN(reportId)) {
      return res.status(400).json({
        success: false,
        error: 'Geçersiz bildirim ID'
      });
    }
    
    const [rows] = await pool.query(`
      SELECT
        r.report_id,
        r.personel_id,
        p.personel_ad_soyad AS personel_adsoyad,
        r.makine_id,
        m.makine_adi,
        m.makine_turu,
        r.fault_type,
        r.priority,
        r.title,
        r.description,
        r.photo_url,
        r.status,
        r.created_at,
        r.updated_at
      FROM machine_fault_reports r
      JOIN makine m ON m.makine_id = r.makine_id
      JOIN personel p ON p.personel_id = r.personel_id
      WHERE r.report_id = ?
    `, [reportId]);
    
    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Bildirim bulunamadı'
      });
    }
    
    res.json({
      success: true,
      data: rows[0]
    });
  } catch (error) {
    console.error('Admin machine fault report detail error:', error);
    res.status(500).json({
      success: false,
      error: 'Bildirim detayı yüklenirken hata oluştu'
    });
  }
});

// PATCH /api/admin/machine-fault-reports/:id - Update fault report status
app.patch('/api/admin/machine-fault-reports/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const reportId = parseInt(id, 10);
    
    if (!reportId || isNaN(reportId)) {
      return res.status(400).json({
        success: false,
        error: 'Geçersiz bildirim ID'
      });
    }
    
    const validStatuses = ['Açık', 'İşlemde', 'Çözüldü', 'İptal'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Geçersiz durum değeri'
      });
    }
    
    const [result] = await pool.query(`
      UPDATE machine_fault_reports
      SET status = ?, updated_at = NOW()
      WHERE report_id = ?
    `, [status, reportId]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Bildirim bulunamadı'
      });
    }
    
    res.json({
      success: true,
      message: 'Durum başarıyla güncellendi'
    });
  } catch (error) {
    console.error('Admin machine fault report update error:', error);
    res.status(500).json({
      success: false,
      error: 'Durum güncellenirken hata oluştu'
    });
  }
});

// Get machine fault distribution for chart
app.get('/api/admin/machine-faults/distribution', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 3;

    const [rows] = await pool.query(`
      SELECT
        mk.makine_adi AS label,
        COUNT(*) AS value
      FROM machine_fault_reports mfr
      JOIN makine mk ON mk.makine_id = mfr.makine_id
      WHERE mfr.created_at >= NOW() - INTERVAL ? MONTH
      GROUP BY mk.makine_id, mk.makine_adi
      ORDER BY value DESC
      LIMIT 8
    `, [months]);

    console.log("[machine-distribution] months=", months, "rows=", rows.length);

    if (rows.length === 0) {
      const [maxDateRows] = await pool.query(`SELECT MAX(created_at) AS maxDate FROM machine_fault_reports`);
      console.log("[machine-distribution] No data, max created_at:", maxDateRows[0]?.maxDate);
    }

    const data = rows.map(row => ({
      label: row.label || 'Bilinmiyor',
      value: Number(row.value) || 0
    }));

    res.json({
      success: true,
      data: data
    });
  } catch (error) {
    console.error('Machine fault distribution error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get fault type distribution for chart
app.get('/api/admin/machine-faults/type-distribution', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 3;

    const [rows] = await pool.query(`
      SELECT
        mfr.fault_type AS label,
        COUNT(*) AS value
      FROM machine_fault_reports mfr
      WHERE mfr.created_at >= NOW() - INTERVAL ? MONTH
      GROUP BY mfr.fault_type
      ORDER BY value DESC
    `, [months]);

    console.log("[type-distribution] months=", months, "rows=", rows.length);

    if (rows.length === 0) {
      const [maxDateRows] = await pool.query(`SELECT MAX(created_at) AS maxDate FROM machine_fault_reports`);
      console.log("[type-distribution] No data, max created_at:", maxDateRows[0]?.maxDate);
    }

    const data = rows.map(row => ({
      label: row.label || 'Bilinmiyor',
      value: Number(row.value) || 0
    }));

    res.json({
      success: true,
      data: data
    });
  } catch (error) {
    console.error('Fault type distribution error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get personnel distribution for chart
app.get('/api/admin/machine-faults/personnel-distribution', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 3;

    const [rows] = await pool.query(`
      SELECT
        COALESCE(p.personel_ad_soyad, CONCAT('Personel #', mfr.personel_id)) AS label,
        COUNT(*) AS value
      FROM machine_fault_reports mfr
      LEFT JOIN personel p ON p.personel_id = mfr.personel_id
      WHERE mfr.created_at >= NOW() - INTERVAL ? MONTH
      GROUP BY mfr.personel_id, label
      ORDER BY value DESC
      LIMIT 10
    `, [months]);

    console.log("[personnel-distribution] months=", months, "rows=", rows.length);

    if (rows.length === 0) {
      const [maxDateRows] = await pool.query(`SELECT MAX(created_at) AS maxDate FROM machine_fault_reports`);
      console.log("[personnel-distribution] No data, max created_at:", maxDateRows[0]?.maxDate);
    }

    const data = rows.map(row => ({
      label: row.label || 'Bilinmiyor',
      value: Number(row.value) || 0
    }));

    res.json({
      success: true,
      data: data
    });
  } catch (error) {
    console.error('Personnel distribution error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Update machine fault report status
app.patch('/api/admin/machine-fault-reports/:report_id', async (req, res) => {
  try {
    const { report_id } = req.params;
    const { status } = req.body;
    
    const validStatuses = ['Açık', 'İşlemde', 'Çözüldü', 'İptal'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: 'Geçersiz durum. Geçerli değerler: ' + validStatuses.join(', ') 
      });
    }
    
    const [result] = await pool.query(`
      UPDATE machine_fault_reports 
      SET status = ?, updated_at = NOW() 
      WHERE report_id = ?
    `, [status, report_id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Bildirim bulunamadı' });
    }
    
    res.json({ 
      success: true, 
      message: 'Durum güncellendi',
      report_id: parseInt(report_id, 10),
      status: status
    });
  } catch (error) {
    console.error('Update machine fault report error:', error);
    res.status(500).json({ error: 'Durum güncellenirken hata oluştu' });
  }
});

// Get personnel-machine pairing statistics (top pairs and lift pairs)
app.get('/api/admin/machine-faults/pairing-stats', async (req, res) => {
  try {
    const range = req.query.range || '3m';
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 10));
    
    // Build date filter based on range
    let dateFilter = '';
    const rangeMap = {
      '1m': 'INTERVAL 1 MONTH',
      '3m': 'INTERVAL 3 MONTH',
      '6m': 'INTERVAL 6 MONTH',
      '12m': 'INTERVAL 12 MONTH',
      'all': null
    };
    
    const interval = rangeMap[range] || rangeMap['3m'];
    if (interval) {
      dateFilter = `WHERE r.created_at >= DATE_SUB(NOW(), ${interval})`;
    }
    
    // Top Pairs Query
    const topPairsQuery = `
      SELECT
        r.personel_id,
        r.makine_id,
        p.personel_ad_soyad AS personel_name,
        m.makine_adi AS makine_name,
        COUNT(*) AS count
      FROM machine_fault_reports r
      JOIN personel p ON p.personel_id = r.personel_id
      JOIN makine m ON m.makine_id = r.makine_id
      ${dateFilter}
      GROUP BY r.personel_id, r.makine_id, p.personel_ad_soyad, m.makine_adi
      ORDER BY count DESC
      LIMIT ?
    `;
    
    const [topPairsRows] = await pool.query(topPairsQuery, [limit]);
    
    // Lift Pairs Query using CTE
    const liftPairsQuery = `
      WITH filtered AS (
        SELECT personel_id, makine_id
        FROM machine_fault_reports r
        ${dateFilter}
      ),
      overall AS (
        SELECT COUNT(*) AS overall_total FROM filtered
      ),
      pt AS (
        SELECT personel_id, COUNT(*) AS personel_total
        FROM filtered
        GROUP BY personel_id
      ),
      mt AS (
        SELECT makine_id, COUNT(*) AS makine_total
        FROM filtered
        GROUP BY makine_id
      ),
      pairs AS (
        SELECT personel_id, makine_id, COUNT(*) AS pair_count
        FROM filtered
        GROUP BY personel_id, makine_id
        HAVING pair_count >= 2
      )
      SELECT
        pairs.personel_id,
        pairs.makine_id,
        p.personel_ad_soyad AS personel_name,
        m.makine_adi AS makine_name,
        pairs.pair_count AS count,
        CASE 
          WHEN overall.overall_total > 0 THEN
            (pt.personel_total * mt.makine_total) / overall.overall_total
          ELSE 0
        END AS expected,
        CASE 
          WHEN overall.overall_total > 0 AND (pt.personel_total * mt.makine_total) > 0 THEN
            pairs.pair_count / ((pt.personel_total * mt.makine_total) / overall.overall_total)
          ELSE 0
        END AS lift
      FROM pairs
      JOIN pt ON pt.personel_id = pairs.personel_id
      JOIN mt ON mt.makine_id = pairs.makine_id
      CROSS JOIN overall
      JOIN personel p ON p.personel_id = pairs.personel_id
      JOIN makine m ON m.makine_id = pairs.makine_id
      ORDER BY lift DESC
      LIMIT ?
    `;
    
    const [liftPairsRows] = await pool.query(liftPairsQuery, [limit]);
    
    // Round expected and lift values
    const topPairs = topPairsRows.map(row => ({
      personel_id: row.personel_id,
      makine_id: row.makine_id,
      personel_name: row.personel_name,
      makine_name: row.makine_name,
      count: Number(row.count) || 0
    }));
    
    const liftPairs = liftPairsRows.map(row => ({
      personel_id: row.personel_id,
      makine_id: row.makine_id,
      personel_name: row.personel_name,
      makine_name: row.makine_name,
      count: Number(row.count) || 0,
      expected: Math.round((Number(row.expected) || 0) * 100) / 100,
      lift: Math.round((Number(row.lift) || 0) * 100) / 100
    }));
    
    res.json({
      success: true,
      data: {
        topPairs,
        liftPairs
      }
    });
  } catch (error) {
    console.error('Pairing stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Eşleşme istatistikleri yüklenirken hata oluştu: ' + error.message
    });
  }
});

// Get machine fault summary (personnel list + overall KPIs)
app.get('/api/machine-fault/summary', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 3;
    
    // Validate months parameter
    if (months !== 1 && months !== 3) {
      return res.status(400).json({ 
        error: 'months parametresi sadece 1 veya 3 olabilir' 
      });
    }

    // Get personnel summary with report counts
    const [personnelRows] = await pool.query(`
      SELECT
        p.personel_id,
        p.personel_ad_soyad,
        COUNT(r.report_id) AS total_reports,
        COUNT(DISTINCT r.makine_id) AS unique_machines
      FROM personel p
      LEFT JOIN machine_fault_reports r
        ON r.personel_id = p.personel_id
        AND r.created_at >= DATE_SUB(NOW(), INTERVAL ? MONTH)
      WHERE p.aktif_mi = 1
      GROUP BY p.personel_id, p.personel_ad_soyad
      ORDER BY total_reports DESC
    `, [months]);

    // Get overall totals
    const [overallRows] = await pool.query(`
      SELECT
        COUNT(*) AS total_reports,
        COUNT(DISTINCT makine_id) AS unique_machines
      FROM machine_fault_reports
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? MONTH)
    `, [months]);

    const overall = overallRows[0] || { total_reports: 0, unique_machines: 0 };

    res.json({
      success: true,
      personnel: personnelRows.map(row => ({
        personel_id: row.personel_id,
        personel_ad_soyad: row.personel_ad_soyad,
        total_reports: Number(row.total_reports) || 0,
        unique_machines: Number(row.unique_machines) || 0
      })),
      overall: {
        total_reports: Number(overall.total_reports) || 0,
        unique_machines: Number(overall.unique_machines) || 0
      },
      months: months
    });
  } catch (error) {
    console.error('Machine fault summary error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Özet veriler yüklenirken hata oluştu: ' + error.message 
    });
  }
});

// Get machine breakdown and recent reports
app.get('/api/machine-fault/breakdown', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 3;
    const personelIdParam = req.query.personel_id;
    
    // Validate months parameter
    if (months !== 1 && months !== 3) {
      return res.status(400).json({ 
        error: 'months parametresi sadece 1 veya 3 olabilir' 
      });
    }

    const isAll = !personelIdParam || personelIdParam === 'ALL';
    const personelId = isAll ? null : parseInt(personelIdParam, 10);

    if (!isAll && (isNaN(personelId) || personelId <= 0)) {
      return res.status(400).json({ 
        error: 'Geçersiz personel_id parametresi' 
      });
    }

    // Machine breakdown query
    let machineBreakdownQuery = `
      SELECT
        m.makine_id,
        m.makine_adi,
        COUNT(r.report_id) AS report_count,
        MAX(r.created_at) AS last_report_at
      FROM machine_fault_reports r
      JOIN makine m ON m.makine_id = r.makine_id
      WHERE r.created_at >= DATE_SUB(NOW(), INTERVAL ? MONTH)
    `;
    const machineParams = [months];

    if (!isAll) {
      machineBreakdownQuery += ' AND r.personel_id = ?';
      machineParams.push(personelId);
    }

    machineBreakdownQuery += `
      GROUP BY m.makine_id, m.makine_adi
      ORDER BY report_count DESC
    `;

    const [machineRows] = await pool.query(machineBreakdownQuery, machineParams);

    // Recent reports query
    let recentReportsQuery = `
      SELECT
        r.report_id,
        r.created_at,
        r.fault_type,
        r.priority,
        r.status,
        r.title,
        r.description,
        p.personel_ad_soyad,
        m.makine_adi
      FROM machine_fault_reports r
      JOIN personel p ON p.personel_id = r.personel_id
      JOIN makine m ON m.makine_id = r.makine_id
      WHERE r.created_at >= DATE_SUB(NOW(), INTERVAL ? MONTH)
    `;
    const recentParams = [months];

    if (!isAll) {
      recentReportsQuery += ' AND r.personel_id = ?';
      recentParams.push(personelId);
    }

    recentReportsQuery += `
      ORDER BY r.created_at DESC
      LIMIT 50
    `;

    const [recentRows] = await pool.query(recentReportsQuery, recentParams);

    res.json({
      success: true,
      machine_breakdown: machineRows.map(row => ({
        makine_id: row.makine_id,
        makine_adi: row.makine_adi,
        report_count: Number(row.report_count) || 0,
        last_report_at: row.last_report_at
      })),
      recent_reports: recentRows.map(row => ({
        report_id: row.report_id,
        created_at: row.created_at,
        fault_type: row.fault_type,
        priority: row.priority,
        status: row.status,
        title: row.title,
        description: row.description,
        personel_ad_soyad: row.personel_ad_soyad,
        makine_adi: row.makine_adi
      })),
      months: months,
      personel_id: isAll ? 'ALL' : personelId
    });
  } catch (error) {
    console.error('Machine fault breakdown error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Detay veriler yüklenirken hata oluştu: ' + error.message 
    });
  }
});

// Get recent machine fault reports with pagination
app.get('/api/machine-fault/recent-reports', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 3;
    const personelIdParam = req.query.personel_id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const offset = (page - 1) * limit;
    
    // Validate months parameter
    if (months !== 1 && months !== 3) {
      return res.status(400).json({ 
        success: false,
        error: 'months parametresi sadece 1 veya 3 olabilir' 
      });
    }

    const isAll = !personelIdParam || personelIdParam === 'ALL';
    const personelId = isAll ? null : parseInt(personelIdParam, 10);

    if (!isAll && (isNaN(personelId) || personelId <= 0)) {
      return res.status(400).json({ 
        success: false,
        error: 'Geçersiz personel_id parametresi' 
      });
    }

    // Build WHERE clause
    let whereClause = 'WHERE r.created_at >= DATE_SUB(NOW(), INTERVAL ? MONTH)';
    const queryParams = [months];

    if (!isAll) {
      whereClause += ' AND r.personel_id = ?';
      queryParams.push(personelId);
    }

    // Get total count
    const [countRows] = await pool.query(`
      SELECT COUNT(*) AS total
      FROM machine_fault_reports r
      ${whereClause}
    `, queryParams);
    
    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.ceil(total / limit);

    // Get paginated data
    const [rows] = await pool.query(`
      SELECT
        r.report_id,
        r.created_at,
        r.fault_type,
        r.priority,
        r.status,
        r.title,
        r.description,
        p.personel_ad_soyad,
        m.makine_adi
      FROM machine_fault_reports r
      JOIN personel p ON p.personel_id = r.personel_id
      JOIN makine m ON m.makine_id = r.makine_id
      ${whereClause}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `, [...queryParams, limit, offset]);

    res.json({
      success: true,
      data: rows.map(row => ({
        report_id: row.report_id,
        created_at: row.created_at,
        fault_type: row.fault_type,
        priority: row.priority,
        status: row.status,
        title: row.title,
        description: row.description,
        personel_ad_soyad: row.personel_ad_soyad,
        makine_adi: row.makine_adi
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error('Recent reports pagination error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Son bildirimler yüklenirken hata oluştu: ' + error.message 
    });
  }
});

// ============================================
// ⚙️ PRODUCTION MANAGEMENT API ENDPOINTS
// ============================================

// Get all available raw materials (for dropdown)
app.get('/api/raw-materials', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT hammadde_id, hammadde_adi, birim, aktif_mi
      FROM hammadde
      WHERE aktif_mi = 1
      ORDER BY hammadde_adi
    `);
    res.json(rows);
  } catch (error) {
    console.error('Raw materials error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Get all raw material orders (used by admin / Gündoğdu panel) with pagination
// Same data source as factory endpoint - hammadde_siparisleri table
app.get('/api/raw-material-orders', async (req, res) => {
  try {
    // Parse pagination params
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const offset = (page - 1) * limit;
    const searchTerm = req.query.search ? String(req.query.search).trim() : null;
    
    // Build WHERE clause for search
    const hasSearch = searchTerm && searchTerm.length > 0;
    const searchCondition = hasSearch
      ? `h.hammadde_adi LIKE CONCAT('%', ?, '%')`
      : '1=1';
    
    const searchParams = hasSearch ? [searchTerm] : [];
    
    // Get total count
    const [countRows] = await pool.query(`
      SELECT COUNT(*) AS totalCount
      FROM hammadde_siparisleri hs
      JOIN hammadde h ON h.hammadde_id = hs.hammadde_id
      WHERE ${searchCondition}
    `, searchParams);
    
    const totalCount = Number(countRows[0]?.totalCount || 0);
    const totalPages = Math.ceil(totalCount / limit);
    
    // Get paginated data
    // IMPORTANT: No status filter - show all orders including new BEKLEMEDE orders
    const [rows] = await pool.query(`
      SELECT 
        hs.siparis_id      AS id,
        hs.hammadde_id     AS hammadde_id,
        h.hammadde_adi     AS malzeme_adi,
        h.birim            AS birim,
        hs.miktar          AS miktar,
        DATE_FORMAT(hs.siparis_tarihi, '%Y-%m-%d') AS siparis_tarihi,
        hs.durum           AS durum
      FROM hammadde_siparisleri hs
      JOIN hammadde h ON h.hammadde_id = hs.hammadde_id
      WHERE ${searchCondition}
      ORDER BY hs.siparis_tarihi DESC, hs.siparis_id DESC
      LIMIT ? OFFSET ?
    `, [...searchParams, limit, offset]);
    
    console.log('GET /api/raw-material-orders: fetched', rows.length, 'rows, page', page, 'of', totalPages, 'total:', totalCount);
    if (rows.length > 0) {
      console.log('First row siparis_id:', rows[0].id, 'durum:', rows[0].durum, 'malzeme_adi:', rows[0].malzeme_adi);
    }
    
    res.json({
      success: true,
      data: rows || [],
      pagination: {
        page: page,
        limit: limit,
        totalCount: totalCount,
        totalPages: totalPages
      }
    });
  } catch (error) {
    console.error('Raw material orders error:', error);
    return res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Legacy function kept for backward compatibility (if needed elsewhere)
const listRawMaterialOrders = async () => {
  const [rows] = await pool.query(`
    SELECT 
      hs.siparis_id      AS id,
      hs.hammadde_id     AS hammadde_id,
      h.hammadde_adi     AS malzeme_adi,
      h.birim            AS birim,
      hs.miktar          AS miktar,
      hs.siparis_tarihi  AS siparis_tarihi,
      hs.durum           AS durum
    FROM hammadde_siparisleri hs
    JOIN hammadde h ON h.hammadde_id = hs.hammadde_id
    ORDER BY hs.siparis_id DESC
    LIMIT 500
  `);
  console.log('GET hammadde_siparisleri rows:', rows.length, 'latestId:', rows[0]?.id);
  return rows || [];
};

const createRawMaterialOrder = async (req, res) => {
  try {
    const { hammadde_id, miktar, hammaddeId, miktarKg, siparisTarihi } = req.body || {};
    console.log('RAW ORDER BODY:', req.body);

    const hammaddeIdFinal = hammadde_id || hammaddeId;
    const miktarFinal = miktar || miktarKg;

    if (!hammaddeIdFinal || !miktarFinal) {
      return res.status(400).json({ success: false, message: 'hammadde_id ve miktar gereklidir' });
    }

    // Use CURDATE() for consistent date handling, or provided date
    const today = siparisTarihi || null;

    const insertSql = today
      ? `INSERT INTO hammadde_siparisleri (hammadde_id, miktar, siparis_tarihi, durum) VALUES (?, ?, ?, 'BEKLEMEDE')`
      : `INSERT INTO hammadde_siparisleri (hammadde_id, miktar, siparis_tarihi, durum) VALUES (?, ?, CURDATE(), 'BEKLEMEDE')`;
    
    const insertParams = today
      ? [hammaddeIdFinal, miktarFinal, today]
      : [hammaddeIdFinal, miktarFinal];

    console.log('RAW ORDER INSERT params:', insertParams);

    const [result] = await pool.query(insertSql, insertParams);
    console.log('RAW ORDER result:', { affectedRows: result.affectedRows, insertId: result.insertId });

    if (result.affectedRows !== 1) {
      return res.status(500).json({ success: false, message: 'Sipariş kaydedilemedi' });
    }

    const insertedId = result.insertId;

    const [createdRows] = await pool.query(`
      SELECT 
        hs.siparis_id      AS id,
        hs.hammadde_id     AS hammadde_id,
        h.hammadde_adi     AS malzeme_adi,
        h.birim            AS birim,
        hs.miktar          AS miktar,
        hs.siparis_tarihi  AS siparis_tarihi,
        hs.durum           AS durum
      FROM hammadde_siparisleri hs
      JOIN hammadde h ON h.hammadde_id = hs.hammadde_id
      WHERE hs.siparis_id = ?
      LIMIT 1
    `, [insertedId]);

    console.log('RAW ORDER inserted row:', createdRows && createdRows[0]);
    console.log('RAW ORDER created with siparis_id:', insertedId, 'durum: BEKLEMEDE');

    const createdOrder = createdRows && createdRows[0] ? createdRows[0] : null;
    
    res.status(201).json({ 
      success: true, 
      message: 'Hammadde siparişi oluşturuldu',
      order: createdOrder || { id: insertedId },
      siparis_id: insertedId
    });
  } catch (error) {
    console.error('Create raw material order error (full):', error);
    const msg = error?.sqlMessage || error?.message || 'Sipariş oluşturulamadı';
    return res.status(500).json({ success: false, message: msg });
  }
};

// Create new raw material order (Gündoğdu panel)
app.post('/api/raw-material-orders', createRawMaterialOrder);
// Unified creation endpoint
app.post('/api/hammadde-siparisleri', createRawMaterialOrder);

// Debug endpoint - latest 5 raw material orders
app.get('/api/hammadde-siparisleri/debug/latest', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        hs.siparis_id AS id,
        hs.hammadde_id,
        h.hammadde_adi AS malzeme_adi,
        hs.miktar,
        h.birim,
        hs.siparis_tarihi,
        hs.durum
      FROM hammadde_siparisleri hs
      LEFT JOIN hammadde h ON h.hammadde_id = hs.hammadde_id
      ORDER BY hs.siparis_id DESC
      LIMIT 5
    `);
    res.json(rows || []);
  } catch (error) {
    console.error('Debug raw material orders error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Update raw material order
app.put('/api/raw-material-orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { hammadde_id, miktar, siparis_tarihi, durum } = req.body;
    
    const [result] = await pool.query(`
      UPDATE hammadde_siparisleri 
      SET hammadde_id = ?, miktar = ?, siparis_tarihi = ?, durum = ?
      WHERE siparis_id = ?
    `, [hammadde_id, miktar, siparis_tarihi, durum, id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Sipariş bulunamadı' });
    }
    
    res.json({ success: true, message: 'Sipariş güncellendi' });
  } catch (error) {
    console.error('Update raw material order error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Delete raw material order
app.delete('/api/raw-material-orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [result] = await pool.query(`
      DELETE FROM hammadde_siparisleri WHERE siparis_id = ?
    `, [id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Sipariş bulunamadı' });
    }
    
    res.json({ success: true, message: 'Sipariş silindi' });
  } catch (error) {
    console.error('Delete raw material order error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// 🏭 FACTORY API ENDPOINTS
// ============================================

// Update raw material order status (for factory panel)
app.put('/api/factory/raw-material-orders/:id/status', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const incomingDurum = (req.body.durum || '').toString().trim();

    // Normalize incoming status (e.g., "Teslim Edildi" -> "TESLIMEDILDI")
    const normalizedMap = {
      'TESLIMEDILDI': 'TESLIMEDILDI',
      'TESLIM EDILDI': 'TESLIMEDILDI',
      'TESLİM EDİLDİ': 'TESLIMEDILDI',
      'TESLİMEDİLDİ': 'TESLIMEDILDI',
      'TESLIMEDILDI': 'TESLIMEDILDI',
      'BEKLEMEDE': 'BEKLEMEDE',
      'ONAYLANDI': 'ONAYLANDI',
      'HAZIRLANIYOR': 'HAZIRLANIYOR'
    };
    const incomingUpper = incomingDurum.toUpperCase();
    const newStatus = normalizedMap[incomingUpper] || incomingUpper.replace(/\s+/g, '');

    const validStatuses = ['BEKLEMEDE', 'HAZIRLANIYOR', 'ONAYLANDI', 'TESLIMEDILDI'];
    if (!validStatuses.includes(newStatus)) {
      connection.release();
      return res.status(400).json({ error: 'Geçersiz durum değeri' });
    }

    await connection.beginTransaction();

    // Lock the order row to read current status and quantities
    const [currentRows] = await connection.query(`
      SELECT hammadde_id, miktar, durum AS current_status
      FROM hammadde_siparisleri
      WHERE siparis_id = ?
      FOR UPDATE
    `, [id]);

    if (!currentRows || currentRows.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ error: 'Sipariş bulunamadı' });
    }

    const { hammadde_id, miktar, current_status } = currentRows[0];
    console.log('[Factory Status Update] siparis_id:', id, 'oldStatus:', current_status, 'newStatus:', newStatus, 'hammadde_id:', hammadde_id, 'miktar:', miktar);

    // Always update the status first
    const [result] = await connection.query(`
      UPDATE hammadde_siparisleri 
      SET durum = ?
      WHERE siparis_id = ?
    `, [newStatus, id]);

    if (result.affectedRows === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ error: 'Sipariş bulunamadı' });
    }

    const isFirstDeliver = current_status !== 'TESLIMEDILDI' && newStatus === 'TESLIMEDILDI' && hammadde_id;

    if (isFirstDeliver) {
      // Decrease stock only on first transition to TESLIMEDILDI; trigger handles critical stock warnings/auto-orders
      const [stockResult] = await connection.query(`
        UPDATE hammadde_stok
        SET mevcut_miktar = GREATEST(COALESCE(mevcut_miktar,0) - ?, 0)
        WHERE hammadde_id = ?
      `, [Number(miktar) || 0, hammadde_id]);
      console.log('[Stock Decrement]', { affectedRows: stockResult.affectedRows, hammadde_id, miktar: Number(miktar) || 0 });

      // Optional movement log
      await connection.query(`
        INSERT INTO hammadde_hareketleri (hammadde_id, tarih, hareket_tipi, miktar, aciklama)
        VALUES (?, NOW(), 'CIKIS', ?, CONCAT('Siparis TESLIMEDILDI #', ?))
      `, [hammadde_id, Number(miktar) || 0, id]);
    }

    await connection.commit();
    connection.release();

    res.json({ success: true, message: 'Durum güncellendi', stockUpdated: !!isFirstDeliver });
  } catch (error) {
    console.error('Update order status error:', error);
    try { await connection.rollback(); } catch (e) { /* ignore */ }
    connection.release();
    return res.status(500).json({ error: error.message });
  }
});

// Dedicated deliver endpoint for factory panel - force TESLIMEDILDI with stock decrement and hareket log
app.put('/api/fabrika/hammadde-siparisleri/:id/teslim', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    await connection.beginTransaction();

    // Lock order row
    const [currentRows] = await connection.query(`
      SELECT hammadde_id, miktar, durum AS current_status
      FROM hammadde_siparisleri
      WHERE siparis_id = ?
      FOR UPDATE
    `, [id]);

    if (!currentRows || currentRows.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ error: 'Sipariş bulunamadı' });
    }

    const { hammadde_id, miktar, current_status } = currentRows[0];
    const newStatus = 'TESLIMEDILDI';
    const isFirstDeliver = current_status !== 'TESLIMEDILDI' && hammadde_id;

    // Update status (always set to TESLIMEDILDI)
    await connection.query(`
      UPDATE hammadde_siparisleri
      SET durum = ?
      WHERE siparis_id = ?
    `, [newStatus, id]);

    if (isFirstDeliver) {
      // Decrease stock only on first delivery; trigger handles critical stock warnings/auto-orders
      await connection.query(`
        UPDATE hammadde_stok
        SET mevcut_miktar = GREATEST(COALESCE(mevcut_miktar,0) - ?, 0)
        WHERE hammadde_id = ?
      `, [Number(miktar) || 0, hammadde_id]);

      await connection.query(`
        INSERT INTO hammadde_hareketleri (hammadde_id, tarih, hareket_tipi, miktar, aciklama)
        VALUES (?, NOW(), 'CIKIS', ?, CONCAT('Fabrika siparisi TESLIMEDILDI #', ?))
      `, [hammadde_id, Number(miktar) || 0, id]);
    }

    await connection.commit();
    connection.release();

    res.json({ success: true, message: 'Sipariş teslim edildi', stockUpdated: !!isFirstDeliver });
  } catch (error) {
    console.error('Deliver order error:', error);
    try { await connection.rollback(); } catch (e) { /* ignore */ }
    connection.release();
    return res.status(500).json({ error: error.message });
  }
});

// Helper function to add N business days (excluding Saturday and Sunday)
function addBusinessDays(date, days) {
  const result = new Date(date);
  let added = 0;

  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay(); // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) {
      added++;
    }
  }

  return result;
}

// Get all raw material orders for factory panel (incoming)
// Uses the same hammadde_siparisleri table as the admin panel
app.get('/api/factory/raw-material-orders', async (req, res) => {
  try {
    // Query with correct table joins and field mapping
    const [rows] = await pool.query(`
      SELECT
        hs.siparis_id AS id,
        h.hammadde_adi AS malzeme_adi,
        hs.miktar AS miktar,
        h.birim AS birim,
        hs.siparis_tarihi AS siparis_tarihi,
        DATE_ADD(hs.siparis_tarihi, INTERVAL 7 DAY) AS tahmini_teslim_tarihi,
        hs.durum AS durum
      FROM hammadde_siparisleri hs
      JOIN hammadde h ON h.hammadde_id = hs.hammadde_id
      ORDER BY hs.siparis_tarihi DESC, hs.siparis_id DESC
    `);
    
    console.log('[Factory raw-material-orders] Found orders:', rows.length);
    if (rows.length > 0) {
      console.log('[Factory raw-material-orders] First order:', {
        id: rows[0].id,
        malzeme_adi: rows[0].malzeme_adi,
        durum: rows[0].durum
      });
    }
    
    // Format dates for frontend
    const processedRows = rows.map(row => ({
      id: row.id,
      siparis_id: row.id,
      malzeme_adi: row.malzeme_adi,
      miktar: row.miktar,
      birim: row.birim,
      siparis_tarihi: row.siparis_tarihi,
      siparisTarihi: formatDateTR(row.siparis_tarihi) || new Date(row.siparis_tarihi).toISOString(),
      tahmini_teslim_tarihi: row.tahmini_teslim_tarihi,
      tahminiTeslimTarihi: formatDateTR(row.tahmini_teslim_tarihi) || new Date(row.tahmini_teslim_tarihi).toISOString().split('T')[0],
      durum: row.durum
    }));
    
    res.json(processedRows || []);
  } catch (error) {
    console.error('Factory raw material orders error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Get summary stats for factory raw material orders
app.get('/api/factory/raw-material-orders/summary', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        COUNT(*) AS toplam_siparis,
        SUM(hs.durum IN ('BEKLEMEDE', 'ONAYLANDI')) AS bekleyen,
        SUM(hs.durum = 'HAZIRLANIYOR') AS hazirlaniyor,
        SUM(hs.durum = 'TESLIMEDILDI') AS teslim_edildi
      FROM hammadde_siparisleri hs
    `);
    
    const stats = rows[0] || {};
    res.json({
      success: true,
      data: {
        total: Number(stats.toplam_siparis || 0),
        pending: Number(stats.bekleyen || 0),
        preparing: Number(stats.hazirlaniyor || 0),
        delivered: Number(stats.teslim_edildi || 0)
      }
    });
  } catch (error) {
    console.error('Factory raw material orders summary error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Helper: format date dd.MM.yyyy
function formatDateTR(date) {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

// Unified endpoint - lists all hammadde siparisleri (no factory filter) with pagination
app.get('/api/hammadde-siparisleri', async (req, res) => {
  try {
    // Parse pagination params
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const offset = (page - 1) * limit;
    const searchTerm = req.query.search ? String(req.query.search).trim() : null;
    
    // Build WHERE clause for search
    const hasSearch = searchTerm && searchTerm.length > 0;
    const searchCondition = hasSearch
      ? `h.hammadde_adi LIKE CONCAT('%', ?, '%')`
      : '1=1';
    
    const searchParams = hasSearch ? [searchTerm] : [];
    
    // Get total count
    const [countRows] = await pool.query(`
      SELECT COUNT(*) AS totalCount
      FROM hammadde_siparisleri hs
      JOIN hammadde h ON h.hammadde_id = hs.hammadde_id
      WHERE ${searchCondition}
    `, searchParams);
    
    const totalCount = Number(countRows[0]?.totalCount || 0);
    const totalPages = Math.ceil(totalCount / limit);
    
    // Get paginated data
    // IMPORTANT: No status filter - show all orders including new BEKLEMEDE orders
    const [rows] = await pool.query(`
      SELECT 
        hs.siparis_id      AS id,
        hs.hammadde_id     AS hammadde_id,
        h.hammadde_adi     AS malzeme_adi,
        h.birim            AS birim,
        hs.miktar          AS miktar,
        DATE_FORMAT(hs.siparis_tarihi, '%Y-%m-%d') AS siparis_tarihi,
        hs.durum           AS durum
      FROM hammadde_siparisleri hs
      JOIN hammadde h ON h.hammadde_id = hs.hammadde_id
      WHERE ${searchCondition}
      ORDER BY hs.siparis_tarihi DESC, hs.siparis_id DESC
      LIMIT ? OFFSET ?
    `, [...searchParams, limit, offset]);
    
    console.log('GET /api/hammadde-siparisleri: fetched', rows.length, 'rows, page', page, 'of', totalPages, 'total:', totalCount);
    if (rows.length > 0) {
      console.log('First row siparis_id:', rows[0].id, 'durum:', rows[0].durum, 'malzeme_adi:', rows[0].malzeme_adi);
    }

    const mapped = rows.map(r => {
      const tahmini = r.siparis_tarihi ? addBusinessDays(r.siparis_tarihi, 7) : null;
      const isoDate = r.siparis_tarihi ? new Date(r.siparis_tarihi).toISOString() : null;
      return {
        id: r.id,
        siparis_id: r.id,
        siparisId: r.id,
        hammadde_id: r.hammadde_id,
        hammaddeId: r.hammadde_id,
        malzeme_adi: r.malzeme_adi,
        malzemeAdi: r.malzeme_adi,
        miktar: r.miktar,
        birim: r.birim,
        siparis_tarihi: r.siparis_tarihi,
        siparisTarihi: formatDateTR(r.siparis_tarihi) || isoDate,
        tahminiTeslimTarihi: formatDateTR(tahmini),
        durum: r.durum
      };
    });

    // Return paginated response
    res.json({
      success: true,
      data: mapped || [],
      pagination: {
        page: page,
        limit: limit,
        totalCount: totalCount,
        totalPages: totalPages
      }
    });
  } catch (error) {
    console.error('Hammadde siparisleri error:', error);
    return res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Get summary stats for raw material orders (Gündoğdu Admin panel)
// IMPORTANT: Counts must be from the entire table, not just visible page
app.get('/api/hammadde-siparisleri/summary', async (req, res) => {
  try {
    // Count from hammadde_siparisleri table ONLY (no joins to avoid duplication)
    const [rows] = await pool.query(`
      SELECT
        COUNT(*) AS toplam,
        SUM(CASE WHEN durum = 'BEKLEMEDE' THEN 1 ELSE 0 END) AS bekleyen,
        SUM(CASE WHEN durum IN ('ONAYLANDI', 'HAZIRLANIYOR') THEN 1 ELSE 0 END) AS uretimde,
        SUM(CASE WHEN durum = 'TESLIMEDILDI' THEN 1 ELSE 0 END) AS teslim_edildi
      FROM hammadde_siparisleri
    `);
    
    const stats = rows[0] || {};
    const toplam = Number(stats.toplam || 0);
    const bekleyen = Number(stats.bekleyen || 0);
    const uretimde = Number(stats.uretimde || 0);
    const teslim_edildi = Number(stats.teslim_edildi || 0);
    
    // Verification: toplam should equal sum of all statuses
    const sumOfStatuses = bekleyen + uretimde + teslim_edildi;
    const otherStatuses = toplam - sumOfStatuses;
    
    if (otherStatuses > 0) {
      console.log('[hammadde-siparisleri/summary] WARNING: There are', otherStatuses, 'orders with statuses other than BEKLEMEDE/ONAYLANDI/HAZIRLANIYOR/TESLIMEDILDI');
    }
    
    console.log('[hammadde-siparisleri/summary] Stats:', { toplam, bekleyen, uretimde, teslim_edildi, sumOfStatuses, otherStatuses });
    
    res.json({
      success: true,
      data: {
        total: toplam,
        pending: bekleyen,
        inProduction: uretimde,
        delivered: teslim_edildi
      }
    });
  } catch (error) {
    console.error('Hammadde siparisleri summary error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// 🛒 CUSTOMER API ENDPOINTS
// ============================================

// Get customer orders
app.get('/api/customer/orders', async (req, res) => {
  try {
    const musteriId = req.query.musteriId;
    
    if (!musteriId) {
      return res.status(400).json({ error: 'musteriId parametresi gerekli' });
    }
    
    const [rows] = await pool.query(`
      SELECT
        s.siparis_id,
        s.siparis_tarihi,
        s.teslim_plan,
        s.teslim_gercek,
        s.durumu,
        s.musteri_notu,
        COALESCE(SUM(d.adet), 0) AS toplam_adet,
        COALESCE(SUM(d.toplam_tutar), 0) AS toplam_tutar
      FROM siparisler s
      LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
      WHERE s.musteri_id = ?
      GROUP BY s.siparis_id, s.siparis_tarihi, s.teslim_plan, s.teslim_gercek, s.durumu, s.musteri_notu
      ORDER BY s.siparis_tarihi DESC
    `, [musteriId]);
    
    res.json(rows);
  } catch (error) {
    console.error('Customer orders error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Get completed orders for review
app.get('/api/customer/orders/completed-for-review', async (req, res) => {
  try {
    const url = req.originalUrl || req.url;
    const musteriId = req.query.musteriId || req.query.musteri_id || resolveCustomerId(req);
    
    console.log('[completed-for-review] Request URL:', url);
    console.log('[completed-for-review] musteri_id:', musteriId);
    
    if (!musteriId) {
      return res.status(400).json({ success: false, error: 'musteriId parametresi gerekli' });
    }
    
    const [rows] = await pool.query(`
      SELECT 
        s.siparis_id, 
        s.musteri_id,
        s.durumu,
        s.siparis_tarihi, 
        s.teslim_plan, 
        s.teslim_gercek, 
        s.degerlendirme_puan, 
        s.degerlendirme_yorum,
        am.model_adi
      FROM siparisler s
      LEFT JOIN siparis_detay sd ON sd.siparis_id = s.siparis_id
      LEFT JOIN urunler u ON u.urun_id = sd.urun_id
      LEFT JOIN arac_modelleri am ON am.arac_model_id = u.arac_model_id
      WHERE s.musteri_id = ?
        AND s.durumu = 'TAMAMLANDI'
      GROUP BY s.siparis_id, s.musteri_id, s.durumu, s.siparis_tarihi, 
               s.teslim_plan, s.teslim_gercek, s.degerlendirme_puan, 
               s.degerlendirme_yorum, am.model_adi
      ORDER BY s.siparis_id DESC
    `, [musteriId]);
    
    console.log('[completed-for-review] Rows found:', rows.length);
    if (rows.length > 0) {
      console.log('[completed-for-review] Sample row:', {
        siparis_id: rows[0].siparis_id,
        durumu: rows[0].durumu,
        has_puan: rows[0].degerlendirme_puan !== null,
        has_yorum: rows[0].degerlendirme_yorum !== null
      });
    }
    
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[completed-for-review] Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Temporary debug endpoint to check reviews in DB
app.get('/api/dev/reviews-check', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        siparis_id, 
        musteri_id, 
        durumu, 
        degerlendirme_puan, 
        degerlendirme_yorum
      FROM siparisler
      WHERE degerlendirme_puan IS NOT NULL OR degerlendirme_yorum IS NOT NULL
      ORDER BY siparis_id DESC
      LIMIT 20
    `);
    
    console.log('[reviews-check] Found reviews:', rows.length);
    res.json({ success: true, count: rows.length, reviews: rows });
  } catch (error) {
    console.error('[reviews-check] Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Get random customer review (only positive reviews: 4-5 stars)
app.get('/api/reviews/random', async (req, res) => {
  try {
    // Only return 4-5 star reviews from completed orders
    const [rows] = await pool.query(`
      SELECT 
        s.degerlendirme_puan AS rating,
        s.degerlendirme_yorum AS comment,
        COALESCE(m.musteri_bilgisi, 'Müşteri') AS fullname
      FROM siparisler s
      LEFT JOIN musteriler m ON m.musteri_id = s.musteri_id
      WHERE s.degerlendirme_puan IN (4, 5)
        AND s.degerlendirme_yorum IS NOT NULL
        AND TRIM(s.degerlendirme_yorum) != ''
        AND s.durumu = 'TAMAMLANDI'
      ORDER BY RAND()
      LIMIT 1
    `);
    
    // Return null if no positive reviews found
    if (!rows || rows.length === 0) {
      return res.json({
        success: true,
        data: null
      });
    }
    
    const review = rows[0];
    res.json({
      success: true,
      data: {
        fullname: review.fullname || 'Müşteri',
        rating: Number(review.rating) || 0,
        comment: review.comment || ''
      }
    });
  } catch (error) {
    console.error('Random review error:', error);
    res.status(500).json({
      success: false,
      error: 'Değerlendirme yüklenirken hata oluştu: ' + error.message
    });
  }
});

// Submit review for completed order
app.post('/api/customer/orders/:siparis_id/review', async (req, res) => {
  try {
    const { siparis_id } = req.params;
    const { puan, yorum } = req.body || {};
    const musteriId = req.query.musteriId || req.query.musteri_id || resolveCustomerId(req);
    
    if (!musteriId) {
      return res.status(401).json({ success: false, error: 'Oturum bulunamadı' });
    }
    
    // Validate puan (1-5 integer)
    const puanNum = parseInt(puan, 10);
    if (isNaN(puanNum) || puanNum < 1 || puanNum > 5) {
      return res.status(400).json({ success: false, error: 'Puan 1 ile 5 arasında bir tam sayı olmalıdır' });
    }
    
    // Validate yorum (max 500 chars, trim)
    const yorumTrimmed = yorum ? String(yorum).trim().substring(0, 500) : null;
    
    // Update with atomic check (prevents double review)
    const [result] = await pool.query(`
      UPDATE siparisler
      SET degerlendirme_puan = ?,
          degerlendirme_yorum = ?
      WHERE siparis_id = ?
        AND musteri_id = ?
        AND durumu = 'TAMAMLANDI'
        AND degerlendirme_puan IS NULL
    `, [puanNum, yorumTrimmed || null, siparis_id, musteriId]);
    
    if (result.affectedRows === 0) {
      return res.status(409).json({ 
        success: false, 
        error: 'Bu sipariş zaten değerlendirilmiş veya değerlendirilemez.' 
      });
    }
    
    res.json({ success: true, message: 'Değerlendirme kaydedildi' });
  } catch (error) {
    console.error('Submit review error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Cancel customer order
app.patch('/api/customer/orders/:siparis_id/cancel', async (req, res) => {
  try {
    const { siparis_id } = req.params;
    const musteriId = req.query.musteriId || req.body.musteriId;
    
    if (!musteriId) {
      return res.status(400).json({ 
        success: false, 
        error: 'musteriId parametresi gerekli' 
      });
    }
    
    // Fetch the order and verify it belongs to the customer
    const [orderRows] = await pool.query(`
      SELECT siparis_id, musteri_id, durumu
      FROM siparisler
      WHERE siparis_id = ? AND musteri_id = ?
    `, [siparis_id, musteriId]);
    
    if (!orderRows || orderRows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Sipariş bulunamadı veya bu sipariş size ait değil' 
      });
    }
    
    const order = orderRows[0];
    const currentStatus = (order.durumu || '').toString().trim().toUpperCase();
    
    // Normalize status (handle Turkish characters)
    const normalizedStatus = currentStatus
      .replace(/İ/g, 'I')
      .replace(/Ü/g, 'U')
      .replace(/Ö/g, 'O')
      .replace(/Ş/g, 'S')
      .replace(/Ç/g, 'C')
      .replace(/Ğ/g, 'G')
      .replace(/\s+/g, '_');
    
    // Check if order can be canceled (only Planlandı or Üretimde)
    const cancelableStatuses = ['PLANLANDI', 'URETIMDE'];
    
    if (!cancelableStatuses.includes(normalizedStatus)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Bu sipariş bu aşamada iptal edilemez. Sadece "Planlandı" veya "Üretimde" durumundaki siparişler iptal edilebilir.' 
      });
    }
    
    // Check if already canceled
    if (normalizedStatus === 'IPTAL') {
      return res.status(400).json({ 
        success: false, 
        error: 'Bu sipariş zaten iptal edilmiş' 
      });
    }
    
    // Update order status to IPTAL
    const [updateResult] = await pool.query(`
      UPDATE siparisler
      SET durumu = 'IPTAL'
      WHERE siparis_id = ?
    `, [siparis_id]);
    
    if (updateResult.affectedRows === 0) {
      return res.status(500).json({ 
        success: false, 
        error: 'Sipariş iptal edilemedi' 
      });
    }
    
    // Fetch updated order with details
    const [updatedRows] = await pool.query(`
      SELECT
        s.siparis_id,
        s.siparis_tarihi,
        s.teslim_plan,
        s.teslim_gercek,
        s.durumu,
        COALESCE(SUM(d.adet), 0) AS toplam_adet,
        COALESCE(SUM(d.toplam_tutar), 0) AS toplam_tutar
      FROM siparisler s
      LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
      WHERE s.siparis_id = ?
      GROUP BY s.siparis_id, s.siparis_tarihi, s.teslim_plan, s.teslim_gercek, s.durumu
    `, [siparis_id]);
    
    res.json({
      success: true,
      message: 'Sipariş iptal edildi',
      data: updatedRows[0] || null
    });
  } catch (error) {
    console.error('Cancel order error:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Sipariş iptal edilirken hata oluştu: ' + error.message 
    });
  }
});

// Get all customer orders (no status filter) - newest first
app.get('/api/customer/orders/all', async (req, res) => {
  try {
    const musteriId = req.query.musteriId;
    
    if (!musteriId) {
      return res.status(400).json({ error: 'musteriId parametresi gerekli' });
    }
    
    const [rows] = await pool.query(`
      SELECT
        s.siparis_id,
        s.siparis_tarihi,
        s.teslim_plan,
        s.teslim_gercek,
        s.durumu,
        s.musteri_notu,
        COALESCE(SUM(d.adet), 0) AS toplam_adet,
        COALESCE(SUM(d.toplam_tutar), 0) AS toplam_tutar
      FROM siparisler s
      LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
      WHERE s.musteri_id = ?
      GROUP BY s.siparis_id, s.siparis_tarihi, s.teslim_plan, s.teslim_gercek, s.durumu, s.musteri_notu
      ORDER BY s.siparis_id DESC
      LIMIT 500
    `, [musteriId]);
    
    res.json({ success: true, orders: rows });
  } catch (error) {
    console.error('Customer orders (all) error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Order status distribution (all orders)
app.get('/api/reports/order-status-distribution', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT durumu AS status, COUNT(*) AS count
      FROM siparisler
      GROUP BY durumu
    `);
    res.json(rows || []);
  } catch (error) {
    console.error('Order status distribution error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// KPIs for admin dashboard
app.get('/api/reports/kpis', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        COUNT(*) AS totalOrders,
        SUM(CASE WHEN UPPER(TRIM(s.durumu)) NOT IN ('TAMAMLANDI','TESLIM_EDILDI') THEN 1 ELSE 0 END) AS activeOrders,
        SUM(CASE WHEN UPPER(TRIM(s.durumu)) = 'IPTAL' THEN 1 ELSE 0 END) AS canceledOrders,
        COALESCE(SUM(CASE WHEN UPPER(TRIM(s.durumu)) <> 'IPTAL' THEN d.toplam_tutar END), 0) AS totalRevenue
      FROM siparisler s
      LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
    `);

    const row = rows[0] || {};
    const total = Number(row.totalOrders) || 0;
    const canceled = Number(row.canceledOrders) || 0;
    const cancelRate = total > 0 ? (canceled / total) * 100 : 0;

    res.json({
      success: true,
      totalOrders: Number(row.totalOrders) || 0,
      activeOrders: Number(row.activeOrders) || 0,
      totalRevenue: Number(row.totalRevenue) || 0,
      cancelRate: Number(cancelRate)
    });
  } catch (error) {
    console.error('KPIs error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Monthly sales for bar chart (last 3 months: Oct, Nov, Dec)
app.get('/api/reports/monthly-sales', async (req, res) => {
  try {
    const currentYear = new Date().getFullYear();
    const [rows] = await pool.query(`
      SELECT 
        DATE_FORMAT(s.siparis_tarihi, '%Y-%m') AS month,
        MONTH(s.siparis_tarihi) AS month_num,
        COALESCE(SUM(d.toplam_tutar), 0) AS total
      FROM siparisler s
      LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
      WHERE UPPER(TRIM(s.durumu)) <> 'IPTAL'
        AND YEAR(s.siparis_tarihi) = ?
        AND MONTH(s.siparis_tarihi) IN (10, 11, 12)
      GROUP BY DATE_FORMAT(s.siparis_tarihi, '%Y-%m'), MONTH(s.siparis_tarihi)
      ORDER BY month_num ASC
    `, [currentYear]);
    res.json(rows || []);
  } catch (error) {
    console.error('Monthly sales error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/dashboard/inflation-and-cost-impact
app.get('/api/dashboard/inflation-and-cost-impact', async (req, res) => {
  try {
    // Demo values — replace with live TÜİK source later
    const TUIK_TUFE_MONTHLY = {
      Eki: 2.8,
      Kas: 3.1,
      Ara: 2.9
    };
    
    // Material names only (no prices - user will enter manually)
    const materialNames = [
      'PVC Branda Kumaşı (700 gr/m²)',
      'Rüzgar Bariyeri Şeffaf Mica Branda',
      'Alüminyum Profil (Gövde)',
      'Lastik Fitil (Kenar Sıkıştırma)',
      'Cırt Cırt Şerit'
    ];
    
    // Demo TÜİK annual inflation value – replace with live source later
    const TUIK_ANNUAL_INFLATION = 64.8;
    
    // TÜİK data
    const tuikLabels = ['Eki', 'Kas', 'Ara'];
    const tuikValues = [TUIK_TUFE_MONTHLY.Eki, TUIK_TUFE_MONTHLY.Kas, TUIK_TUFE_MONTHLY.Ara];
    const latestTuik = TUIK_TUFE_MONTHLY.Ara;
    
    // Thresholds
    const HIGH_INFLATION_TUIK = 3.0;
    const HIGH_COST_INCREASE = 5.0;
    
    res.json({
      tuik: {
        labels: tuikLabels,
        monthly_values: tuikValues,
        latest_monthly: latestTuik,
        annual: TUIK_ANNUAL_INFLATION
      },
      materials: {
        names: materialNames
      },
      thresholds: {
        tuik: HIGH_INFLATION_TUIK,
        cost: HIGH_COST_INCREASE
      }
    });
  } catch (error) {
    console.error('Inflation and cost impact error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/dashboard/order-completion-distribution
app.get('/api/dashboard/order-completion-distribution', async (req, res) => {
  try {
    const SLA_DAYS = 7; // Service Level Agreement: 7 days
    const currentYear = new Date().getFullYear();
    // Get completed orders from last 3 months and calculate completion days
    const [rows] = await pool.query(`
      SELECT 
        DATEDIFF(
          COALESCE(s.teslim_plan, s.siparis_tarihi),
          s.siparis_tarihi
        ) AS completion_days
      FROM siparisler s
      WHERE YEAR(s.siparis_tarihi) = ?
        AND MONTH(s.siparis_tarihi) IN (10, 11, 12)
        AND UPPER(TRIM(s.durumu)) = 'TAMAMLANDI'
        AND s.siparis_tarihi IS NOT NULL
    `, [currentYear]);
    
    // Initialize buckets
    const buckets = {
      '0-2': 0,
      '3-5': 0,
      '6-8': 0,
      '9+': 0
    };
    
    // Calculate totals and late orders
    let totalCompleted = rows.length;
    let lateCompleted = 0;
    
    // Group orders into buckets and count late orders
    rows.forEach(row => {
      const days = Number(row.completion_days) || 0;
      if (days >= 0 && days <= 2) {
        buckets['0-2']++;
      } else if (days >= 3 && days <= 5) {
        buckets['3-5']++;
      } else if (days >= 6 && days <= 8) {
        buckets['6-8']++;
      } else if (days >= 9) {
        buckets['9+']++;
      }
      
      // Count late orders (completion_days > SLA_DAYS)
      if (days > SLA_DAYS) {
        lateCompleted++;
      }
    });
    
    // Calculate late rate
    const lateRate = totalCompleted > 0 
      ? Number(((lateCompleted / totalCompleted) * 100).toFixed(1))
      : 0;
    
    res.json({
      labels: ["0–2 gün", "3–5 gün", "6–8 gün", "9+ gün"],
      values: [buckets['0-2'], buckets['3-5'], buckets['6-8'], buckets['9+']],
      totals: {
        total_completed: totalCompleted,
        late_completed: lateCompleted,
        late_rate: lateRate
      },
      sla_days: SLA_DAYS
    });
  } catch (error) {
    console.error('Order completion distribution error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/analytics/top-production-time-products
app.get('/api/admin/analytics/top-production-time-products', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 3;
    const limit = 5; // Top 5 products
    
    // Calculate date threshold using MySQL DATE_SUB
    const [dateRows] = await pool.query(`SELECT DATE_SUB(CURDATE(), INTERVAL ? MONTH) AS start_date`, [months]);
    const startDate = dateRows[0].start_date;
    
    // Query to get average production days per product
    // Groups by product and production group (siparis_detay_id or uretim_id)
    // Calculates production_days = DATEDIFF(MAX(tarih), MIN(tarih)) + 1 per group
    // Then takes AVG(production_days) per product
    const [rows] = await pool.query(`
      SELECT 
        t.urun_id, 
        u.urun_adi,
        AVG(t.production_days) AS avg_production_days
      FROM (
        SELECT 
          urun_id,
          IFNULL(siparis_detay_id, uretim_id) AS grp_id,
          DATEDIFF(MAX(tarih), MIN(tarih)) + 1 AS production_days
        FROM uretim_kayit
        WHERE tarih >= ?
        GROUP BY urun_id, grp_id
      ) t
      JOIN urunler u ON u.urun_id = t.urun_id
      GROUP BY t.urun_id, u.urun_adi
      HAVING avg_production_days IS NOT NULL
      ORDER BY avg_production_days DESC
      LIMIT ?
    `, [startDate, limit]);
    
    const data = rows.map(row => ({
      urun_id: row.urun_id,
      urun_adi: row.urun_adi,
      avg_production_days: Number(row.avg_production_days) || 0
    }));
    
    res.json({
      success: true,
      data: data
    });
  } catch (error) {
    console.error('Top production time products error:', error);
    return res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// GET /api/admin/analytics/mock/product-delay-risk
app.get('/api/admin/analytics/mock/product-delay-risk', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 3;
    const limit = 5; // Top 5 products
    
    // Query top 5 products from urunler (stable order by urun_id ASC)
    const [rows] = await pool.query(`
      SELECT urun_id, urun_adi
      FROM urunler
      ORDER BY urun_id ASC
      LIMIT ?
    `, [limit]);
    
    // Generate deterministic mock risk scores
    const data = rows.map(row => {
      // Compute pseudo risk score: risk = (urun_id * 37) % 101
      let risk = (row.urun_id * 37) % 101;
      // Clamp to 20..95: risk = 20 + ((risk % 76))
      risk = 20 + (risk % 76);
      
      return {
        urun_id: row.urun_id,
        urun_adi: row.urun_adi,
        risk_score: risk
      };
    });
    
    // If no products exist, use hardcoded fallback
    if (data.length === 0) {
      const fallbackProducts = [
        { urun_id: 1, urun_adi: 'Örnek Ürün 1', risk_score: 45 },
        { urun_id: 2, urun_adi: 'Örnek Ürün 2', risk_score: 62 },
        { urun_id: 3, urun_adi: 'Örnek Ürün 3', risk_score: 78 },
        { urun_id: 4, urun_adi: 'Örnek Ürün 4', risk_score: 34 },
        { urun_id: 5, urun_adi: 'Örnek Ürün 5', risk_score: 89 }
      ];
      return res.json({
        success: true,
        isMock: true,
        data: fallbackProducts
      });
    }
    
    res.json({
      success: true,
      isMock: true,
      data: data
    });
  } catch (error) {
    console.error('Mock product delay risk error:', error);
    // Return fallback data on error
    const fallbackProducts = [
      { urun_id: 1, urun_adi: 'Örnek Ürün 1', risk_score: 45 },
      { urun_id: 2, urun_adi: 'Örnek Ürün 2', risk_score: 62 },
      { urun_id: 3, urun_adi: 'Örnek Ürün 3', risk_score: 78 },
      { urun_id: 4, urun_adi: 'Örnek Ürün 4', risk_score: 34 },
      { urun_id: 5, urun_adi: 'Örnek Ürün 5', risk_score: 89 }
    ];
    return res.json({
      success: true,
      isMock: true,
      data: fallbackProducts
    });
  }
});

// ============================================
// 👤 ADMIN CUSTOMER MANAGEMENT ENDPOINTS
// ============================================

// GET /api/admin/customers/summary
app.get('/api/admin/customers/summary', async (req, res) => {
  try {
    // Total customers
    const [totalRows] = await pool.query('SELECT COUNT(*) as total FROM musteriler');
    const totalCustomers = Number(totalRows[0].total) || 0;

    // Active customers (at least 1 order in last 60 days)
    const [activeRows] = await pool.query(`
      SELECT COUNT(DISTINCT s.musteri_id) as active_count
      FROM siparisler s
      WHERE s.siparis_tarihi >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
        AND s.musteri_id IS NOT NULL
    `);
    const activeCustomers = Number(activeRows[0].active_count) || 0;

    // Risky customers (risk_score >= 60) - we'll calculate this in the list endpoint
    // For summary, we'll use a simplified query
    const [riskyRows] = await pool.query(`
      SELECT COUNT(DISTINCT m.musteri_id) as risky_count
      FROM musteriler m
      LEFT JOIN siparisler s ON s.musteri_id = m.musteri_id
      WHERE (
        (SELECT COUNT(*) FROM siparisler s2 
         WHERE s2.musteri_id = m.musteri_id 
         AND UPPER(TRIM(s2.durumu)) = 'IPTAL') * 100.0 / 
        NULLIF((SELECT COUNT(*) FROM siparisler s3 WHERE s3.musteri_id = m.musteri_id), 0) >= 30
      )
      OR (
        DATEDIFF(CURDATE(), COALESCE(
          (SELECT MAX(s4.siparis_tarihi) FROM siparisler s4 WHERE s4.musteri_id = m.musteri_id),
          m.created_at
        )) > 90
      )
    `);
    const riskyCustomers = Number(riskyRows[0].risky_count) || 0;

    res.json({
      success: true,
      data: {
        totalCustomers,
        activeCustomers,
        riskyCustomers
      }
    });
  } catch (error) {
    console.error('Customer summary error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/admin/customers/list?months=3&page=1&limit=10&search=...
app.get('/api/admin/customers/list', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 3;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 15));
    const offset = (page - 1) * limit;
    const searchTerm = (req.query.search || '').trim();

    const [dateRows] = await pool.query(`SELECT DATE_SUB(CURDATE(), INTERVAL ? MONTH) AS start_date`, [months]);
    const startDate = dateRows[0].start_date;

    // Build WHERE clause for search
    let searchCondition = '1=1';
    const searchParams = [];
    if (searchTerm) {
      searchCondition = 'm.musteri_bilgisi LIKE ?';
      searchParams.push(`%${searchTerm}%`);
    }

    // Count query for total
    const [countRows] = await pool.query(`
      SELECT COUNT(DISTINCT m.musteri_id) as total
      FROM musteriler m
      WHERE ${searchCondition}
    `, searchParams);
    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.ceil(total / limit);

    // Main query with pagination
    const [rows] = await pool.query(`
      SELECT 
        m.musteri_id,
        m.musteri_bilgisi as musteri_ad,
        COALESCE(COUNT(DISTINCT s.siparis_id), 0) as total_orders,
        COALESCE(SUM(CASE WHEN UPPER(TRIM(s.durumu)) <> 'IPTAL' THEN d.toplam_tutar ELSE 0 END), 0) as total_revenue,
        MAX(s.siparis_tarihi) as last_order_date,
        GREATEST(0, DATEDIFF(CURDATE(), COALESCE(MAX(s.siparis_tarihi), m.created_at))) as inactivity_days,
        SUM(CASE WHEN UPPER(TRIM(s.durumu)) = 'IPTAL' THEN 1 ELSE 0 END) as cancelled_orders
      FROM musteriler m
      LEFT JOIN siparisler s ON s.musteri_id = m.musteri_id 
        AND s.siparis_tarihi >= ?
      LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
      WHERE ${searchCondition}
      GROUP BY m.musteri_id, m.musteri_bilgisi, m.created_at
      ORDER BY total_revenue DESC
      LIMIT ? OFFSET ?
    `, [startDate, ...searchParams, limit, offset]);

    // Get order statistics for all customers in one query (cancellation data only)
    const customerIds = rows.map(r => r.musteri_id);
    let statsMap = {};

    if (customerIds.length > 0) {
      try {
        const placeholders = customerIds.map(() => '?').join(',');
        const [orderStatsRows] = await pool.query(`
          SELECT 
            musteri_id,
            COUNT(*) as total,
            SUM(CASE WHEN UPPER(TRIM(durumu)) = 'IPTAL' THEN 1 ELSE 0 END) as cancelled
          FROM siparisler
          WHERE musteri_id IN (${placeholders})
          GROUP BY musteri_id
        `, customerIds);

        orderStatsRows.forEach(stat => {
          statsMap[stat.musteri_id] = stat;
        });
      } catch (err) {
        console.error('Error fetching order stats:', err);
      }
    }

    // Calculate risk scores and status badges
    const customers = rows.map(row => {
      const musteriId = row.musteri_id;
      const totalOrders = Number(row.total_orders) || 0;
      
      // Handle NULL last_order_date: treat as max inactivity (100 days)
      // If last_order_date is NULL, customer has never placed an order (or no orders in time period)
      let inactivityDays = 0;
      if (row.last_order_date === null || row.last_order_date === undefined || row.last_order_date === '') {
        inactivityDays = 100; // Max inactivity - treat as never ordered
      } else {
        // Ensure inactivity_days is never negative (clamp to [0, 100])
        inactivityDays = Math.max(0, Math.min(100, Number(row.inactivity_days) || 0));
      }

      // Edge case: Customers with 0 orders
      if (totalOrders === 0) {
        return {
          musteri_id: musteriId,
          musteri_ad: row.musteri_ad || `Müşteri ${musteriId}`,
          total_orders: 0,
          total_revenue: 0,
          last_order_date: row.last_order_date,
          status_badge: 'Pasif',
          risk_score: 80, // Fixed high baseline for customers with no orders
          cancel_rate_percent: null // Show "-" in UI
        };
      }

      // Normal calculation for customers with orders > 0
      // Get cancellation rate from all-time orders (not just last 3 months)
      let cancelComponent = 0;
      let cancelRatePercent = null; // For display in table

      const stats = statsMap[musteriId];
      const total = stats ? Number(stats.total) || 0 : 0;
      
      if (total > 0) {
        // Real cancellation rate
        const cancellationRate = (Number(stats.cancelled) || 0) / total;
        // Clamp cancel_component to [0, 100]
        cancelComponent = Math.max(0, Math.min(100, cancellationRate * 100));
        // Calculate cancellation rate percentage for display
        cancelRatePercent = Math.round(cancellationRate * 100);
      } else {
        // If no orders found in stats (customer has never placed an order), show "-"
        cancelComponent = 0;
        cancelRatePercent = null; // Will show "-" in UI
      }

      // Inactivity component: clamp to [0, 100]
      const inactivityComponent = Math.max(0, Math.min(100, inactivityDays));

      // Risk score: cancellation 60% + inactivity 40%
      const rawScore = cancelComponent * 0.6 + inactivityComponent * 0.4;
      // Final clamp to [0, 100]
      const riskScore = Math.max(0, Math.min(100, Math.round(rawScore)));

      // Determine status badge
      let statusBadge = 'Aktif';
      if (riskScore >= 60) {
        statusBadge = 'Riskli';
      } else if (inactivityDays > 90) {
        statusBadge = 'Pasif';
      }

      return {
        musteri_id: musteriId,
        musteri_ad: row.musteri_ad || `Müşteri ${musteriId}`,
        total_orders: totalOrders,
        total_revenue: Number(row.total_revenue) || 0,
        last_order_date: row.last_order_date,
        status_badge: statusBadge,
        risk_score: riskScore,
        cancel_rate_percent: cancelRatePercent // null if totalOrders = 0, otherwise 0-100
      };
    });

    res.json({
      success: true,
      data: customers,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error('Customer list error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/admin/customers/avg-delivery-time?months=3
app.get('/api/admin/customers/avg-delivery-time', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 3;
    const [dateRows] = await pool.query(`SELECT DATE_SUB(CURDATE(), INTERVAL ? MONTH) AS start_date`, [months]);
    const startDate = dateRows[0].start_date;

    // Try to get real data first
    let isMock = false;
    let rows = [];

    try {
      const [realRows] = await pool.query(`
        SELECT 
          m.musteri_bilgisi as musteri_ad,
          AVG(DATEDIFF(
            COALESCE(s.teslim_plan, s.siparis_tarihi),
            s.siparis_tarihi
          )) as avg_days
        FROM musteriler m
        INNER JOIN siparisler s ON s.musteri_id = m.musteri_id
        WHERE s.siparis_tarihi >= ?
          AND s.durumu = 'TAMAMLANDI'
        GROUP BY m.musteri_id, m.musteri_bilgisi
        HAVING avg_days IS NOT NULL
        ORDER BY avg_days DESC
        LIMIT 10
      `, [startDate]);

      if (realRows.length > 0) {
        rows = realRows;
      } else {
        // Use mock data
        isMock = true;
        const [customerRows] = await pool.query(`
          SELECT musteri_id, musteri_bilgisi as musteri_ad
          FROM musteriler
          ORDER BY musteri_id ASC
          LIMIT 10
        `);
        rows = customerRows.map(c => ({
          musteri_ad: c.musteri_ad || `Müşteri ${c.musteri_id}`,
          avg_days: 2 + ((c.musteri_id * 13) % 12)
        }));
      }
    } catch (err) {
      // Fallback to mock
      isMock = true;
      const [customerRows] = await pool.query(`
        SELECT musteri_id, musteri_bilgisi as musteri_ad
        FROM musteriler
        ORDER BY musteri_id ASC
        LIMIT 10
      `);
      rows = customerRows.map(c => ({
        musteri_ad: c.musteri_ad || `Müşteri ${c.musteri_id}`,
        avg_days: 2 + ((c.musteri_id * 13) % 12)
      }));
    }

    const data = rows.map(row => ({
      musteri_ad: row.musteri_ad,
      avg_days: Number(row.avg_days) || 0
    })).sort((a, b) => b.avg_days - a.avg_days).slice(0, 10);

    res.json({
      success: true,
      data: data,
      isMock: isMock
    });
  } catch (error) {
    console.error('Avg delivery time error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/admin/customers/top-value?months=3
app.get('/api/admin/customers/top-value', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 3;
    const [dateRows] = await pool.query(`SELECT DATE_SUB(CURDATE(), INTERVAL ? MONTH) AS start_date`, [months]);
    const startDate = dateRows[0].start_date;

    const [rows] = await pool.query(`
      SELECT 
        m.musteri_bilgisi as musteri_ad,
        COALESCE(SUM(d.toplam_tutar), 0) as revenue
      FROM musteriler m
      LEFT JOIN siparisler s ON s.musteri_id = m.musteri_id
        AND s.siparis_tarihi >= ?
        AND UPPER(TRIM(s.durumu)) <> 'IPTAL'
      LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
      GROUP BY m.musteri_id, m.musteri_bilgisi
      HAVING revenue > 0
      ORDER BY revenue DESC
      LIMIT 5
    `, [startDate]);

    const data = rows.map(row => ({
      musteri_ad: row.musteri_ad || 'Bilinmeyen Müşteri',
      revenue: Number(row.revenue) || 0
    }));

    // Calculate total revenue for share percentage
    const totalRevenue = data.reduce((sum, c) => sum + c.revenue, 0);
    const dataWithShare = data.map(c => ({
      ...c,
      share: totalRevenue > 0 ? (c.revenue / totalRevenue * 100) : 0
    }));

    res.json({
      success: true,
      data: dataWithShare
    });
  } catch (error) {
    console.error('Top value customers error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/dashboard/ciro-kar-6ay (Revenue & Profit 6-month: 3 actual + 3 forecast)
app.get('/api/dashboard/ciro-kar-6ay', async (req, res) => {
  try {
    const DEFAULT_COST_RATE = 0.65; // 65% cost, 35% profit margin
    const currentYear = new Date().getFullYear();
    
    // Get historical revenue for Oct, Nov, Dec 2025
    const [rows] = await pool.query(`
      SELECT 
        MONTH(s.siparis_tarihi) AS month_num,
        COALESCE(SUM(d.toplam_tutar), 0) AS revenue
      FROM siparisler s
      LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
      WHERE UPPER(TRIM(s.durumu)) <> 'IPTAL'
        AND YEAR(s.siparis_tarihi) = ?
        AND MONTH(s.siparis_tarihi) IN (10, 11, 12)
        AND s.siparis_tarihi IS NOT NULL
      GROUP BY MONTH(s.siparis_tarihi)
      ORDER BY month_num ASC
    `, [currentYear]);
    
    // Build historical data array (Oct=10, Nov=11, Dec=12)
    const historical = [10, 11, 12].map(monthNum => {
      const row = rows.find(r => Number(r.month_num) === monthNum);
      return row ? Number(row.revenue) || 0 : 0;
    });
    
    // Calculate profit for historical data
    const actualProfit = historical.map(rev => rev * (1 - DEFAULT_COST_RATE));
    
    // Forecast configuration constants
    const JAN_BOOST_RATE = 0.08; // +8% over Dec
    const MONTHLY_DECAY_RATE = 0.07; // -7% per month after Jan
    const FORECAST_REVENUE_FLOOR_RATE = 0.55; // never go below 55% of Dec actual revenue
    const FORECAST_PROFIT_FLOOR_RATE = 0.55; // never go below 55% of Dec actual profit
    
    // Calculate forecast revenue
    let forecastRevenue = [];
    const decRevenue = historical[2] || 0; // December (index 2)
    const decProfit = actualProfit[2] || 0; // December profit
    
    if (decRevenue > 0) {
      // Jan forecast: +8% over Dec
      const forecastRevenueOca = decRevenue * (1 + JAN_BOOST_RATE);
      
      // Feb forecast: -7% from Jan, but floor at 55% of Dec
      const forecastRevenueSub = Math.max(
        forecastRevenueOca * (1 - MONTHLY_DECAY_RATE),
        decRevenue * FORECAST_REVENUE_FLOOR_RATE
      );
      
      // Mar forecast: -7% from Feb, but floor at 55% of Dec
      const forecastRevenueMar = Math.max(
        forecastRevenueSub * (1 - MONTHLY_DECAY_RATE),
        decRevenue * FORECAST_REVENUE_FLOOR_RATE
      );
      
      forecastRevenue = [forecastRevenueOca, forecastRevenueSub, forecastRevenueMar];
    } else {
      // Fallback: if no Dec data, use average of available months
      const nonZeroValues = historical.filter(v => v > 0);
      const avg = nonZeroValues.length > 0
        ? nonZeroValues.reduce((a, b) => a + b, 0) / nonZeroValues.length
        : 0;
      forecastRevenue = [avg, avg, avg];
    }
    
    // Calculate forecast profit from revenue, then apply floor
    let forecastProfit = forecastRevenue.map(rev => rev * (1 - DEFAULT_COST_RATE));
    
    // Apply profit floor to Feb and Mar (ensure they don't drop below 55% of Dec profit)
    if (decProfit > 0) {
      forecastProfit[1] = Math.max(forecastProfit[1], decProfit * FORECAST_PROFIT_FLOOR_RATE);
      forecastProfit[2] = Math.max(forecastProfit[2], decProfit * FORECAST_PROFIT_FLOOR_RATE);
    }
    
    // Ensure profit never becomes negative
    forecastProfit = forecastProfit.map(profit => Math.max(0, profit));
    
    res.json({
      labels: ["Eki", "Kas", "Ara", "Oca", "Şub", "Mar"],
      actual: {
        revenue: historical,
        profit: actualProfit
      },
      forecast: {
        revenue: forecastRevenue,
        profit: forecastProfit
      }
    });
  } catch (error) {
    console.error('Ciro-Kar 6ay error:', error);
    return res.status(500).json({ error: error.message });
  }
});


// Get customer orders summary (for KPI cards)
app.get('/api/customer/orders/summary', async (req, res) => {
  try {
    const musteriId = req.query.musteriId;
    
    if (!musteriId) {
      return res.status(400).json({ error: 'musteriId parametresi gerekli' });
    }
    
    const [rows] = await pool.query(`
      SELECT 
        COUNT(*) AS toplam_siparis,
        SUM(CASE WHEN s.durumu IN ('PLANLANDI','URETIMDE') THEN 1 ELSE 0 END) AS aktif_siparis,
        SUM(CASE WHEN s.durumu IN ('TAMAMLANDI','SEVK_EDILDI') THEN 1 ELSE 0 END) AS tamamlanan_siparis,
        SUM(CASE WHEN s.durumu = 'IPTAL' THEN 1 ELSE 0 END) AS iptal_siparis,
        COALESCE(SUM(d.toplam_tutar), 0) AS toplam_tutar
      FROM siparisler s
      LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
      WHERE s.musteri_id = ?
    `, [musteriId]);
    
    res.json(rows[0]);
  } catch (error) {
    console.error('Customer orders summary error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// 📦 CUSTOMER ORDERS API ENDPOINTS (Sipariş Yönetimi)
// ============================================

// Get customer reviews for admin panel
// This endpoint queries reviews from siparisler table (where degerlendirme_puan is stored)
// If a separate siparis_degerlendirmeleri table exists, modify the query accordingly
// GET /api/admin/reviews/summary - Get average rating and review count
app.get('/api/admin/reviews/summary', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        ROUND(AVG(degerlendirme_puan), 2) AS avgRating,
        COUNT(degerlendirme_puan) AS reviewCount
      FROM siparisler
      WHERE degerlendirme_puan IS NOT NULL
        AND degerlendirme_puan > 0
        AND durumu = 'TAMAMLANDI'
    `);
    
    const avgRating = rows[0]?.avgRating ? Number(rows[0].avgRating) : 0;
    const reviewCount = rows[0]?.reviewCount ? Number(rows[0].reviewCount) : 0;
    
    res.json({
      success: true,
      data: {
        avgRating: avgRating,
        reviewCount: reviewCount
      }
    });
  } catch (error) {
    console.error('[admin/reviews/summary] Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/admin/customer-reviews', async (req, res) => {
  try {
    // Query reviews from siparisler table where reviews exist
    // Join with musteriler to get customer name
    const [rows] = await pool.query(`
      SELECT 
        s.siparis_id AS id,
        s.siparis_id,
        m.musteri_bilgisi AS musteri_adsoyad,
        s.siparis_tarihi,
        s.degerlendirme_puan AS puan,
        s.degerlendirme_yorum AS yorum,
        s.siparis_tarihi AS olusturma_tarihi
      FROM siparisler s
      INNER JOIN musteriler m ON m.musteri_id = s.musteri_id
      WHERE s.durumu = 'TAMAMLANDI'
        AND s.degerlendirme_puan IS NOT NULL
        AND s.degerlendirme_puan > 0
      ORDER BY s.siparis_tarihi DESC, s.siparis_id DESC
    `);
    
    console.log('[admin/customer-reviews] Found reviews:', rows.length);
    
    res.json({
      success: true,
      reviews: rows || []
    });
  } catch (error) {
    console.error('[admin/customer-reviews] Error:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Değerlendirmeler yüklenirken hata oluştu: ' + error.message 
    });
  }
});

// Get order statistics for dashboard
// Get unfinished orders count (for warning notification)
app.get('/api/siparisler/unfinished-count', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT COUNT(*) AS unfinishedCount
      FROM siparisler
      WHERE durumu NOT IN ('TAMAMLANDI', 'SEVK EDILDI', 'IPTAL')
    `);
    
    const unfinishedCount = Number(rows[0]?.unfinishedCount || 0);
    
    res.json({
      success: true,
      unfinishedCount: unfinishedCount
    });
  } catch (error) {
    console.error('Unfinished orders count error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Returns counts from siparisler table only (no joins to avoid inflation)
app.get('/api/siparisler/stats', async (req, res) => {
  try {
    // Use a single SQL query with conditional SUMs
    // All counts come from the same base dataset (siparisler table)
    const [rows] = await pool.query(`
      SELECT
        COUNT(*) AS toplam,
        SUM(durumu = 'PLANLANDI') AS planlandi,
        SUM(durumu = 'URETIMDE') AS uretimde,
        SUM(durumu = 'TAMAMLANDI') AS tamamlandi,
        SUM(durumu = 'SEVK_EDILDI') AS sevk_edildi,
        SUM(durumu = 'IPTAL') AS iptal
      FROM siparisler
    `);
    
    const result = rows[0];
    const totalOrders = Number(result.toplam) || 0;
    const planned = Number(result.planlandi) || 0;
    const inProduction = Number(result.uretimde) || 0;
    const completed = Number(result.tamamlandi) || 0;
    const shipped = Number(result.sevk_edildi) || 0;
    const cancelled = Number(result.iptal) || 0;
    
    // Verify math: total should equal sum of all statuses
    const sumOfStatuses = planned + inProduction + completed + shipped + cancelled;
    console.log('[siparisler/stats] Verification:', {
      totalOrders,
      planned,
      inProduction,
      completed,
      shipped,
      cancelled,
      sumOfStatuses,
      matches: totalOrders === sumOfStatuses,
      difference: totalOrders - sumOfStatuses
    });
    
    // If there's a mismatch, log it as a warning
    if (totalOrders !== sumOfStatuses) {
      console.warn('[siparisler/stats] WARNING: Total does not match sum of statuses. There may be orders with NULL or unexpected status values.');
    }
    
    res.json({
      success: true,
      totalOrders,
      planned,
      inProduction,
      completed,
      shipped,
      cancelled
    });
  } catch (error) {
    console.error('Order stats error:', error);
    return res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Get all customer orders with details
// Orders are created by customers via Müşteri Paneli, admin can only view/update/delete
app.get('/api/siparisler', async (req, res) => {
  try {
    // Parse pagination params
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const searchTerm = req.query.q ? String(req.query.q).trim() : null;
    
    // Build WHERE clause for search
    const hasSearch = searchTerm && searchTerm.length > 0;
    const searchCondition = hasSearch
      ? `(m.musteri_bilgisi LIKE CONCAT('%', ?, '%') OR u.urun_adi LIKE CONCAT('%', ?, '%'))`
      : '1=1';
    
    const searchParams = hasSearch ? [searchTerm, searchTerm] : [];
    
    // Get total count
    const [countRows] = await pool.query(`
      SELECT COUNT(DISTINCT s.siparis_id) AS total
      FROM siparisler s
      LEFT JOIN musteriler m ON m.musteri_id = s.musteri_id
      LEFT JOIN siparis_detay sd ON sd.siparis_id = s.siparis_id
      LEFT JOIN urunler u ON u.urun_id = sd.urun_id
      WHERE ${searchCondition}
    `, searchParams);
    
    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.ceil(total / limit);
    
    // Get paginated data
    const [rows] = await pool.query(`
      SELECT 
        s.siparis_id AS id,
        s.musteri_id,
        m.musteri_bilgisi AS musteri_adi,
        m.sehir,
        s.siparis_tarihi,
        s.teslim_plan AS teslim_tarihi,
        s.durumu AS durum,
        s.musteri_notu,
        s.degerlendirme_puan,
        s.degerlendirme_yorum,
        COALESCE(SUM(sd.adet), 0) AS adet,
        COALESCE(SUM(sd.toplam_tutar), 0) AS tutar,
        GROUP_CONCAT(DISTINCT u.urun_adi SEPARATOR ', ') AS urunler
      FROM siparisler s
      LEFT JOIN musteriler m ON m.musteri_id = s.musteri_id
      LEFT JOIN siparis_detay sd ON sd.siparis_id = s.siparis_id
      LEFT JOIN urunler u ON u.urun_id = sd.urun_id
      WHERE ${searchCondition}
      GROUP BY s.siparis_id, s.musteri_id, m.musteri_bilgisi, m.sehir, 
               s.siparis_tarihi, s.teslim_plan, s.durumu, s.musteri_notu, s.degerlendirme_puan, s.degerlendirme_yorum
      ORDER BY s.siparis_tarihi DESC, s.siparis_id DESC
      LIMIT ? OFFSET ?
    `, [...searchParams, limit, offset]);
    
    res.json({
      success: true,
      data: {
        rows: rows,
        page: page,
        limit: limit,
        total: total,
        totalPages: totalPages
      }
    });
  } catch (error) {
    console.error('Customer orders error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Get all customers (for dropdown)
app.get('/api/customers', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT musteri_id, musteri_bilgisi, sehir
      FROM musteriler
      ORDER BY musteri_bilgisi
    `);
    res.json(rows);
  } catch (error) {
    console.error('Customers error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Get all products (for dropdown)
app.get('/api/products', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        arac_model_id AS id,
        model_adi AS name
      FROM arac_modelleri
      WHERE model_adi IS NOT NULL AND TRIM(model_adi) <> ''
      ORDER BY model_adi ASC
    `);
    console.log('api/products rows:', rows.length);
    if (rows.length === 0) {
      const [countRows] = await pool.query(`SELECT COUNT(*) AS c FROM arac_modelleri`);
      console.log('api/products arac_modelleri count:', countRows[0]?.c);
    }
    const mapped = rows.map(r => ({
      id: r.id,
      name: r.name
    }));
    res.json(mapped);
  } catch (error) {
    console.error('Products error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Get price for a given vehicle model
app.get('/api/products/:aracModelId/price', async (req, res) => {
  try {
    const { aracModelId } = req.params;
    const modelId = parseInt(aracModelId, 10);
    if (!modelId) {
      return res.status(400).json({ success: false, message: 'Geçersiz model' });
    }
    const [rows] = await pool.query(
      `SELECT birim_fiyat FROM urunler WHERE arac_model_id = ? LIMIT 1`,
      [modelId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Bu model için fiyat bulunamadı.' });
    }
    return res.json({ success: true, birim_fiyat: Number(rows[0].birim_fiyat) || 0 });
  } catch (error) {
    console.error('Product price error:', error);
    return res.status(500).json({ success: false, message: 'Fiyat alınamadı' });
  }
});

const resolveCustomerId = (req) => {
  if (req.session?.customerId) return req.session.customerId;
  if (req.session?.user?.id && req.session?.user?.role === 'customer') return req.session.user.id;
  const headerId = req.headers['x-customer-id'];
  if (headerId) {
    const parsed = parseInt(headerId, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (req.query?.musteriId) {
    const parsed = parseInt(req.query.musteriId, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
};

// Create order for logged-in customer
app.post('/api/orders', async (req, res) => {
  try {
    const { aracModelId, quantity, musteri_notu } = req.body || {};
    const musteriId = resolveCustomerId(req);
    
    // Trim and validate note (max 500 chars)
    const note = musteri_notu ? String(musteri_notu).trim().substring(0, 500) : null;

    if (!musteriId) {
      return res.status(401).json({ success: false, message: 'Oturum bulunamadı' });
    }

    const parsedQty = parseInt(quantity, 10);
    const parsedModelId = parseInt(aracModelId, 10);

    if (!parsedModelId || Number.isNaN(parsedQty) || parsedQty < 1) {
      return res.status(400).json({ success: false, message: 'Geçersiz model veya adet' });
    }

    const [products] = await pool.query(
      `SELECT urun_id AS urun_id, birim_fiyat 
       FROM urunler 
       WHERE arac_model_id = ?
       LIMIT 1`,
      [parsedModelId]
    );

    if (products.length === 0) {
      return res.status(400).json({ success: false, message: 'Bu model için ürün bulunamadı' });
    }

    const product = products[0];
    const unitPrice = Number(product.birim_fiyat) || 0;
    const totalAmount = unitPrice * parsedQty;
    console.log('ORDER:', {
      arac_model_id: parsedModelId,
      urun_id: product.urun_id,
      birim_fiyat: unitPrice,
      adet: parsedQty,
      total: totalAmount
    });

    // Insert order with explicit PLANLANDI status (enum value, not Turkish text)
    // ENUM values: 'URETIMDE','PLANLANDI','TAMAMLANDI','SEVK_EDILDI','IPTAL'
    const [orderResult] = await pool.query(
      `INSERT INTO siparisler (musteri_id, siparis_tarihi, teslim_plan, durumu, musteri_notu)
       VALUES (?, CURDATE(), NULL, 'PLANLANDI', ?)`,
      [musteriId, note || null]
    );

    const siparisId = orderResult.insertId;
    
    // Verify the order was created
    if (!siparisId) {
      throw new Error('Sipariş oluşturulamadı: insertId alınamadı');
    }

    // Insert order details
    await pool.query(
      `INSERT INTO siparis_detay (siparis_id, urun_id, adet, toplam_tutar)
       VALUES (?, ?, ?, ?)`,
      [siparisId, product.urun_id, parsedQty, totalAmount]
    );

    // Fetch the created order with full details to verify status
    const [createdOrderRows] = await pool.query(`
      SELECT
        s.siparis_id,
        s.musteri_id,
        s.siparis_tarihi,
        s.teslim_plan,
        s.teslim_gercek,
        s.durumu,
        s.musteri_notu,
        COALESCE(SUM(d.adet), 0) AS toplam_adet,
        COALESCE(SUM(d.toplam_tutar), 0) AS toplam_tutar
      FROM siparisler s
      LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
      WHERE s.siparis_id = ?
      GROUP BY s.siparis_id, s.musteri_id, s.siparis_tarihi, s.teslim_plan, s.teslim_gercek, s.durumu, s.musteri_notu
    `, [siparisId]);

    const createdOrder = createdOrderRows[0] || null;
    
    // Verify status was set correctly (should be 'PLANLANDI')
    if (createdOrder && (!createdOrder.durumu || createdOrder.durumu === '')) {
      console.error('WARNING: Order created with NULL/empty status. Order ID:', siparisId);
      // Attempt to fix it
      await pool.query(
        `UPDATE siparisler SET durumu = 'PLANLANDI' WHERE siparis_id = ? AND (durumu IS NULL OR durumu = '')`,
        [siparisId]
      );
      // Re-fetch after fix
      const [fixedOrderRows] = await pool.query(`
        SELECT durumu FROM siparisler WHERE siparis_id = ?
      `, [siparisId]);
      if (fixedOrderRows[0]) {
        createdOrder.durumu = fixedOrderRows[0].durumu || 'PLANLANDI';
      }
    }
    
    // Ensure durumu is set in response
    if (createdOrder && !createdOrder.durumu) {
      createdOrder.durumu = 'PLANLANDI';
    }

    return res.status(201).json({
      success: true,
      urunId: product.urun_id,
      orderId: siparisId,
      siparis_id: siparisId,
      totalAmount,
      createdAt: new Date().toISOString(),
      order: createdOrder
    });
  } catch (error) {
    console.error('Create order error (full):', error);
    const msg = error?.sqlMessage || error?.message || 'Sipariş oluşturulamadı';
    return res.status(500).json({ success: false, message: msg });
  }
});

// NOTE: POST /api/siparisler has been disabled for admin panel.
// Customer orders can only be created through the Müşteri Paneli (Customer API).
// Admin panel can only LIST (GET), UPDATE status, and DELETE orders.

// Update customer order status
app.put('/api/siparisler/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { durumu, teslim_plan } = req.body;
    
    const updates = [];
    const values = [];
    
    if (durumu) {
      updates.push('durumu = ?');
      values.push(durumu);
    }
    if (teslim_plan !== undefined) {
      updates.push('teslim_plan = ?');
      values.push(teslim_plan || null);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Güncellenecek alan bulunamadı' });
    }
    
    values.push(id);
    
    const [result] = await pool.query(`
      UPDATE siparisler SET ${updates.join(', ')} WHERE siparis_id = ?
    `, values);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Sipariş bulunamadı' });
    }
    
    res.json({ success: true, message: 'Sipariş güncellendi' });
  } catch (error) {
    console.error('Update customer order error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Delete customer order
app.delete('/api/siparisler/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Delete order details first (foreign key constraint)
    await pool.query('DELETE FROM siparis_detay WHERE siparis_id = ?', [id]);
    
    // Delete main order
    const [result] = await pool.query('DELETE FROM siparisler WHERE siparis_id = ?', [id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Sipariş bulunamadı' });
    }
    
    res.json({ success: true, message: 'Sipariş silindi' });
  } catch (error) {
    console.error('Delete customer order error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// 📊 PERFORMANCE API ENDPOINTS
// ============================================

// Get employee average efficiency data for bar chart
app.get('/api/performance/employee-averages', async (req, res) => {
  console.log('[Performance API] Fetching ALL employee averages...');
  try {
    const [rows] = await pool.query(`
      SELECT
        p.personel_id,
        p.personel_ad_soyad,
        COALESCE(AVG(v.verimlilik), 0) AS ort_verimlilik
      FROM personel p
      LEFT JOIN vardiya_kayit v ON v.personel_id = p.personel_id
      WHERE p.aktif_mi = 1
      GROUP BY p.personel_id, p.personel_ad_soyad
      ORDER BY p.personel_id ASC
    `);
    
    console.log('[Performance API] Total employees from DB:', rows.length);
    
    // Return ALL employees, including those with 0 efficiency
    const result = rows.map(row => ({
      personel_id: row.personel_id,
      fullName: row.personel_ad_soyad || `Personel ${row.personel_id}`,
      averageEfficiency: parseFloat(row.ort_verimlilik || 0).toFixed(1)
    }));
    
    console.log('[Performance API] Returning ALL', result.length, 'employees');
    res.json(result);
  } catch (error) {
    console.error('[Performance API] Error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Get performance trend data (line chart - legacy)
app.get('/api/performance', async (req, res) => {
  try {
    // Fetch personnel data from database
    const [personnel] = await pool.query(`
      SELECT personel_id, personel_ad_soyad
      FROM personel
      WHERE aktif_mi = 1
      ORDER BY personel_id
      LIMIT 6
    `);
    
    // Generate performance data for the last 6 months
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(date.toLocaleDateString('tr-TR', { month: 'short', year: 'numeric' }));
    }
    
    // Create dataset for each employee with realistic performance values
    const datasets = personnel.map((person, index) => {
      const basePerformance = 60 + Math.random() * 25;
      const data = months.map((_, i) => {
        const variation = (Math.random() - 0.5) * 20;
        const trend = i * 2;
        return Math.min(100, Math.max(40, Math.round(basePerformance + variation + trend)));
      });
      
      return {
        personel_id: person.personel_id,
        personel_adi: person.personel_ad_soyad,
        data: data
      };
    });
    
    res.json({
      labels: months,
      datasets: datasets
    });
  } catch (error) {
    console.error('Performance API error:', error);
    // Return mock data if database query fails
    const months = ['Oca 2025', 'Şub 2025', 'Mar 2025', 'Nis 2025', 'May 2025', 'Haz 2025'];
    const mockDatasets = [
      { personel_id: 1, personel_adi: 'Ahmet Yılmaz', data: [72, 75, 78, 82, 85, 88] },
      { personel_id: 2, personel_adi: 'Mehmet Demir', data: [65, 68, 70, 72, 75, 78] },
      { personel_id: 3, personel_adi: 'Ayşe Kaya', data: [80, 82, 79, 85, 88, 92] },
      { personel_id: 4, personel_adi: 'Fatma Çelik', data: [70, 73, 76, 74, 80, 83] },
      { personel_id: 5, personel_adi: 'Ali Öztürk', data: [68, 72, 75, 78, 82, 85] }
    ];
    res.json({ labels: months, datasets: mockDatasets });
  }
});

// ============================================
// 🏆 REWARD RULES API ENDPOINTS
// ============================================

// In-memory store for reward rules (in production, use database)
let rewardRules = [
  {
    id: 1,
    minPercentage: 90,
    maxPercentage: null,
    rewardType: 'cash',
    amount: 2500,
    description: '2500 TL prim',
    isActive: true
  },
  {
    id: 2,
    minPercentage: 80,
    maxPercentage: 90,
    rewardType: 'cash',
    amount: 2000,
    description: '2000 TL prim',
    isActive: true
  },
  {
    id: 3,
    minPercentage: 60,
    maxPercentage: 80,
    rewardType: 'giftCard',
    amount: 500,
    description: '500 TL mağaza kuponu',
    isActive: true
  },
  {
    id: 4,
    minPercentage: 0,
    maxPercentage: 60,
    rewardType: 'other',
    amount: null,
    description: 'Ödül yok',
    isActive: true
  }
];
let nextRuleId = 5;

// Get all reward rules
app.get('/api/rewards/rules', (req, res) => {
  console.log('[Rewards API] Fetching all reward rules');
  res.json(rewardRules.filter(r => r.isActive));
});

// Get all reward rules (including inactive)
app.get('/api/rewards/rules/all', (req, res) => {
  console.log('[Rewards API] Fetching all reward rules (including inactive)');
  res.json(rewardRules);
});

// Create a new reward rule
app.post('/api/rewards/rules', (req, res) => {
  const { minPercentage, maxPercentage, rewardType, amount, description } = req.body;
  
  const newRule = {
    id: nextRuleId++,
    minPercentage: parseFloat(minPercentage) || 0,
    maxPercentage: maxPercentage ? parseFloat(maxPercentage) : null,
    rewardType: rewardType || 'other',
    amount: amount ? parseFloat(amount) : null,
    description: description || '',
    isActive: true
  };
  
  rewardRules.push(newRule);
  console.log('[Rewards API] Created new rule:', newRule);
  res.status(201).json(newRule);
});

// Update a reward rule
app.put('/api/rewards/rules/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const ruleIndex = rewardRules.findIndex(r => r.id === id);
  
  if (ruleIndex === -1) {
    return res.status(404).json({ error: 'Kural bulunamadı' });
  }
  
  const { minPercentage, maxPercentage, rewardType, amount, description, isActive } = req.body;
  
  rewardRules[ruleIndex] = {
    ...rewardRules[ruleIndex],
    minPercentage: minPercentage !== undefined ? parseFloat(minPercentage) : rewardRules[ruleIndex].minPercentage,
    maxPercentage: maxPercentage !== undefined ? (maxPercentage ? parseFloat(maxPercentage) : null) : rewardRules[ruleIndex].maxPercentage,
    rewardType: rewardType || rewardRules[ruleIndex].rewardType,
    amount: amount !== undefined ? (amount ? parseFloat(amount) : null) : rewardRules[ruleIndex].amount,
    description: description !== undefined ? description : rewardRules[ruleIndex].description,
    isActive: isActive !== undefined ? isActive : rewardRules[ruleIndex].isActive
  };
  
  console.log('[Rewards API] Updated rule:', rewardRules[ruleIndex]);
  res.json(rewardRules[ruleIndex]);
});

// Delete a reward rule
app.delete('/api/rewards/rules/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const ruleIndex = rewardRules.findIndex(r => r.id === id);
  
  if (ruleIndex === -1) {
    return res.status(404).json({ error: 'Kural bulunamadı' });
  }
  
  rewardRules.splice(ruleIndex, 1);
  console.log('[Rewards API] Deleted rule id:', id);
  res.json({ success: true });
});

// Get employee rewards based on current rules
app.get('/api/rewards/employee-rewards', async (req, res) => {
  console.log('[Rewards API] Calculating employee rewards...');
  try {
    // Fetch employee efficiency data
    const [employees] = await pool.query(`
      SELECT
        p.personel_id,
        p.personel_ad_soyad,
        COALESCE(AVG(v.verimlilik), 0) AS ort_verimlilik
      FROM personel p
      LEFT JOIN vardiya_kayit v ON v.personel_id = p.personel_id
      WHERE p.aktif_mi = 1
      GROUP BY p.personel_id, p.personel_ad_soyad
      ORDER BY ort_verimlilik DESC
    `);
    
    // Calculate reward for each employee
    const activeRules = rewardRules.filter(r => r.isActive);
    
    // Sort rules by priority: highest minPercentage first, then non-null maxPercentage first, then lowest maxPercentage, then id DESC
    const sortedRules = [...activeRules].sort((a, b) => {
      // First: highest minPercentage (most specific lower bound)
      if (b.minPercentage !== a.minPercentage) {
        return b.minPercentage - a.minPercentage;
      }
      // Second: non-null maxPercentage first (more specific)
      if ((a.maxPercentage === null) !== (b.maxPercentage === null)) {
        return (a.maxPercentage === null ? 1 : 0) - (b.maxPercentage === null ? 1 : 0);
      }
      // Third: lowest maxPercentage (most specific upper bound)
      if (a.maxPercentage !== null && b.maxPercentage !== null) {
        if (a.maxPercentage !== b.maxPercentage) {
          return a.maxPercentage - b.maxPercentage;
        }
      }
      // Fourth: highest id (newest rule wins tie)
      return b.id - a.id;
    });
    
    const employeeRewards = employees.map(emp => {
      const efficiency = parseFloat(emp.ort_verimlilik) || 0;
      
      // Find matching rule - check all rules and pick the first (most specific) match
      const matchingRule = sortedRules.find(rule => {
        const minOk = efficiency >= rule.minPercentage;
        const maxOk = rule.maxPercentage === null || efficiency <= rule.maxPercentage;
        return minOk && maxOk;
      });
      
      // Log for debugging (sample employee with 95-100% efficiency)
      if (efficiency >= 95 && efficiency <= 100) {
        console.log(`[Rewards API] Employee ${emp.personel_ad_soyad} (${efficiency.toFixed(1)}%): matched rule ID ${matchingRule?.id || 'none'}, description: ${matchingRule?.description || 'none'}`);
      }
      
      return {
        personel_id: emp.personel_id,
        fullName: emp.personel_ad_soyad,
        efficiency: efficiency.toFixed(1),
        reward: matchingRule ? {
          ruleId: matchingRule.id,
          type: matchingRule.rewardType,
          amount: matchingRule.amount,
          description: matchingRule.description
        } : null
      };
    });
    
    console.log('[Rewards API] Calculated rewards for', employeeRewards.length, 'employees');
    res.json(employeeRewards);
    
  } catch (error) {
    console.error('[Rewards API] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 📋 EVALUATION COMMENTS API ENDPOINT
// ============================================
app.get('/api/evaluations/comments', async (req, res) => {
  console.log('[Evaluations API] Fetching peer feedback comments...');
  try {
    // Fetch all active personnel from database
    const [personnel] = await pool.query(`
      SELECT personel_id, personel_ad_soyad
      FROM personel
      WHERE aktif_mi = 1
      ORDER BY personel_id
    `);
    
    if (!personnel || personnel.length < 2) {
      return res.json([]);
    }
    
    // Evaluation categories and sample comments
    const categories = [
      {
        name: 'Takım Çalışması',
        comments: [
          'Takım çalışmasına çok uyumlu, projelerde destek oluyor.',
          'Ekip içinde iş birliği konusunda örnek davranışlar sergiliyor.',
          'Takım arkadaşlarıyla uyum içinde çalışıyor.',
          'Grup projelerinde liderlik vasıfları gösteriyor.',
          'Takım ruhunu destekleyen bir çalışan.'
        ]
      },
      {
        name: 'İletişim',
        comments: [
          'İletişimi çok güçlü, her zaman net ve anlaşılır.',
          'Sorunları açık bir şekilde ifade edebiliyor.',
          'Müşterilerle iletişimde başarılı.',
          'Toplantılarda etkili sunum yapabiliyor.',
          'Dinleme becerileri gelişmiş.'
        ]
      },
      {
        name: 'Problem Çözme',
        comments: [
          'Karmaşık sorunlara yaratıcı çözümler üretiyor.',
          'Analitik düşünme yeteneği yüksek.',
          'Kriz anlarında soğukkanlı kalabiliyor.',
          'Problemleri hızlı tespit edip çözüm önerileri sunuyor.',
          'Zorluklar karşısında yılmıyor.'
        ]
      },
      {
        name: 'Teknik Beceri',
        comments: [
          'Teknik bilgisi üst düzeyde.',
          'Makineleri çok iyi kullanıyor.',
          'Üretim süreçlerine hakim.',
          'Kalite standartlarına dikkat ediyor.',
          'Yeni teknolojilere hızlı adapte oluyor.'
        ]
      },
      {
        name: 'Çalışma Disiplini',
        comments: [
          'Her zaman zamanında geliyor ve işini titizlikle yapıyor.',
          'Verilen görevleri eksiksiz tamamlıyor.',
          'Sorumluluk sahibi bir çalışan.',
          'İş takibi konusunda güvenilir.',
          'Düzenli ve planlı çalışıyor.'
        ]
      }
    ];
    
    // Generate evaluation comments
    const comments = [];
    let commentId = 1;
    
    // Generate comments for a subset of employees (not all combinations)
    const commentCount = Math.min(personnel.length * 2, 30);
    
    for (let i = 0; i < commentCount; i++) {
      // Pick random target and author (different people)
      const targetIndex = Math.floor(Math.random() * personnel.length);
      let authorIndex = Math.floor(Math.random() * personnel.length);
      while (authorIndex === targetIndex) {
        authorIndex = Math.floor(Math.random() * personnel.length);
      }
      
      const target = personnel[targetIndex];
      const author = personnel[authorIndex];
      const category = categories[Math.floor(Math.random() * categories.length)];
      const comment = category.comments[Math.floor(Math.random() * category.comments.length)];
      
      // Generate a random date within the last 3 months
      const daysAgo = Math.floor(Math.random() * 90);
      const createdAt = new Date();
      createdAt.setDate(createdAt.getDate() - daysAgo);
      
      comments.push({
        id: commentId++,
        targetEmployeeId: target.personel_id,
        targetEmployeeName: target.personel_ad_soyad,
        authorEmployeeId: author.personel_id,
        authorEmployeeName: author.personel_ad_soyad,
        category: category.name,
        comment: comment,
        createdAt: createdAt.toISOString()
      });
    }
    
    // Sort by date (newest first)
    comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    console.log('[Evaluations API] Returning', comments.length, 'evaluation comments');
    res.json(comments);
    
  } catch (error) {
    console.error('[Evaluations API] Error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// 📋 PERSONNEL EVALUATION API ENDPOINTS
// ============================================

// GET /api/personel/aktif - List active personnel
app.get('/api/personel/aktif', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT personel_id, personel_ad_soyad
      FROM personel
      WHERE aktif_mi = 1
      ORDER BY personel_ad_soyad ASC
    `);
    
    return res.json(rows || []);
  } catch (error) {
    console.error('Aktif personel listesi hata:', error);
    return res.status(500).json({ error: 'Aktif personel listesi alınamadı', message: error.message });
  }
});

// POST /api/personel-degerlendirme - Create evaluation
app.post('/api/personel-degerlendirme', async (req, res) => {
  try {
    const { yazar_personel_id, hedef_personel_id, kategori, yorum, puan } = req.body || {};

    const yazarId = parseInt(yazar_personel_id, 10);
    const hedefId = parseInt(hedef_personel_id, 10);

    if (!yazarId || Number.isNaN(yazarId)) {
      return res.status(400).json({ message: 'Geçersiz yazar_personel_id' });
    }

    if (!hedefId || Number.isNaN(hedefId)) {
      return res.status(400).json({ message: 'Geçersiz hedef_personel_id' });
    }

    // Prevent self-review
    if (yazarId === hedefId) {
      return res.status(400).json({ message: 'Kendiniz hakkında değerlendirme yapamazsınız' });
    }

    // Validate puan (required, 1-5)
    const puanInt = parseInt(puan, 10);
    if (!puan || Number.isNaN(puanInt) || puanInt < 1 || puanInt > 5) {
      return res.status(400).json({ message: 'Puan zorunludur ve 1 ile 5 arasında olmalıdır' });
    }

    const kategoriTrimmed = (kategori || 'Genel').toString().trim();
    const yorumTrimmed = (yorum || '').toString().trim();

    if (!yorumTrimmed || yorumTrimmed.length < 5) {
      return res.status(400).json({ message: 'Yorum en az 5 karakter olmalıdır' });
    }

    // Verify both personnel exist and are active
    const [personnelCheck] = await pool.query(
      `SELECT personel_id FROM personel WHERE personel_id IN (?, ?) AND aktif_mi = 1`,
      [yazarId, hedefId]
    );

    if (personnelCheck.length !== 2) {
      return res.status(400).json({ message: 'Geçersiz personel ID veya personel aktif değil' });
    }

    // Insert evaluation
    const [result] = await pool.query(
      `
      INSERT INTO personel_degerlendirme
        (hedef_personel_id, yazar_personel_id, kategori, puan, yorum, olusturma_tarihi)
      VALUES (?, ?, ?, ?, ?, NOW())
      `,
      [hedefId, yazarId, kategoriTrimmed, puanInt, yorumTrimmed]
    );

    if (result.affectedRows !== 1) {
      return res.status(500).json({ message: 'Değerlendirme kaydedilemedi' });
    }

    return res.status(201).json({
      success: true,
      id: result.insertId,
      message: 'Değerlendirme başarıyla gönderildi',
    });
  } catch (error) {
    console.error('Personel değerlendirme oluşturma hata:', error);
    return res.status(500).json({ message: error.message || 'Değerlendirme oluşturulamadı' });
  }
});

// GET /api/personel-degerlendirme - List all evaluations (for admin)
app.get('/api/personel-degerlendirme', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        d.id,
        d.kategori,
        d.puan,
        d.yorum,
        d.olusturma_tarihi,
        y.personel_ad_soyad AS yazar_adsoyad,
        h.personel_ad_soyad AS hedef_adsoyad
      FROM personel_degerlendirme d
      JOIN personel y ON y.personel_id = d.yazar_personel_id
      JOIN personel h ON h.personel_id = d.hedef_personel_id
      ORDER BY d.olusturma_tarihi DESC
    `);

    return res.json(rows || []);
  } catch (error) {
    console.error('Personel değerlendirme listesi hata:', error);
    return res.status(500).json({ error: 'Değerlendirme listesi alınamadı', message: error.message });
  }
});

// ============================================
// 🧾 PERSONNEL LEAVE (İZİN) API ENDPOINTS
// ============================================

// GET /api/personel/:personelId/izin-ozet?year=2025
app.get('/api/personel/:personelId/izin-ozet', async (req, res) => {
  try {
    const personelId = parseInt(req.params.personelId, 10);
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const YILLIK_TOPLAM = 24;

    if (!personelId) {
      return res.status(400).json({ error: 'Geçersiz personelId' });
    }

    const [rows] = await pool.query(
      `
      SELECT 
        SUM(CASE WHEN durum = 'Onaylandı' THEN izin_gunu ELSE 0 END) AS kullanilan,
        SUM(CASE WHEN durum = 'Beklemede' THEN izin_gunu ELSE 0 END) AS bekleyen
      FROM izin_talepleri
      WHERE personel_id = ?
        AND YEAR(baslangic_tarihi) = ?
      `,
      [personelId, year]
    );

    const kullanilan = Number(rows[0]?.kullanilan) || 0;
    const bekleyen = Number(rows[0]?.bekleyen) || 0;
    const kalan = Math.max(YILLIK_TOPLAM - kullanilan - bekleyen, 0);

    return res.json({
      yillik_toplam: YILLIK_TOPLAM,
      kullanilan,
      bekleyen,
      kalan,
    });
  } catch (error) {
    console.error('İzin özet hata:', error);
    return res.status(500).json({ error: 'İzin özeti alınamadı', message: error.message });
  }
});

// GET /api/personel/:personel_id/calisma-ozet
app.get('/api/personel/:personel_id/calisma-ozet', async (req, res) => {
  try {
    const personelId = parseInt(req.params.personel_id, 10);

    if (!personelId || Number.isNaN(personelId)) {
      return res.status(400).json({ error: 'Geçersiz personel_id' });
    }

    // Get total minutes worked (same calculation as admin panel)
    const [minutesRows] = await pool.query(
      `
      SELECT COALESCE(SUM(v.calisilan_dk), 0) AS toplam_dakika
      FROM personel p
      LEFT JOIN vardiya_kayit v ON v.personel_id = p.personel_id
      WHERE p.personel_id = ?
      `,
      [personelId]
    );

    const toplam_dakika = Number(minutesRows[0]?.toplam_dakika) || 0;

    // Check if personnel has any approved leave
    const [leaveRows] = await pool.query(
      `
      SELECT COUNT(*) AS approved_count
      FROM izin_talepleri
      WHERE personel_id = ? AND durum = 'Onaylandı'
      `,
      [personelId]
    );

    const approved_count = Number(leaveRows[0]?.approved_count) || 0;
    const multiplier = approved_count > 0 ? 18 : 20;
    const hesaplanan = toplam_dakika * multiplier;

    return res.json({
      toplam_dakika,
      multiplier,
      hesaplanan,
    });
  } catch (error) {
    console.error('Çalışma özet hata:', error);
    return res.status(500).json({ error: 'Çalışma özeti alınamadı', message: error.message });
  }
});

// GET /api/personel/:personel_id/performans-puani
app.get('/api/personel/:personel_id/performans-puani', async (req, res) => {
  try {
    const personelId = parseInt(req.params.personel_id, 10);

    if (!personelId || Number.isNaN(personelId)) {
      return res.status(400).json({ error: 'Geçersiz personel_id' });
    }

    const [rows] = await pool.query(
      `
      SELECT
        ROUND(COALESCE(AVG(puan), 0), 1) AS avg_puan,
        COALESCE(COUNT(*), 0) AS puanlayan_sayisi
      FROM personel_degerlendirme
      WHERE hedef_personel_id = ?
      `,
      [personelId]
    );

    const avg_puan = Number(rows[0]?.avg_puan) || 0;
    const puanlayan_sayisi = Number(rows[0]?.puanlayan_sayisi) || 0;

    return res.json({
      avg_puan,
      puanlayan_sayisi,
    });
  } catch (error) {
    console.error('Performans puanı hata:', error);
    return res.status(500).json({ error: 'Performans puanı alınamadı', message: error.message });
  }
});

// GET /api/personel/:personel_id/kategori-puanlari
app.get('/api/personel/:personel_id/kategori-puanlari', async (req, res) => {
  try {
    const personelId = parseInt(req.params.personel_id, 10);

    if (!personelId || Number.isNaN(personelId)) {
      return res.status(400).json({ error: 'Geçersiz personel_id' });
    }

    const [rows] = await pool.query(
      `
      SELECT
        kategori,
        ROUND(AVG(puan), 1) AS ort_puan,
        COUNT(*) AS adet
      FROM personel_degerlendirme
      WHERE hedef_personel_id = ?
      GROUP BY kategori
      `,
      [personelId]
    );

    // Define the 4 fixed categories in order
    const fixedCategories = [
      'Genel',
      'Takım Çalışması',
      'İletişim',
      'Disiplin'
    ];

    // Create a map from SQL results
    const resultMap = {};
    rows.forEach(row => {
      resultMap[row.kategori] = {
        kategori: row.kategori,
        ort_puan: Number(row.ort_puan) || 0,
        adet: Number(row.adet) || 0
      };
    });

    // Build response with all 4 categories, filling missing with 0
    const categories = fixedCategories.map(kategori => {
      if (resultMap[kategori]) {
        return resultMap[kategori];
      }
      return {
        kategori,
        ort_puan: 0,
        adet: 0
      };
    });

    return res.json({ categories });
  } catch (error) {
    console.error('Kategori puanları hata:', error);
    return res.status(500).json({ error: 'Kategori puanları alınamadı', message: error.message });
  }
});

// GET /api/personel/:personel_id/izinlerim
app.get('/api/personel/:personel_id/izinlerim', async (req, res) => {
  try {
    const personelId = parseInt(req.params.personel_id, 10);
    const YILLIK_TOPLAM = 24;

    if (!personelId || Number.isNaN(personelId)) {
      return res.status(400).json({ error: 'Geçersiz personel_id' });
    }

    // Get approved_used
    const [approvedRows] = await pool.query(
      `
      SELECT COALESCE(SUM(izin_gunu), 0) AS approved_used
      FROM izin_talepleri
      WHERE personel_id = ? AND durum = 'Onaylandı'
      `,
      [personelId]
    );

    const approved_used = Number(approvedRows[0]?.approved_used) || 0;
    const remaining = Math.max(YILLIK_TOPLAM - approved_used, 0);

    // Get all requests
    const [requestRows] = await pool.query(
      `
      SELECT 
        id, 
        baslangic_tarihi, 
        bitis_tarihi, 
        izin_gunu, 
        sebep, 
        durum, 
        olusturma_tarihi, 
        karar_tarihi, 
        karar_veren
      FROM izin_talepleri
      WHERE personel_id = ?
      ORDER BY olusturma_tarihi DESC
      `,
      [personelId]
    );

    return res.json({
      yearly_total: YILLIK_TOPLAM,
      approved_used,
      remaining,
      requests: requestRows || [],
    });
  } catch (error) {
    console.error('İzinlerim listesi hata:', error);
    return res.status(500).json({ error: 'İzinlerim listesi alınamadı', message: error.message });
  }
});

// Helper: insert leave request into izin_talepleri table
async function insertLeaveRequest(personelId, baslangic_tarihi, bitis_tarihi, sebep, yearHint) {
  if (!personelId) {
    throw new Error('Geçersiz personel_id');
  }

  if (!baslangic_tarihi || !bitis_tarihi) {
    const err = new Error('Başlangıç ve bitiş tarihleri zorunludur');
    err.statusCode = 400;
    throw err;
  }

  const sebepTrimmed = (sebep || '').toString().trim();
  if (!sebepTrimmed || sebepTrimmed.length < 5) {
    const err = new Error('İzin sebebi en az 5 karakter olmalıdır');
    err.statusCode = 400;
    throw err;
  }

  const start = new Date(baslangic_tarihi);
  const end = new Date(bitis_tarihi);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    const err = new Error('Geçerli bir tarih aralığı seçiniz');
    err.statusCode = 400;
    throw err;
  }

  // Validate that dates are not in the past
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(start);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(0, 0, 0, 0);

  if (startDate < today || endDate < today) {
    const err = new Error('Geçmiş tarihler için izin talebi oluşturamazsınız.');
    err.statusCode = 400;
    throw err;
  }

  const izinGunuServer = countBusinessDays(start, end);
  if (!izinGunuServer || izinGunuServer <= 0) {
    const err = new Error('Sadece hafta içi günleri içeren bir aralık seçiniz');
    err.statusCode = 400;
    throw err;
  }

  const requestYear = parseInt(yearHint, 10) || start.getFullYear();
  const YILLIK_TOPLAM = 24;

  // Kalan izin hesabı (onaylı + bekleyen)
  const [rows] = await pool.query(
    `
      SELECT 
        SUM(CASE WHEN durum = 'Onaylandı' THEN izin_gunu ELSE 0 END) AS kullanilan,
        SUM(CASE WHEN durum = 'Beklemede' THEN izin_gunu ELSE 0 END) AS bekleyen
      FROM izin_talepleri
      WHERE personel_id = ?
        AND YEAR(baslangic_tarihi) = ?
    `,
    [personelId, requestYear]
  );

  const kullanilan = Number(rows[0]?.kullanilan) || 0;
  const bekleyen = Number(rows[0]?.bekleyen) || 0;
  const kalan = Math.max(YILLIK_TOPLAM - kullanilan - bekleyen, 0);

  if (izinGunuServer > kalan) {
    const err = new Error('Yetersiz kalan izin günü');
    err.statusCode = 400;
    err.details = { talep_edilen: izinGunuServer, kalan };
    throw err;
  }

  let result;
  try {
    [result] = await pool.query(
      `
        INSERT INTO izin_talepleri
          (personel_id, baslangic_tarihi, bitis_tarihi, izin_gunu, sebep, durum, olusturma_tarihi)
        VALUES (?, ?, ?, ?, ?, 'Beklemede', NOW())
      `,
      [personelId, baslangic_tarihi, bitis_tarihi, izinGunuServer, sebepTrimmed]
    );

    if (result.affectedRows !== 1) {
      const err = new Error('İzin talebi kaydedilemedi');
      err.statusCode = 500;
      throw err;
    }
  } catch (dbError) {
    // Check for MySQL SIGNAL error (overlapping leave request trigger)
    if (dbError.sqlState === '45000' || 
        dbError.code === 'ER_SIGNAL_EXCEPTION' || 
        dbError.errno === 1644) {
      const err = new Error('Bu tarihlerde mevcut bir izin kaydınız var.');
      err.statusCode = 409;
      throw err;
    }
    // Re-throw other database errors
    throw dbError;
  }

  return {
    id: result.insertId,
    izin_gunu: izinGunuServer,
  };
}

// POST /api/personel/:personelId/izin-talebi (legacy, uses same logic as /api/izin-talepleri)
app.post('/api/personel/:personelId/izin-talebi', async (req, res) => {
  try {
    const personelId = parseInt(req.params.personelId, 10);
    const { baslangic_tarihi, bitis_tarihi, sebep, year } = req.body || {};

    const created = await insertLeaveRequest(personelId, baslangic_tarihi, bitis_tarihi, sebep, year);

    return res.status(201).json({
      success: true,
      message: 'İzin talebiniz gönderildi. Durum: Beklemede.',
      izin_talebi_id: created.id,
      izin_gunu: created.izin_gunu,
    });
  } catch (error) {
    console.error('İzin talebi hata:', error);
    const status = error.statusCode || 500;
    return res.status(status).json({
      success: false,
      message: error.message || 'İzin talebi oluşturulamadı',
      error: error.message || 'İzin talebi oluşturulamadı',
      detay: error.details || undefined,
    });
  }
});

// POST /api/izin-talepleri
app.post('/api/izin-talepleri', async (req, res) => {
  try {
    const { personel_id, baslangic_tarihi, bitis_tarihi, sebep, izin_gunu, year } = req.body || {};
    const personelId = parseInt(personel_id, 10);

    const created = await insertLeaveRequest(personelId, baslangic_tarihi, bitis_tarihi, sebep, year);

    return res.status(201).json({
      success: true,
      id: created.id,
      izin_gunu: created.izin_gunu,
      message: 'İzin talebi oluşturuldu.',
    });
  } catch (error) {
    console.error('İzin talebi (POST /api/izin-talepleri) hata:', error);
    const status = error.statusCode || 500;
    return res.status(status).json({
      success: false,
      error: error.message || 'İzin talebi oluşturulamadı',
      detay: error.details || undefined,
    });
  }
});

// GET /api/izin-talepleri?durum=Beklemede
app.get('/api/izin-talepleri', async (req, res) => {
  try {
    const { durum } = req.query;
    const params = [];
    let sql = `
      SELECT 
        it.id, 
        it.personel_id, 
        p.personel_ad_soyad AS personel_ad_soyad,
        it.baslangic_tarihi, 
        it.bitis_tarihi, 
        it.izin_gunu, 
        it.sebep, 
        it.durum, 
        it.olusturma_tarihi,
        it.karar_tarihi,
        it.karar_veren
      FROM izin_talepleri it
      JOIN personel p ON p.personel_id = it.personel_id
    `;
    
    if (durum) {
      sql += ' WHERE durum = ?';
      params.push(durum);
    }
    
    sql += ' ORDER BY olusturma_tarihi DESC';
    
    const [rows] = await pool.query(sql, params);
    
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('İzin talepleri listesi hata:', error);
    return res.status(500).json({ success: false, error: 'İzin talepleri alınamadı', message: error.message });
  }
});

// PATCH /api/izin-talepleri/:id
app.patch('/api/izin-talepleri/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { durum, karar_veren } = req.body;
    
    if (!durum || !['Onaylandı', 'Reddedildi', 'Beklemede'].includes(durum)) {
      return res.status(400).json({ success: false, error: 'Geçerli bir durum gerekli (Onaylandı, Reddedildi, Beklemede)' });
    }
    
    const updateFields = ['durum = ?'];
    const params = [durum];
    
    if (durum === 'Onaylandı' || durum === 'Reddedildi') {
      updateFields.push('karar_tarihi = NOW()');
      if (karar_veren) {
        updateFields.push('karar_veren = ?');
        params.push(karar_veren);
      }
    }
    
    params.push(id);
    
    const [result] = await pool.query(
      `UPDATE izin_talepleri SET ${updateFields.join(', ')} WHERE id = ?`,
      params
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'İzin talebi bulunamadı' });
    }
    
    return res.json({ success: true, message: `İzin talebi ${durum} olarak güncellendi` });
  } catch (error) {
    console.error('İzin talebi güncelleme hata:', error);
    return res.status(500).json({ success: false, error: 'İzin talebi güncellenemedi', message: error.message });
  }
});

// ============================================
// 🗂️ GENERIC API ROUTES (for tables, queries, etc.)
// ============================================
app.use('/api/fabrika', fabrikaRoutes);
app.use('/api', apiRoutes);

// ============================================
// PAGE ROUTES
// ============================================

// Ana sayfa - Login Portal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Dashboard sayfası (eski)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Fabrika - Hammadde Stok Takibi sayfası
app.get('/fabrika/hammadde-stok-takibi', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'fabrika-hammadde-stok-takibi.html'));
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Sayfa bulunamadı' });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('Sunucu hatası:', err);
  res.status(500).json({ error: 'Sunucu hatası', message: err.message });
});

// Sunucuyu başlat
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║     🏭 GÜNDOĞDU TEKSTİL API SUNUCUSU          ║
╠════════════════════════════════════════════════╣
║  Sunucu çalışıyor: http://localhost:${PORT}       ║
║  API Endpoint:     http://localhost:${PORT}/api   ║
╚════════════════════════════════════════════════╝
  `);
});

