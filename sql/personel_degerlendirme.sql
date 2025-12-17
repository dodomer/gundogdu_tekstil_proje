CREATE TABLE IF NOT EXISTS `personel_degerlendirme` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `yazar_personel_id` INT NOT NULL,
  `hedef_personel_id` INT NOT NULL,
  `kategori` VARCHAR(80) NOT NULL DEFAULT 'Genel',
  `yorum` TEXT NOT NULL,
  `olusturma_tarihi` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_pd_yazar` FOREIGN KEY (`yazar_personel_id`) REFERENCES `personel`(`personel_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pd_hedef` FOREIGN KEY (`hedef_personel_id`) REFERENCES `personel`(`personel_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


