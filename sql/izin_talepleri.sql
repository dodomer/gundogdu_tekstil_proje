CREATE TABLE IF NOT EXISTS `izin_talepleri` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `personel_id` INT NOT NULL,
  `baslangic_tarihi` DATE NOT NULL,
  `bitis_tarihi` DATE NOT NULL,
  `izin_gunu` INT NOT NULL,
  `sebep` TEXT NOT NULL,
  `durum` VARCHAR(20) NOT NULL DEFAULT 'Beklemede',
  `olusturma_tarihi` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `karar_tarihi` DATETIME NULL,
  `karar_veren` VARCHAR(120) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_personel_id` (`personel_id`),
  CONSTRAINT `fk_izin_personel`
    FOREIGN KEY (`personel_id`) REFERENCES `personel`(`personel_id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

