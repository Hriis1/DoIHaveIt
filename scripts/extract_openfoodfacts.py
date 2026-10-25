"""Stream an Open Food Facts dump into a compact catalog, excluding identifiable multipacks."""

import argparse
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import re
import time


# Packaging components such as caps and labels do not represent additional items
ITEM_SHAPES = {
    "en:bottle", "en:bottle-or-vial", "en:vial", "en:can", "en:drink-can",
    "en:food-can", "en:jar", "en:pot", "en:individual-pot", "en:tumbler",
    "en:tube", "en:brick", "en:small-brick", "en:jug", "en:jug-or-canister",
}
ACCESSORY_SHAPES = {
    "en:lid-or-cap", "en:lid", "en:cap", "en:bottle-cap", "en:crown-cork",
    "en:screw-cap", "en:flip-top", "en:grinder-cap", "en:wine-cork",
    "en:label", "en:film", "en:seal", "en:straw", "en:spoon",
}
UNIT_WORDS = r"(?:bottles?|cans?|jars?|pots?|cups?|tubes?|cartons?|pieces?|pcs|units?|items?)"
COUNT_PATTERNS = [
    re.compile(r"(?<![\w.,])([0-9]+)\s*[x×*](?=\s*\d)", re.IGNORECASE),
    re.compile(rf"(?<![\w.,])([0-9]+)\s*{UNIT_WORDS}\b", re.IGNORECASE),
    re.compile(r"\b(?:pack|case|box)\s+of\s+([0-9]+)\b", re.IGNORECASE),
    re.compile(r"(?<![\w.,])([0-9]+)\s*[- ]?\s*packs?\b", re.IGNORECASE),
    re.compile(r"\b\d+(?:[.,]\d+)?\s*(?:ml|cl|dl|l|mg|kg|g|oz|fl\s*oz)\s*[x×*]\s*([0-9]+)\b", re.IGNORECASE),
]
SINGLE_DESCRIPTION = re.compile(
    rf"\bsingle\s+{UNIT_WORDS}\b|(?<![\w.,])1\s*{UNIT_WORDS}\b|"
    r"(?<![\w.,])1\s*[x×*]\s*\d+(?:[.,]\d+)?\s*(?:ml|cl|dl|l|mg|kg|g|oz|fl\s*oz)\b",
    re.IGNORECASE,
)
MULTIPACK_DESCRIPTION = re.compile(
    r"\b(?:multi[ -]?packs?|multipacks?|twin[ -]?packs?|bundles?|variety\s+packs?|"
    r"assorted\s+packs?|duo\s+packs?|double\s+packs?|triple\s+packs?)\b",
    re.IGNORECASE,
)
AMBIGUOUS_PACK_DESCRIPTION = re.compile(r"\b(?:packs?|cases?|box(?:es)?|sets?|bogo)\b|\+", re.IGNORECASE)


def get_text(value):
    return value.strip() if isinstance(value, str) else ""


def get_languages(product, available):
    # Prefer the product's language, then English, then other available languages
    preferred = [get_text(product.get("lang")), "en", *sorted(available)]
    return list(dict.fromkeys(language for language in preferred if language))


def get_name(product):
    # Prefer English before the main name and existing language fallbacks
    name = get_text(product.get("product_name_en"))
    if name:
        return name
    name = get_text(product.get("product_name"))
    if name:
        return name
    available = [key[13:] for key in product if key.startswith("product_name_") and len(key[13:]) <= 3]
    for language in get_languages(product, available):
        name = get_text(product.get(f"product_name_{language}"))
        if name:
            return name
    return ""


def get_packaging_status(product):
    packagings = product.get("packagings")
    if not isinstance(packagings, list) or not packagings:
        return "unconfirmed"
    item_count = 0
    uncertain = False
    for packaging in packagings:
        if not isinstance(packaging, dict):
            uncertain = True
            continue
        shape = packaging.get("shape")
        shape = get_text(shape.get("id")) if isinstance(shape, dict) else get_text(shape)
        if shape in ACCESSORY_SHAPES:
            continue
        count = packaging.get("number_of_units")
        if shape not in ITEM_SHAPES or type(count) is not int or count < 1:
            uncertain = True
            continue
        item_count += count
    if item_count > 1:
        return "multipack"
    if uncertain:
        return "ambiguous"
    if item_count == 1 and not uncertain and product.get("packagings_complete") in (True, 1):
        return "individual"
    return "unconfirmed"


