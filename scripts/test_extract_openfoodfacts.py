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
        self.assertEqual(product, {"barcode": "0012345678905", "brand": "Brand", "name": "Сок", "size": None})
        self.assertIsNone(get_product({"code": "001", "product_name": "Juice"}))

    def test_localized_names_and_size(self):
        product = get_product({
            "code": "0000101209159", "brands": "Bovetti", "lang": "fr", "product_name_fr": "Chocolat", "quantity": "350 g",
        })
        self.assertEqual(product["name"], "Chocolat")
        self.assertEqual(product["size"], "350 g")

    def test_source_images_are_ignored(self):
        base = {"code": "12345678", "brands": "Brand", "product_name": "Tea"}
        product = get_product({**base, "images": {"front_en": {"rev": 3, "sizes": {"200": {}}}}})
        self.assertEqual(product, get_product(base))
        url = "https://images.openfoodfacts.org/front.jpg"
        product = get_product({**base, "image_url": url, "selected_images": {"front": {"display": {"en": url}}}})
        self.assertEqual(product, get_product(base))

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
            self.assertEqual(summary["counts"], {"read": 3, "kept": 1, "missing_required": 1, "invalid_json": 1, "duplicates": 0, "with_size": 0})
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["barcode"], "00123")
            self.assertFalse(output.with_name(output.name + ".partial").exists())
            with self.assertRaises(FileExistsError):
                extract(source, output)

    def test_duplicate_barcodes_keep_first_qualifying_record(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.jsonl.gz"
            output = Path(folder) / "products.jsonl"
            first = {"code": "00123", "brands": "Brand", "product_name": "First product"}
            records = [
                {"code": "00999", "brands": "Brand"},
                first,
                {**first, "product_name": "Later product", "quantity": "1 L", "image_url": "https://example.com/image.jpg"},
                {**first, "code": "123"},
                {**first, "code": "00999", "product_name": "Complete product"},
                first,
            ]
            with gzip.open(source, "wt", encoding="utf-8") as stream:
                for record in records:
                    stream.write(json.dumps(record) + "\n")
            with contextlib.redirect_stdout(io.StringIO()):
                summary = extract(source, output)
            products = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([product["barcode"] for product in products], ["00123", "123", "00999"])
            self.assertEqual(products[0], get_product(first))
            self.assertEqual(products[2]["name"], "Complete product")
            self.assertEqual(summary["counts"], {"read": 6, "kept": 3, "missing_required": 1, "invalid_json": 0, "duplicates": 2, "with_size": 0})


if __name__ == "__main__":
    unittest.main()
