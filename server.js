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

// Get all raw material orders (used by admin / Gündoğdu panel)
// Same data source as factory endpoint - hammadde_siparisleri table
app.get('/api/raw-material-orders', async (req, res) => {
  try {
    const rows = await listRawMaterialOrders();
    res.json(rows || []);
  } catch (error) {
    console.error('Raw material orders error:', error);
    return res.status(500).json({ error: error.message });
  }
});

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

    const today = (siparisTarihi || new Date().toISOString().slice(0, 10));

    const insertSql = `
      INSERT INTO hammadde_siparisleri 
        (hammadde_id, miktar, siparis_tarihi, durum)
      VALUES (?, ?, ?, 'BEKLEMEDE')
    `;
    const insertParams = [
      hammaddeIdFinal,
      miktarFinal,
      today
    ];

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

    res.status(201).json({ 
      success: true, 
      message: 'Hammadde siparişi oluşturuldu',
      order: createdRows && createdRows[0] ? createdRows[0] : { id: insertedId }
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
    const rows = await listRawMaterialOrders();
    const processedRows = rows.map(row => {
      if (row.siparis_tarihi) {
        const estimatedDate = addBusinessDays(row.siparis_tarihi, 7);
        return { ...row, tahmini_teslim_tarihi: estimatedDate.toISOString().split('T')[0] };
      }
      return { ...row, tahmini_teslim_tarihi: null };
    });
    res.json(processedRows || []);
  } catch (error) {
    console.error('Factory raw material orders error:', error);
    return res.status(500).json({ error: error.message });
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

// Unified endpoint - lists all hammadde siparisleri (no factory filter)
app.get('/api/hammadde-siparisleri', async (req, res) => {
  try {
    const rows = await listRawMaterialOrders();

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

    res.json(mapped || []);
  } catch (error) {
    console.error('Hammadde siparisleri error:', error);
    return res.status(500).json({ error: error.message });
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
        COALESCE(SUM(d.adet), 0) AS toplam_adet,
        COALESCE(SUM(d.toplam_tutar), 0) AS toplam_tutar
      FROM siparisler s
      LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
      WHERE s.musteri_id = ?
      GROUP BY s.siparis_id, s.siparis_tarihi, s.teslim_plan, s.teslim_gercek, s.durumu
      ORDER BY s.siparis_tarihi DESC
    `, [musteriId]);
    
    res.json(rows);
  } catch (error) {
    console.error('Customer orders error:', error);
    return res.status(500).json({ error: error.message });
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
        COALESCE(SUM(d.adet), 0) AS toplam_adet,
        COALESCE(SUM(d.toplam_tutar), 0) AS toplam_tutar
      FROM siparisler s
      LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
      WHERE s.musteri_id = ?
      GROUP BY s.siparis_id, s.siparis_tarihi, s.teslim_plan, s.teslim_gercek, s.durumu
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

// Monthly sales for bar chart
app.get('/api/reports/monthly-sales', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        DATE_FORMAT(s.siparis_tarihi, '%Y-%m') AS month,
        COALESCE(SUM(d.toplam_tutar), 0) AS total
      FROM siparisler s
      LEFT JOIN siparis_detay d ON d.siparis_id = s.siparis_id
      WHERE UPPER(TRIM(s.durumu)) <> 'IPTAL'
      GROUP BY DATE_FORMAT(s.siparis_tarihi, '%Y-%m')
      ORDER BY month ASC
    `);
    res.json(rows || []);
  } catch (error) {
    console.error('Monthly sales error:', error);
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

// Get all customer orders with details
// Orders are created by customers via Müşteri Paneli, admin can only view/update/delete
app.get('/api/siparisler', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        s.siparis_id AS id,
        s.musteri_id,
        m.musteri_bilgisi AS musteri_adi,
        m.sehir,
        s.siparis_tarihi,
        s.teslim_plan AS teslim_tarihi,
        s.durumu AS durum,
        COALESCE(SUM(sd.adet), 0) AS adet,
        COALESCE(SUM(sd.toplam_tutar), 0) AS tutar,
        GROUP_CONCAT(DISTINCT u.urun_adi SEPARATOR ', ') AS urunler
      FROM siparisler s
      LEFT JOIN musteriler m ON m.musteri_id = s.musteri_id
      LEFT JOIN siparis_detay sd ON sd.siparis_id = s.siparis_id
      LEFT JOIN urunler u ON u.urun_id = sd.urun_id
      GROUP BY s.siparis_id, s.musteri_id, m.musteri_bilgisi, m.sehir, 
               s.siparis_tarihi, s.teslim_plan, s.durumu
      ORDER BY s.siparis_tarihi DESC, s.siparis_id DESC
    `);
    res.json(rows);
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
    const { aracModelId, quantity } = req.body || {};
    const musteriId = resolveCustomerId(req);

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

    const [orderResult] = await pool.query(
      `INSERT INTO siparisler (musteri_id, siparis_tarihi, teslim_plan, durumu)
       VALUES (?, NOW(), NULL, 'AKTIF')`,
      [musteriId]
    );

    const siparisId = orderResult.insertId;

    await pool.query(
      `INSERT INTO siparis_detay (siparis_id, urun_id, adet, toplam_tutar)
       VALUES (?, ?, ?, ?)`,
      [siparisId, product.urun_id, parsedQty, totalAmount]
    );

    return res.status(201).json({
      success: true,
      urunId: product.urun_id,
      orderId: siparisId,
      totalAmount,
      createdAt: new Date().toISOString()
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
    
    const employeeRewards = employees.map(emp => {
      const efficiency = parseFloat(emp.ort_verimlilik) || 0;
      
      // Find matching rule
      const matchingRule = activeRules.find(rule => {
        const minOk = efficiency >= rule.minPercentage;
        const maxOk = rule.maxPercentage === null || efficiency < rule.maxPercentage;
        return minOk && maxOk;
      });
      
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

