// Read all linked brands in a stable order without multiplying product rows
export const productBrandNamesSql = `COALESCE((
  SELECT group_concat(name, ', ') FROM (
    SELECT b.name FROM product_brands AS pb
    JOIN brands AS b ON b.id = pb.brand_id
    WHERE pb.product_id = p.id
    ORDER BY b.name COLLATE NOCASE, b.id
  )
), '')`
