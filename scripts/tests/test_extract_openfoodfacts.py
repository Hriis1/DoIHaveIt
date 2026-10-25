import contextlib
import gzip
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

# Load the scripts from their parent directory when running tests directly
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from extract_openfoodfacts import extract, get_item_status, get_product


SINGLE_PACKAGING = {
    "packagings_complete": 1,
    "packagings": [{"shape": {"id": "en:bottle"}, "number_of_units": 1}],
}


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
            records = [{**SINGLE_PACKAGING, "code": "00123", "brands": "Brand", "product_name": "Juice"}, {"code": "00456", "brands": "Brand"}]
            with gzip.open(source, "wt", encoding="utf-8") as stream:
                for record in records:
                    stream.write(json.dumps(record) + "\n")
                stream.write("invalid json\n")
            with contextlib.redirect_stdout(io.StringIO()):
                summary = extract(source, output)
            self.assertEqual(summary["counts"], {"read": 3, "kept": 1, "missing_required": 1, "invalid_json": 1, "duplicates": 0, "with_size": 0, "excluded_by_tags": 0, "excluded_multipacks": 0, "excluded_unconfirmed": 0})
            self.assertIsNone(summary["category_tags"])
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["barcode"], "00123")
            self.assertFalse(output.with_name(output.name + ".partial").exists())
            with self.assertRaises(FileExistsError):
                extract(source, output)

    def test_duplicate_barcodes_keep_first_qualifying_record(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.jsonl.gz"
            output = Path(folder) / "products.jsonl"
            first = {**SINGLE_PACKAGING, "code": "00123", "brands": "Brand", "product_name": "First product"}
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
            self.assertEqual(summary["counts"], {"read": 6, "kept": 3, "missing_required": 1, "invalid_json": 0, "duplicates": 2, "with_size": 0, "excluded_by_tags": 0, "excluded_multipacks": 0, "excluded_unconfirmed": 0})

    def test_category_tags_match_any_and_keep_first_matching_barcode(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.jsonl.gz"
            output = Path(folder) / "drinks.jsonl"
            base = {**SINGLE_PACKAGING, "brands": "Brand", "product_name": "Product"}
            records = [
                {**base, "code": "001", "categories_tags": ["en:foods"]},
                {**base, "code": "001", "product_name": "Drink", "categories_tags": ["en:beverages"]},
                {**base, "code": "002", "categories_tags": ["en:waters"]},
                {**base, "code": "003", "categories_tags": ["en:beverages", "en:waters"]},
                {**base, "code": "004"},
                {**base, "code": "005", "categories_tags": None},
                {**base, "code": "006", "categories_tags": "en:beverages"},
                {**base, "code": "007", "categories_tags": [None, {}]},
                {**base, "code": "008", "categories_tags": ["en:beverages-extra"]},
                {**base, "code": "001", "product_name": "Later drink", "categories_tags": ["en:waters"]},
            ]
            with gzip.open(source, "wt", encoding="utf-8") as stream:
                for record in records:
                    stream.write(json.dumps(record) + "\n")
            with contextlib.redirect_stdout(io.StringIO()):
                summary = extract(source, output, tags=["en:beverages", "en:waters"])
            products = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([product["barcode"] for product in products], ["001", "002", "003"])
            self.assertEqual(products[0]["name"], "Drink")
            self.assertEqual(summary["counts"]["excluded_by_tags"], 6)
            self.assertEqual(summary["counts"]["duplicates"], 1)
            self.assertEqual(summary["category_tags"], ["en:beverages", "en:waters"])

    def test_empty_category_tag_list_matches_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.jsonl.gz"
            output = Path(folder) / "products.jsonl"
            with gzip.open(source, "wt", encoding="utf-8") as stream:
                stream.write(json.dumps({"code": "001", "brands": "Brand", "product_name": "Drink", "categories_tags": ["en:beverages"]}) + "\n")
            with contextlib.redirect_stdout(io.StringIO()):
                summary = extract(source, output, tags=[])
            self.assertEqual(output.read_text(encoding="utf-8"), "")
            self.assertEqual(summary["counts"]["excluded_by_tags"], 1)

    def test_explicit_individual_descriptions(self):
        for quantity in ("1 x 500 ml", "1×0.5 L", "1 bottle", "1 can", "1pcs", "single can"):
            with self.subTest(quantity=quantity):
                self.assertEqual(get_item_status({"quantity": quantity}), "individual")

    def test_multipack_descriptions_override_single_evidence(self):
        for description in ("6 x 330 ml", "330ml x6", "2×6×330 ml", "4*10oz", "12pack", "6-pack", "pack of 6", "6 bottles", "Twin pack", "multipack", "bundle", "variety pack"):
            with self.subTest(description=description):
                self.assertEqual(get_item_status({**SINGLE_PACKAGING, "quantity": "1 x 500 ml", "product_name_fr": description}), "multipack")
        self.assertEqual(get_item_status({**SINGLE_PACKAGING, "packaging_tags": ["en:multi-pack"]}), "multipack")
        self.assertEqual(get_item_status({**SINGLE_PACKAGING, "abbreviated_product_name_en": "6 cans"}), "multipack")

    def test_plain_sizes_and_unknown_packaging_are_unconfirmed(self):
        for product in ({}, {"quantity": "500 ml"}, {"quantity": "350 g"}, {"quantity": None},
                        {"product_quantity": 500, "product_quantity_unit": "ml", "serving_size": "500 ml"},
                        {"quantity": "1 pack"}, {**SINGLE_PACKAGING, "product_name": "Gift box"},
                        {**SINGLE_PACKAGING, "quantity": "1 x 500 ml + 1 x 500 ml"},
                        {**SINGLE_PACKAGING, "packagings_complete": 0}):
            with self.subTest(product=product):
                self.assertEqual(get_item_status(product), "unconfirmed")

    def test_packaging_components_are_not_individual_items(self):
        bottle = {"shape": {"id": "en:bottle"}, "number_of_units": 1}
        cap = {"shape": {"id": "en:bottle-cap"}, "number_of_units": 1}
        label = {"shape": "en:label", "number_of_units": 2}
        product = {"packagings_complete": True, "packagings": [bottle, cap, label]}
        self.assertEqual(get_item_status(product), "individual")
        self.assertEqual(get_item_status({**product, "packagings": [cap, label]}), "unconfirmed")
        self.assertEqual(get_item_status({**product, "packagings": [bottle, bottle, cap]}), "multipack")
        self.assertEqual(get_item_status({**product, "packagings_complete": 0, "packagings": [{**bottle, "number_of_units": 6}]}), "multipack")
        for packaging in (None, {}, {"shape": "en:box", "number_of_units": 1},
                          {**bottle, "number_of_units": None}, {**bottle, "number_of_units": True},
                          {**bottle, "number_of_units": "1"}, {**bottle, "number_of_units": 0}):
            with self.subTest(packaging=packaging):
                self.assertEqual(get_item_status({**product, "packagings": [packaging]}), "unconfirmed")
                self.assertEqual(get_item_status({**product, "quantity": "1 x 500 ml", "packagings": [bottle, packaging]}), "unconfirmed")

    def test_excluded_items_do_not_reserve_barcodes(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.jsonl.gz"
            output = Path(folder) / "products.jsonl"
            base = {"code": "00123", "brands": "Brand", "product_name": "Drink", "categories_tags": ["en:beverages"]}
            records = [
                {**base, "quantity": "6 x 500 ml"},
                {**base, "quantity": "500 ml"},
                {**base, **SINGLE_PACKAGING},
                {**base, **SINGLE_PACKAGING},
                {**base, "code": "002", "quantity": "1 can", "categories_tags": ["en:foods"]},
            ]
            with gzip.open(source, "wt", encoding="utf-8") as stream:
                for record in records:
                    stream.write(json.dumps(record) + "\n")
            with contextlib.redirect_stdout(io.StringIO()):
                summary = extract(source, output, tags=["en:beverages"])
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), get_product(base))
            self.assertEqual(summary["counts"], {"read": 5, "kept": 1, "missing_required": 0, "invalid_json": 0, "duplicates": 1, "with_size": 0, "excluded_by_tags": 1, "excluded_multipacks": 1, "excluded_unconfirmed": 1})
            saved_summary = json.loads(output.with_name(output.name + ".summary.json").read_text(encoding="utf-8"))
            self.assertEqual(saved_summary["counts"], summary["counts"])


if __name__ == "__main__":
    unittest.main()
