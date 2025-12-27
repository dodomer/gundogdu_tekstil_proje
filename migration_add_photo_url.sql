-- Migration: Add photo_url column to machine_fault_reports table
-- Run this SQL script on your MySQL database

ALTER TABLE `machine_fault_reports`
ADD COLUMN `photo_url` VARCHAR(255) NULL AFTER `description`;

