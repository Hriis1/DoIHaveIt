import contextlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

# Load the scripts from their parent directory when running tests directly
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jsonl_to_sqlite import convert


class ConvertCatalogTests(unittest.TestCase):
    def get_conversion(self, folder, records):
        source = Path(folder) / "products.jsonl"
        output = Path(folder) / "products.sqlite"
        source.write_text("\n".join(json.dumps(record, ensure_ascii=False) for record in records), encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()):
            summary = convert(source, output)
        return source, output, summary

    def test_schema_unicode_leading_zeros_and_optional_sizes(self):
        with tempfile.TemporaryDirectory() as folder:
            records = [
                {"barcode": "00123", "brand": "Марка", "name": "Сок", "size": "1 L"},
                {"barcode": "123", "brand": "Brand", "name": "Water"},
                {"barcode": "00456", "brand": "Brand", "name": "Tea", "size": None},
            ]
            source, output, summary = self.get_conversion(folder, records)
            with contextlib.closing(sqlite3.connect(output)) as database:
                rows = database.execute("SELECT * FROM catalog_products ORDER BY source_id;").fetchall()
                self.assertEqual(rows, [(1, "00123", "Марка", "Сок", "1 L"), (2, "123", "Brand", "Water", None), (3, "00456", "Brand", "Tea", None)])
                self.assertEqual(database.execute("PRAGMA integrity_check;").fetchone(), ("ok",))
                self.assertEqual(database.execute("SELECT name FROM sqlite_master WHERE type = 'table';").fetchall(), [("catalog_products",)])
                with self.assertRaises(sqlite3.IntegrityError):
                    database.execute("INSERT INTO catalog_products (barcode, brand, name) VALUES ('00123', 'Other', 'Other');")
            self.assertEqual(summary["counts"], {"read": 3, "kept": 3, "duplicates": 0})
            self.assertTrue(source.exists())
            self.assertFalse(output.with_name(output.name + ".partial").exists())

    def test_first_barcode_wins_across_batches(self):
        with tempfile.TemporaryDirectory() as folder:
            first = {"barcode": "00123", "brand": "Brand", "name": "First"}
            records = [first, *({**first, "barcode": str(index + 100000)} for index in range(1000)), {**first, "name": "Later"}]
            _, output, summary = self.get_conversion(folder, records)
            with contextlib.closing(sqlite3.connect(output)) as database:
                self.assertEqual(database.execute("SELECT name FROM catalog_products WHERE barcode = '00123';").fetchone(), ("First",))
            self.assertEqual(summary["counts"], {"read": 1002, "kept": 1001, "duplicates": 1})

    def test_invalid_late_record_does_not_publish_partial_catalog(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.jsonl"
            output = Path(folder) / "products.sqlite"
            record = {"barcode": "00123", "brand": "Brand", "name": "Product"}
            source.write_text((json.dumps(record) + "\n") * 1000 + "{bad}\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Line 1001"):
                convert(source, output)
            self.assertFalse(output.exists())
            partial = output.with_name(output.name + ".partial")
            self.assertTrue(partial.exists())
            with contextlib.closing(sqlite3.connect(partial)) as database:
                self.assertEqual(database.execute("SELECT COUNT(*) FROM catalog_products;").fetchone(), (0,))

    def test_invalid_fields_and_utf8_are_rejected(self):
        valid = {"barcode": "00123", "brand": "Brand", "name": "Product"}
        invalid = [None, [], {}, {**valid, "barcode": 123}, {**valid, "brand": " "}, {**valid, "size": 10}]
        for record in invalid:
            with self.subTest(record=record), tempfile.TemporaryDirectory() as folder:
                with self.assertRaisesRegex(ValueError, "Line 1"):
                    self.get_conversion(folder, [record])
                self.assertFalse((Path(folder) / "products.sqlite").exists())
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.jsonl"
            source.write_bytes(b"\xff\n")
            with self.assertRaisesRegex(ValueError, "Line 1"):
                convert(source, Path(folder) / "output.sqlite")

    def test_existing_outputs_and_partials_are_not_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.jsonl"
            source.write_text("", encoding="utf-8")
            for name in ("existing.sqlite", "unfinished.sqlite"):
                output = Path(folder) / name
                protected = output if name == "existing.sqlite" else output.with_name(output.name + ".partial")
                protected.write_bytes(b"keep me")
                with self.assertRaises(FileExistsError):
                    convert(source, output)
                self.assertEqual(protected.read_bytes(), b"keep me")


if __name__ == "__main__":
    unittest.main()
