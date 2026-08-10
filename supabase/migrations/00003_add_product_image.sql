-- 00003_add_product_image.sql

-- Add image_url to products for UPCitemdb API integration
ALTER TABLE products ADD COLUMN image_url TEXT;
