-- Migration: add password support to musteriler (run once, MySQL)
-- Existing columns: musteri_id (AI PK), musteri_bilgisi, sehir
-- New columns: password_hash, created_at

ALTER TABLE musteriler
  ADD COLUMN password_hash VARCHAR(255) NULL AFTER sehir;

ALTER TABLE musteriler
  ADD COLUMN created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP AFTER password_hash;

