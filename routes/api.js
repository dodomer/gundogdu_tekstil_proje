// routes/api.js - API Route Tanımlamaları
const express = require('express');
const router = express.Router();
const pool = require('../config/database');

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

module.exports = router;

