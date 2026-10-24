"""Normalize a compact JSONL catalog and skip empty normalized brands or names."""

import argparse
from collections import Counter
from decimal import Decimal
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import re
import time
import unicodedata


PUNCTUATION = str.maketrans({
    "\u2018": "'", "\u2019": "'", "\u02bc": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"',
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-",
})
WHITESPACE = re.compile(r"\s+")
LABEL_SEPARATORS = re.compile(r"\s*([:;])\s*")
COMMA_BEFORE = re.compile(r"\s+,")
COMMA_AFTER = re.compile(r",(?![\s\d])")
MONSTER_BRANDS = frozenset(("monster", "monster energy", "monster energy company"))
COCA_COLA_BRANDS = frozenset(("coca cola", "cocacola", "coke", "the coca cola", "coca cola\u00ae"))
COCA_COLA_VARIANTS = {
    "diet coke": ("diet",), "diet coke plus": ("diet", "plus"),
    "coke zero": ("zero",), "cocacola zero": ("zero",), "coca cola zero": ("zero",),
    "coca cola zero sugar": ("zero", "sugar"),
    "coca cola light": ("light",), "coca cola life": ("life",),
    "coke cherry": ("cherry",), "coke cherry zero": ("cherry", "zero"),
    "coca cola original": ("original",), "coca cola original taste": ("original", "taste"),
    "coca cola classic": ("classic",), "coca cola mini": ("mini",), "coke spiced": ("spiced",),
}
COCA_COLA_COMPANIES = frozenset((
    "coca cola company", "the coca cola company", "cocacola company", "the cocacola company",
    "coke cola company", "the coke cola company", "coca cola co.", "coca cola co", "coca cola inc.",
    "coca cola services sa/nv", "coca cola european partners norge a", "coca cola european partners norge as",
    "coca cola europacific partners norge as", "coca cola europacific partners services bulgaria eood",
))
COCA_COLA_LABELS = COCA_COLA_BRANDS | frozenset(COCA_COLA_VARIANTS)
COCA_COLA_PREFIXES = tuple(sorted(COCA_COLA_BRANDS | COCA_COLA_COMPANIES, key=lambda label: (-len(label), label)))
DIET_COKE_PREFIXES = ("diet coca cola", "diet cocacola", "diet coke")
NUMBER = r"(?:\d+(?:[.,]\d+)?|[.,]\d+)"
UNITS = {
    "mg": ("0.001", "g"), "milligram": ("0.001", "g"), "milligrams": ("0.001", "g"),
    "g": ("1", "g"), "gram": ("1", "g"), "grams": ("1", "g"),
    "kg": ("1000", "g"), "kilogram": ("1000", "g"), "kilograms": ("1000", "g"),
    "ml": ("1", "ml"), "milliliter": ("1", "ml"), "milliliters": ("1", "ml"),
    "millilitre": ("1", "ml"), "millilitres": ("1", "ml"),
    "cl": ("10", "ml"), "dl": ("100", "ml"),
    "l": ("1000", "ml"), "liter": ("1000", "ml"), "liters": ("1000", "ml"),
    "litre": ("1000", "ml"), "litres": ("1000", "ml"),
    "oz": ("1", "oz"), "ounce": ("1", "oz"), "ounces": ("1", "oz"),
    "fl oz": ("1", "fl oz"), "fl. oz": ("1", "fl oz"), "fl. oz.": ("1", "fl oz"),
    "fluid ounce": ("1", "fl oz"), "fluid ounces": ("1", "fl oz"),
    "lb": ("1", "lb"), "lbs": ("1", "lb"), "pound": ("1", "lb"), "pounds": ("1", "lb"),
    "pc": ("1", "pcs"), "pcs": ("1", "pcs"), "piece": ("1", "pcs"), "pieces": ("1", "pcs"),
    "serving": ("1", "serving"), "servings": ("1", "serving"), "serving(s)": ("1", "serving"),
}
UNIT_PATTERN = "|".join(re.escape(unit) for unit in sorted(UNITS, key=len, reverse=True))
QUANTITY = re.compile(rf"^({NUMBER})\s*({UNIT_PATTERN})$")
MULTIPACK = re.compile(r"^([1-9]\d*)\s*[x\u00d7*]\s*(.+)$")
TOTAL_WITH_PACK = re.compile(r"^(.+?)\s*\(\s*([1-9]\d*\s*[x\u00d7*].+)\s*\)$")
PACK_WITH_TOTAL = re.compile(r"^([1-9]\d*\s*[x\u00d7*].+?)\s*\(\s*(.+)\s*\)$")
PACK_SPACING = re.compile(r"(?<=\d)\s*[x\u00d7*]\s*(?=\d)")


