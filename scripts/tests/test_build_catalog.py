import contextlib
import gzip
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

# Load the scripts from their parent directory when running tests directly
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build_catalog


class BuildCatalogTests(unittest.TestCase):
    def test_pipeline_uses_normalized_data_and_preserves_console_summaries(self):
        for tags, expected_count in ((None, 2), (["en:beverages", "en:waters"], 1)):
            with self.subTest(tags=tags), tempfile.TemporaryDirectory() as folder:
                source = Path(folder) / "source.jsonl.gz"
                data = Path(folder) / "data"
                records = [
                    {"code": "00123", "brands": "Coke", "product_name": "Local name", "product_name_en": "Coke Classic", "quantity": "0.5 L", "categories_tags": ["en:waters"]},
                    {"code": "00456", "brands": "Brand", "product_name": "Food", "categories_tags": ["en:foods"]},
                    {"code": "00789", "brands": "Brand", "product_name": "Drink", "quantity": "6 x 500 ml", "categories_tags": ["en:beverages"]},
                ]
                with gzip.open(source, "wt", encoding="utf-8") as stream:
                    for record in records:
                        stream.write(json.dumps(record) + "\n")
                with patch.object(build_catalog, "DATA_DIR", data), contextlib.redirect_stdout(io.StringIO()) as console:
                    summaries = build_catalog.build(source, "drinksAndFoods", tags=tags)
                extracted = data / "drinksAndFoods.jsonl"
                normalized = data / "drinksAndFoodsNormalized.jsonl"
                database = data / "sqlite" / "drinksAndFoods.sqlite"
                self.assertEqual(set(data.rglob("*")), {extracted, normalized, database.parent, database})
                self.assertEqual(json.loads(extracted.read_text(encoding="utf-8").splitlines()[0])["name"], "Coke Classic")
                with contextlib.closing(sqlite3.connect(database)) as connection:
                    rows = connection.execute("SELECT barcode, brand, name, size FROM catalog_products ORDER BY source_id").fetchall()
                self.assertEqual(len(rows), expected_count)
                self.assertEqual(rows[0], ("00123", "coca cola", "classic", "500 ml"))
                self.assertEqual(summaries["extract"]["category_tags"], sorted(tags) if tags is not None else None)
                self.assertEqual(summaries["convert"]["source"], str(normalized.resolve()))
                remaining = console.getvalue()
                for summary in summaries.values():
                    printed, end = json.JSONDecoder().raw_decode(remaining.lstrip())
                    self.assertEqual(printed, summary)
                    remaining = remaining.lstrip()[end:]
                self.assertEqual(remaining.strip(), "")

    def test_all_output_and_partial_conflicts_stop_before_extraction(self):
        for relative in ("catalog.jsonl", "catalogNormalized.jsonl", "sqlite/catalog.sqlite"):
            for suffix in ("", ".partial"):
                with self.subTest(relative=relative, suffix=suffix), tempfile.TemporaryDirectory() as folder:
                    source = Path(folder) / "source.gz"
                    source.write_bytes(b"source")
                    data = Path(folder) / "data"
                    conflict = data / (relative + suffix)
                    conflict.parent.mkdir(parents=True)
                    conflict.write_bytes(b"existing")
                    with patch.object(build_catalog, "DATA_DIR", data), patch.object(build_catalog, "extract") as extract:
                        with self.assertRaises(FileExistsError):
                            build_catalog.build(source, "catalog")
                        extract.assert_not_called()
                    self.assertEqual(conflict.read_bytes(), b"existing")

    def test_failure_keeps_completed_extraction_and_stops_pipeline(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.gz"
            data = Path(folder) / "data"
            with gzip.open(source, "wt", encoding="utf-8") as stream:
                stream.write(json.dumps({"code": "00123", "brands": "Brand", "product_name": "Drink"}) + "\n")
            with patch.object(build_catalog, "DATA_DIR", data), patch.object(build_catalog, "normalize", side_effect=ValueError("failed")), patch.object(build_catalog, "convert") as convert, contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, "failed"):
                    build_catalog.build(source, "catalog")
                convert.assert_not_called()
            self.assertTrue((data / "catalog.jsonl").is_file())
            self.assertFalse((data / "sqlite").exists())

    def test_filename_cannot_escape_data_folder(self):
        for filename in ("", ".", "..", "../catalog", "nested/catalog", "nested\\catalog"):
            with self.subTest(filename=filename), patch.object(build_catalog, "extract") as extract:
                with self.assertRaises(ValueError):
                    build_catalog.build("unused.gz", filename)
                extract.assert_not_called()

    def test_cli_passes_source_filename_and_tag_list(self):
        arguments = ["build_catalog.py", "source.jsonl.gz", "catalog", "--tags", "en:beverages", "en:waters"]
        with patch.object(sys, "argv", arguments), patch.object(build_catalog, "build") as build:
            build_catalog.main()
            build.assert_called_once_with(Path("source.jsonl.gz"), "catalog", tags=["en:beverages", "en:waters"])


if __name__ == "__main__":
    unittest.main()
