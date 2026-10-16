import contextlib
import gzip
import io
import json
from pathlib import Path
import tempfile
import unittest

from extract_openfoodfacts import extract, get_product


class ExtractProductsTests(unittest.TestCase):
    def test_preserves_strings_and_optional_fields(self):
        product = get_product({"code": "0012345678905", "brands": " Brand ", "product_name": "Сок"})
        self.assertEqual(product, {"barcode": "0012345678905", "brand": "Brand", "name": "Сок", "size": None, "image_url": None})
        self.assertIsNone(get_product({"code": "001", "product_name": "Juice"}))

    def test_localized_names_and_modern_image_metadata(self):
        product = get_product({
            "code": "0000101209159", "brands": "Bovetti", "lang": "fr", "product_name_fr": "Chocolat", "quantity": "350 g",
            "images": {"selected": {"front": {"fr": {"rev": "4", "sizes": {"400": {}}}}}},
        })
        self.assertEqual(product["name"], "Chocolat")
        self.assertEqual(product["size"], "350 g")
        self.assertEqual(product["image_url"], "https://images.openfoodfacts.org/images/products/000/010/120/9159/front_fr.4.400.jpg")

    def test_legacy_images_and_supplied_urls(self):
        base = {"code": "12345678", "brands": "Brand", "product_name": "Tea"}
        product = get_product({**base, "images": {"front_en": {"rev": 3, "sizes": {"200": {}}}}})
        self.assertEqual(product["image_url"], "https://images.openfoodfacts.org/images/products/12345678/front_en.3.200.jpg")
        url = "https://images.openfoodfacts.org/front.jpg"
        product = get_product({**base, "selected_images": {"front": {"display": {"en": url}}}})
        self.assertEqual(product["image_url"], url)

    def test_streamed_output_and_overwrite_protection(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.jsonl.gz"
            output = Path(folder) / "products.jsonl"
            records = [{"code": "00123", "brands": "Brand", "product_name": "Juice"}, {"code": "00456", "brands": "Brand"}]
            with gzip.open(source, "wt", encoding="utf-8") as stream:
                for record in records:
                    stream.write(json.dumps(record) + "\n")
                stream.write("invalid json\n")
            with contextlib.redirect_stdout(io.StringIO()):
                summary = extract(source, output)
            self.assertEqual(summary["counts"], {"read": 3, "kept": 1, "missing_required": 1, "invalid_json": 1, "with_size": 0, "with_image": 0})
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["barcode"], "00123")
            self.assertFalse(output.with_name(output.name + ".partial").exists())
            with self.assertRaises(FileExistsError):
                extract(source, output)


if __name__ == "__main__":
    unittest.main()