def get_text(value):
    text = unicodedata.normalize("NFKC", value).casefold().translate(PUNCTUATION).replace("-", " ")
    return WHITESPACE.sub(" ", unicodedata.normalize("NFKC", text)).strip()


def get_label(value):
    text = LABEL_SEPARATORS.sub(r"\1 ", get_text(value)).strip()
    return COMMA_AFTER.sub(", ", COMMA_BEFORE.sub(",", text))


@lru_cache(maxsize=100000)
def get_brand_parts(value):
    return tuple(sorted(set(part.strip() for part in get_label(value).split(",") if part.strip())))


def get_brand(value, name):
    parts = get_brand_parts(value)
    # Separate company labels from explicitly supplied consumer brands
    parts = tuple(part for part in parts if part not in COCA_COLA_COMPANIES) or parts
    if parts and (set(parts) <= COCA_COLA_LABELS or (
        set(parts) <= COCA_COLA_COMPANIES
        and any(name == prefix or get_prefix_remainder(name, prefix) for prefix in (*COCA_COLA_BRANDS, *DIET_COKE_PREFIXES))
    )):
        return "coca cola", COCA_COLA_PREFIXES

    # Collapse known Monster aliases only when the consumer brand is identified
    if parts and set(parts) <= MONSTER_BRANDS:
        if any(part != "monster energy company" for part in parts) or get_prefix_remainder(name, "monster energy"):
            return "monster energy", tuple(sorted(MONSTER_BRANDS, key=len, reverse=True))
    return ", ".join(parts) or get_label(value), tuple(sorted(parts, key=len, reverse=True))


def get_prefix_remainder(name, prefix):
    if not name.startswith(prefix) or len(name) == len(prefix):
        return None
    following = name[len(prefix):]
    if following[0].isalnum() or following[0] == "_":
        return None
    return following.lstrip(" -:;,") or None


def get_name(name, prefixes):
    # Remove only leading, whole-brand labels; retain every product variant word
    while True:
        if name in prefixes:
            return name
        for prefix in prefixes:
            remainder = get_prefix_remainder(name, prefix)
            if remainder:
                name = remainder
                break
        else:
            return name


def get_coca_cola_name(value, name):
    # Keep variant information when a Coke-specific brand label becomes Coca-Cola
    for prefix in DIET_COKE_PREFIXES:
        if name == prefix:
            name = "diet"
            break
        remainder = get_prefix_remainder(name, prefix)
        if remainder:
            name = f"diet {remainder}"
            break
    if name in COCA_COLA_BRANDS:
        name = ""
    words = set(re.findall(r"\w+", name))
    missing = []
    for part in get_brand_parts(value):
        for qualifier in COCA_COLA_VARIANTS.get(part, ()):
            if qualifier not in words:
                missing.append(qualifier)
                words.add(qualifier)
    return " ".join([*missing, name]).strip() or "coca cola"


def get_quantity(value):
    match = QUANTITY.fullmatch(value)
    if not match:
        return None
    number, unit = match.groups()
    # A comma followed by three digits can be a thousands separator
    if "," in number:
        whole, fraction = number.split(",")
        if len(fraction) == 3 and whole and int(whole) != 0:
            return None
    amount = Decimal(number.replace(",", "."))
    if amount <= 0:
        return None
    factor, canonical_unit = UNITS[unit]
    if canonical_unit in ("pcs", "serving") and amount != amount.to_integral_value():
        return None
    return amount * Decimal(factor), canonical_unit


def get_number(amount):
    number = format(amount, "f")
    return number.rstrip("0").rstrip(".") if "." in number else number


def get_quantity_text(quantity):
    amount, unit = quantity
    return f"{get_number(amount)} {unit}"


def get_pack(value):
    match = MULTIPACK.fullmatch(value)
    if match:
        count, content = match.groups()
        quantity = get_quantity(content)
        if quantity:
            return int(count), quantity
    return None


def get_pack_text(pack):
    count, quantity = pack
    return f"{count} x {get_quantity_text(quantity)}"


@lru_cache(maxsize=100000)
def get_size(value):
    if value is None:
        return None
    text = get_text(value)
    if not text:
        return None
    quantity = get_quantity(text)
    if quantity:
        return get_quantity_text(quantity)
    pack = get_pack(text)
    if pack:
        return get_pack_text(pack)

    # Discard a redundant total only when it exactly agrees with the pack contents
    for pattern, reverse in ((TOTAL_WITH_PACK, False), (PACK_WITH_TOTAL, True)):
        match = pattern.fullmatch(text)
        if match:
            total_text, pack_text = match.groups()[::-1] if reverse else match.groups()
            total, pack = get_quantity(total_text), get_pack(pack_text.strip())
            if total and pack and total == (pack[0] * pack[1][0], pack[1][1]):
                return get_pack_text(pack)
    return PACK_SPACING.sub(" x ", text)


