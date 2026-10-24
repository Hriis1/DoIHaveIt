import contextlib
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

# Load the scripts from their parent directory when running tests directly
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from normalize_catalog import get_record, get_size, normalize
from jsonl_to_sqlite import convert


class NormalizeCatalogTests(unittest.TestCase):
    def get_product(self, **changes):
        return {"barcode": "00123", "brand": "Brand", "name": "Drink", "size": "500ml", **changes}

    def get_identity(self, record):
        normalized = get_record(record, 1)
        return tuple(normalized[field] for field in ("brand", "name", "size"))

    def test_monster_barcodes_share_identity(self):
        first = self.get_product(barcode="5061013947565", brand="Monster Energy Company, monster", name="Monster Energy - Ultra Strawberry Dreams")
        second = self.get_product(barcode="5056784901380", brand="Monster Energy", name="Ultra Strawberry Dreams")
        self.assertEqual(self.get_identity(first), ("monster energy", "ultra strawberry dreams", "500 ml"))
        self.assertEqual(self.get_identity(first), self.get_identity(second))
        variants = [
            self.get_product(brand="MONSTER", name="Monster Energy \u2014 Ultra Strawberry Dreams", size="0,5 L"),
            self.get_product(brand="Monster, Monster Energy", name="Monster Ultra Strawberry Dreams", size="50 cl"),
        ]
        for variant in variants:
            self.assertEqual(self.get_identity(first), self.get_identity(variant))

    def test_unknown_sizes_match_each_other_but_not_known_sizes(self):
        first = self.get_product(barcode="00123", size=None)
        second = self.get_product(barcode="00456", size=None)
        self.assertEqual(self.get_identity(first), self.get_identity(second))
        self.assertNotEqual(self.get_identity(first), self.get_identity(self.get_product()))
        self.assertNotEqual(self.get_identity(self.get_product()), self.get_identity(self.get_product(size="250 ml")))

    def test_coke_aliases_share_brand_and_product_identity(self):
        aliases = ("Coke", "Coca-Cola", "Coca Cola", "CocaCola", "The Coca-Cola", "Coca-Cola\u00ae", "Coca-Cola, Coke", "Coke, The Coca-Cola Company")
        for alias in aliases:
            with self.subTest(alias=alias):
                record = get_record(self.get_product(brand=alias, name="Coke Original Taste"), 1)
                self.assertEqual((record["brand"], record["name"]), ("coca cola", "original taste"))
                self.assertEqual(get_record(record, 1), record)
        for name in ("Coke", "Coca-Cola", "CocaCola"):
            record = get_record(self.get_product(brand="Coke", name=name), 1)
            self.assertEqual((record["brand"], record["name"]), ("coca cola", "coca cola"))

    def test_coke_brand_variants_remain_in_product_names(self):
        examples = [
            ("Diet Coke", "Diet Coke Lime", "diet lime"),
            ("Coke", "Diet Coke Lime", "diet lime"),
            ("Diet Coke", "Cherry", "diet cherry"),
            ("Diet Coke Plus", "Diet Cola", "plus diet cola"),
            ("Coke Zero", "Coca-Cola", "zero"),
            ("Coca-Cola Zero Sugar", "Cherry", "zero sugar cherry"),
            ("Coca-Cola Light", "Coca Cola", "light"),
            ("Coca-Cola Life", "Cola", "life cola"),
            ("Coke Cherry Zero", "Coca Cola Cherry", "zero cherry"),
            ("Coca-Cola, Coca-Cola Light", "Coca Cola Zero", "light zero"),
        ]
        for brand, name, expected_name in examples:
            with self.subTest(brand=brand, name=name):
                record = get_record(self.get_product(brand=brand, name=name), 1)
                self.assertEqual((record["brand"], record["name"]), ("coca cola", expected_name))
                self.assertEqual(get_record(record, 1), record)
        ordinary = self.get_identity(self.get_product(brand="Coke", name="Coke"))
        self.assertNotEqual(ordinary, self.get_identity(self.get_product(brand="Coke Zero", name="Coke")))
        self.assertNotEqual(ordinary, self.get_identity(self.get_product(brand="Diet Coke", name="Coke")))

    def test_coca_cola_company_labels_do_not_replace_other_brands(self):
        examples = [
            ("Coca-Cola Services SA/NV", "Coca-Cola Original", "coca cola", "original"),
            ("The Coca-Cola Company", "Coca-Cola", "coca cola", "coca cola"),
            ("Coca-Cola Company, Fanta", "Fanta Orange", "fanta", "orange"),
            ("Sprite, The Coca-Cola Company", "Sprite Lemon Lime", "sprite", "lemon lime"),
            ("Coca-Cola Company, Monster, Monster Energy", "Ultra Strawberry Dreams", "monster energy", "ultra strawberry dreams"),
            ("Coca-Cola Company", "Minute Maid Pommes", "coca cola company", "minute maid pommes"),
            ("Coke Farm", "Farm Drink", "coke farm", "farm drink"),
        ]
        for brand, name, expected_brand, expected_name in examples:
            with self.subTest(brand=brand, name=name):
                record = get_record(self.get_product(brand=brand, name=name), 1)
                self.assertEqual((record["brand"], record["name"]), (expected_brand, expected_name))
                self.assertEqual(get_record(record, 1), record)

    def test_hyphens_become_spaces_in_all_normalized_text_fields(self):
        record = get_record(self.get_product(barcode="001-23", brand="Acme-Co", name="Acme-Co Sugar-Free\u2014Drink", size="pack-of-6"), 1)
        self.assertEqual(record, {"barcode": "001-23", "brand": "acme co", "name": "sugar free drink", "size": "pack of 6"})
        self.assertEqual(get_size("500-ml"), "500 ml")
        for dash in ("-", "\u2010", "\u2011", "\u2012", "\u2013", "\u2014"):
            with self.subTest(dash=dash):
                self.assertEqual(get_record(self.get_product(brand=f"Coca{dash}Cola", name=f"Coke{dash}Zero"), 1)["name"], "zero")

    def test_diet_flavor_mass_volume_and_pack_variants_remain_distinct(self):
        ordinary = self.get_identity(self.get_product())
        for changes in ({"name": "Drink Zero Sugar"}, {"name": "Drink Strawberry"}, {"size": "500 g"}, {"size": "6 x 500 ml"}):
            with self.subTest(changes=changes):
                self.assertNotEqual(ordinary, self.get_identity(self.get_product(**changes)))
        self.assertNotEqual(get_size("4 x 125g"), get_size("500g"))
        self.assertEqual(get_size("500 g (4x125g)"), "4 x 125 g")
        self.assertEqual(get_size("4x125g (0.5kg)"), "4 x 125 g")
        self.assertNotEqual(get_size("600 g (4x125g)"), "4 x 125 g")

    def test_units_and_uncertain_sizes(self):
        examples = {"0.5 L": "500 ml", "0,5l": "500 ml", "50 CL": "500 ml", "1 kg": "1000 g", "1000mg": "1 g", "1.50 g": "1.5 g", "4\u00d7125g": "4 x 125 g", "16oz": "16 oz", "12 fl. oz.": "12 fl oz", "2pieces": "2 pcs", "1 serving(s)": "1 serving", "1/2l": "1/2l", "1,000 ml": "1,000 ml", "473 ml, 16 fl oz": "473 ml, 16 fl oz", "unknown": "unknown", "0g": "0g", None: None}
        for original, expected in examples.items():
            with self.subTest(original=original):
                self.assertEqual(get_size(original), expected)
                self.assertEqual(get_size(expected), expected)

    def test_parent_manufacturers_and_brand_boundaries_are_preserved(self):
        examples = [
            ("Monster Energy Company", "Hubert's Lemonade", "monster energy company", "hubert's lemonade"),
            ("Hansen's, Monster Energy Company", "Hansen's Strawberry", "hansen's, monster energy company", "strawberry"),
            ("Monster Munch", "Monster Munch Original", "monster munch", "original"),
            ("Brand", "Brandy", "brand", "brandy"),
            ("Brand", "Brand", "brand", "brand"),
            ("Monster", "Monster Energy", "monster energy", "monster energy"),
            ("Brand", "Brand 50% Reduced-Sugar", "brand", "50% reduced sugar"),
        ]
        for brand, name, expected_brand, expected_name in examples:
            with self.subTest(brand=brand, name=name):
                record = get_record(self.get_product(brand=brand, name=name), 1)
                self.assertEqual((record["brand"], record["name"]), (expected_brand, expected_name))
                self.assertEqual(get_record(record, 1), record)
        accented = get_record(self.get_product(brand=" Nestl\u00e9, NESTL\u00c9 ", name="Nestl\u00e9 Caf\u00e9"), 1)
        self.assertEqual((accented["brand"], accented["name"]), ("nestl\u00e9", "caf\u00e9"))
        first = self.get_product(name="Tea ,Peppermint \u2013 Sugar Free")
        second = self.get_product(name="Tea, Peppermint-Sugar Free")
        self.assertEqual(self.get_identity(first), self.get_identity(second))

    def test_streaming_preserves_source_barcodes_and_records(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / "source.jsonl", Path(folder) / "normalized.jsonl"
            records = [self.get_product(), self.get_product(barcode="00456"), self.get_product(barcode="00789", size=None)]
            source.write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")
            original_bytes = source.read_bytes()
            with contextlib.redirect_stdout(io.StringIO()):
                summary = normalize(source, output)
            normalized = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([record["barcode"] for record in normalized], ["00123", "00456", "00789"])
            self.assertEqual(self.get_identity(normalized[0]), self.get_identity(normalized[1]))
            self.assertEqual(source.read_bytes(), original_bytes)
            self.assertEqual(summary["source_sha256"], hashlib.sha256(original_bytes).hexdigest())
            self.assertEqual(summary["output_sha256"], hashlib.sha256(output.read_bytes()).hexdigest())
            self.assertTrue(summary["null_sizes_match"])
            self.assertEqual(summary["counts"]["records"], 3)
            with self.assertRaises(FileExistsError):
                normalize(source, output)

    def test_empty_normalized_brand_or_name_is_skipped_before_coke_name_fallback(self):
        examples = [
            {"brand": "-"}, {"name": "-"}, {"brand": "--", "name": "\u2014"},
            {"brand": "Coke", "name": " - \u2014 "},
        ]
        for changes in examples:
            with self.subTest(changes=changes):
                self.assertIsNone(get_record(self.get_product(**changes), 1))
        self.assertIsNone(get_record(self.get_product(size="-"), 1)["size"])

    def test_skipped_records_are_counted_and_remaining_catalog_converts_to_sqlite(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.jsonl"
            output = Path(folder) / "normalized.jsonl"
            sqlite_output = Path(folder) / "catalog.sqlite"
            records = [
                self.get_product(),
                self.get_product(barcode="00234", brand="-"),
                self.get_product(barcode="00345", size=None),
                self.get_product(barcode="00456", name="-"),
                self.get_product(barcode="00567", brand="Coke", name="-"),
                self.get_product(barcode="00678", brand="-", name="-"),
                self.get_product(barcode="00789", size="-"),
            ]
            source.write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")
            original_bytes = source.read_bytes()
            with contextlib.redirect_stdout(io.StringIO()):
                summary = normalize(source, output)
                conversion = convert(output, sqlite_output)
            normalized = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([record["barcode"] for record in normalized], ["00123", "00345", "00789"])
            self.assertEqual([record["size"] for record in normalized], ["500 ml", None, None])
            self.assertEqual(summary["counts"]["read"], 7)
            self.assertEqual(summary["counts"]["records"], 3)
            self.assertEqual(summary["counts"]["skipped_empty_required"], 4)
            self.assertEqual(summary["counts"]["null_sizes"], 2)
            self.assertEqual(summary["source_sha256"], hashlib.sha256(original_bytes).hexdigest())
            self.assertEqual(summary["output_sha256"], hashlib.sha256(output.read_bytes()).hexdigest())
            self.assertEqual(source.read_bytes(), original_bytes)
            self.assertEqual(conversion["counts"]["kept"], 3)
            with contextlib.closing(sqlite3.connect(sqlite_output)) as database:
                self.assertEqual(database.execute("SELECT barcode FROM catalog_products ORDER BY source_id;").fetchall(), [("00123",), ("00345",), ("00789",)])

    def test_invalid_records_do_not_publish_output(self):
        invalid = [None, {}, self.get_product(barcode=123), self.get_product(size=500), self.get_product(name=" ")]
        for record in invalid:
            with self.subTest(record=record), tempfile.TemporaryDirectory() as folder:
                source, output = Path(folder) / "source.jsonl", Path(folder) / "normalized.jsonl"
                source.write_text(json.dumps(record) + "\n", encoding="utf-8")
                with self.assertRaises(ValueError):
                    normalize(source, output)
                self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
