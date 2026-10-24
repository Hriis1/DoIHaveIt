import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from normalize_catalog import get_record, get_size, normalize


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
            ("Brand", "Brand 50% Reduced-Sugar", "brand", "50% reduced-sugar"),
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