def get_record(record, line_number):
    if not isinstance(record, dict):
        raise ValueError(f"Line {line_number}: expected a product object")
    for field in ("barcode", "brand", "name"):
        if not isinstance(record.get(field), str) or not record[field].strip():
            raise ValueError(f"Line {line_number}: {field} must be a non-empty string")
    if record.get("size") is not None and not isinstance(record["size"], str):
        raise ValueError(f"Line {line_number}: size must be a string or null")
    name = get_label(record["name"])
    brand, prefixes = get_brand(record["brand"], name)
    if not brand or not name:
        return None
    name = get_name(name, prefixes)
    if brand == "coca cola":
        name = get_coca_cola_name(record["brand"], name)
    return {
        "barcode": record["barcode"],
        "brand": brand,
        "name": name,
        "size": get_size(record.get("size")),
    }


def normalize(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    partial = output.with_name(output.name + ".partial")
    report_path = output.with_name(output.name + ".summary.json")
    if not source.is_file():
        raise FileNotFoundError(source)
    for path in (output, partial, report_path):
        if path.exists():
            raise FileExistsError(f"Refusing to overwrite {path}")
    started = last_progress = time.monotonic()
    total_bytes = source.stat().st_size
    source_hash, output_hash = hashlib.sha256(), hashlib.sha256()
    counts = Counter({"read": 0, "records": 0, "skipped_empty_required": 0})
    changed = Counter()

    # Keep accepted records in source order and count empty normalized products
    with source.open("rb") as records, partial.open("xb") as destination:
        for line_number, line in enumerate(records, 1):
            source_hash.update(line)
            try:
                original = json.loads(line)
            except (ValueError, UnicodeDecodeError) as error:
                raise ValueError(f"Line {line_number}: invalid UTF-8 or JSON") from error
            record = get_record(original, line_number)
            counts["read"] += 1
            if record is None:
                counts["skipped_empty_required"] += 1
            else:
                encoded = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
                destination.write(encoded)
                output_hash.update(encoded)
                counts["records"] += 1
                counts["null_sizes"] += record["size"] is None
                counts["changed_records"] += record != original
                for field in ("brand", "name", "size"):
                    changed[field] += record[field] != original.get(field)
            now = time.monotonic()
            if now - last_progress >= 10:
                print(f"{records.tell() / total_bytes:.1%} read | {counts['records']:,} normalized | {now - started:.0f}s", flush=True)
                last_progress = now

    partial.rename(output)
    summary = {
        "source": str(source), "output": str(output),
        "source_bytes": total_bytes, "output_bytes": output.stat().st_size,
        "source_sha256": source_hash.hexdigest(), "output_sha256": output_hash.hexdigest(),
        "counts": dict(counts), "changed_fields": dict(changed),
        "elapsed_seconds": round(time.monotonic() - started, 1),
        "identity_fields": ["brand", "name", "size"],
        "null_sizes_match": True,
        "rules": [
            "Casefold Unicode text; replace hyphens and Unicode dashes with spaces; standardize whitespace and quotes; preserve accents and languages.",
            "Sort and deduplicate comma-separated brand labels; use explicit Monster aliases when the consumer brand is identified.",
            "Normalize recognized Coke/Coca-Cola aliases to coca cola; preserve brand-level diet, flavor, and other variant qualifiers in names.",
            "Remove recognized Coca-Cola company labels when a consumer brand is supplied; company-only records need a Coke product name to become coca cola.",
            "Do not treat Monster Energy Company alone as the Monster consumer brand without a leading Monster Energy product label.",
            "Remove leading whole-brand labels from names; retain flavors, diet descriptions, and other variant words.",
            "Convert recognized metric sizes exactly to g or ml; preserve mass/volume distinctions and pack counts.",
            "Normalize recognized nonmetric unit spellings without converting between metric, US, and Imperial units.",
            "Preserve ambiguous or unsupported sizes as text; do not infer missing sizes.",
            "Identical normalized brand/name/size tuples identify matching candidates, including two null sizes.",
            "Skip records whose normalized brand or name is empty; missing sizes remain allowed.",
            "Preserve accepted records, their barcode strings, and source ordering; do not change the source file or SQLite importer.",
        ],
    }
    with report_path.open("x", encoding="utf-8", newline="\n") as report:
        json.dump(summary, report, ensure_ascii=False, indent=2)
        report.write("\n")
    print(json.dumps(summary, ensure_ascii=True, indent=2), flush=True)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Source compact UTF-8 JSONL catalog")
    parser.add_argument("output", type=Path, help="Normalized JSONL destination (must not already exist)")
    args = parser.parse_args()
    normalize(args.source, args.output)


if __name__ == "__main__":
    main()