def get_item_status(product):
    # Check every available name so a localized multipack description still wins
    descriptions = [get_text(product.get(key)) for key in product if (
        key in ("quantity", "packaging", "product_name", "abbreviated_product_name")
        or key.startswith(("product_name_", "abbreviated_product_name_"))
    )]
    packaging_tags = product.get("packaging_tags")
    if isinstance(packaging_tags, list):
        descriptions.extend(get_text(tag).replace("-", " ") for tag in packaging_tags)
    packaging_status = get_packaging_status(product)
    if packaging_status == "multipack":
        return "multipack"
    for description in descriptions:
        if MULTIPACK_DESCRIPTION.search(description) or any(
            int(match.group(1)) > 1
            for pattern in COUNT_PATTERNS for match in pattern.finditer(description)
        ):
            return "multipack"
    # Generic pack descriptions remain uncertain even when one container is listed
    if packaging_status == "ambiguous" or any(AMBIGUOUS_PACK_DESCRIPTION.search(description) for description in descriptions):
        return "unconfirmed"
    if packaging_status == "individual" or any(SINGLE_DESCRIPTION.search(description) for description in descriptions):
        return "individual"
    return "unconfirmed"


def get_product(product):
    # Require identifying fields without inventing missing brand or product names
    barcode = get_text(product.get("code"))
    brand = get_text(product.get("brands"))
    name = get_name(product)
    if not barcode or not brand or not name:
        return None
    return {
        "barcode": barcode,
        "brand": brand,
        "name": name,
        "size": get_text(product.get("quantity")) or None,
    }


def extract(source, output, tags=None):
    selected_tags = None if tags is None else set(tags)
    source = Path(source).resolve()
    output = Path(output).resolve()
    partial = output.with_name(output.name + ".partial")
    if not source.is_file():
        raise FileNotFoundError(source)
    for path in (output, partial):
        if path.exists():
            raise FileExistsError(f"Refusing to overwrite {path}")
    output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    started_at = datetime.now(timezone.utc).isoformat()
    total_bytes = source.stat().st_size
    counts = {"read": 0, "kept": 0, "missing_required": 0, "invalid_json": 0, "duplicates": 0, "with_size": 0, "excluded_by_tags": 0, "excluded_multipacks": 0}
    seen_barcodes = set()
    last_progress = started

    # Process one compressed JSONL record at a time, verifying gzip integrity at EOF
    with source.open("rb") as compressed, gzip.GzipFile(fileobj=compressed) as records, partial.open("x", encoding="utf-8", newline="\n") as destination:
        for line in records:
            counts["read"] += 1
            try:
                product = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                counts["invalid_json"] += 1
                continue
            if not isinstance(product, dict):
                counts["invalid_json"] += 1
                continue
            # Match any requested category before extracting or reserving its barcode
            categories = product.get("categories_tags")
            if selected_tags is not None and (
                not isinstance(categories, list)
                or not any(isinstance(tag, str) and tag in selected_tags for tag in categories)
            ):
                counts["excluded_by_tags"] += 1
            else:
                compact = get_product(product)
                item_status = get_item_status(product) if compact is not None else None
                if compact is None:
                    counts["missing_required"] += 1
                elif item_status == "multipack":
                    counts["excluded_multipacks"] += 1
                elif compact["barcode"] in seen_barcodes:
                    counts["duplicates"] += 1
                else:
                    # Keep the first qualifying record for each barcode
                    destination.write(json.dumps(compact, ensure_ascii=False, separators=(",", ":")) + "\n")
                    seen_barcodes.add(compact["barcode"])
                    counts["kept"] += 1
                    counts["with_size"] += compact["size"] is not None
            now = time.monotonic()
            if now - last_progress >= 10:
                print(f"{compressed.tell() / total_bytes:.1%} read | {counts['read']:,} records | {counts['kept']:,} kept | {now - started:.0f}s", flush=True)
                last_progress = now

    # Publish only complete output; interrupted runs retain an identifiable partial file
    partial.rename(output)
    summary = {
        "source": str(source),
        "output": str(output),
        "source_bytes": total_bytes,
        "output_bytes": output.stat().st_size,
        "started_at": started_at,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "elapsed_seconds": round(time.monotonic() - started, 1),
        "counts": counts,
        "category_tags": sorted(selected_tags) if selected_tags is not None else None,
        "attribution": "Open Food Facts contributors",
        "source_url": "https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz",
        "database_license": "ODbL-1.0",
        "license_url": "https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/tutorials/license-be-on-the-legal-side/",
        "notes": [
            "International coverage; no country filter.",
            "Identifiable multipacks are excluded using quantity, product descriptions, and recognized packaging container counts.",
            "Uncertain records, plain weights or volumes, and missing or incomplete packaging data are retained when no multipack evidence is recognized. Undetected multipacks may remain.",
            "Missing sizes are null. Prefer the English product name, then product_name, then the product's language and other available languages; retain the selected text without translation.",
            "The first qualifying record for each barcode is retained; later duplicates are skipped. No database import was performed.",
        ],
    }
    print(json.dumps(summary, ensure_ascii=True, indent=2), flush=True)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Downloaded .jsonl.gz file")
    parser.add_argument("output", type=Path, help="Destination .jsonl file (must not already exist)")
    parser.add_argument("--tags", nargs="+", help="Include products matching at least one exact categories_tags value; omit to include all categories")
    args = parser.parse_args()
    extract(args.source, args.output, tags=args.tags)


if __name__ == "__main__":
    main()
