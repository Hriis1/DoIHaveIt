"""Stream an Open Food Facts dump into a compact, UTF-8 product catalog."""

import argparse
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import time


def get_text(value):
    return value.strip() if isinstance(value, str) else ""


def get_languages(product, available):
    # Prefer the product's language, then English, then other available languages
    preferred = [get_text(product.get("lang")), "en", *sorted(available)]
    return list(dict.fromkeys(language for language in preferred if language))


def get_name(product):
    name = get_text(product.get("product_name"))
    if name:
        return name
    available = [key[13:] for key in product if key.startswith("product_name_") and len(key[13:]) <= 3]
    for language in get_languages(product, available):
        name = get_text(product.get(f"product_name_{language}"))
        if name:
            return name
    return ""


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


def extract(source, output):
    source = Path(source).resolve()
    output = Path(output).resolve()
    partial = output.with_name(output.name + ".partial")
    report_path = output.with_name(output.name + ".summary.json")
    if not source.is_file():
        raise FileNotFoundError(source)
    for path in (output, partial, report_path):
        if path.exists():
            raise FileExistsError(f"Refusing to overwrite {path}")
    output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    started_at = datetime.now(timezone.utc).isoformat()
    total_bytes = source.stat().st_size
    counts = {"read": 0, "kept": 0, "missing_required": 0, "invalid_json": 0, "duplicates": 0, "with_size": 0}
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
            compact = get_product(product)
            if compact is None:
                counts["missing_required"] += 1
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
        "attribution": "Open Food Facts contributors",
        "source_url": "https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz",
        "database_license": "ODbL-1.0",
        "license_url": "https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/tutorials/license-be-on-the-legal-side/",
        "notes": [
            "International coverage; no country filter.",
            "Missing sizes are null. Original product names and languages are retained.",
            "The first qualifying record for each barcode is retained; later duplicates are skipped. No database import was performed.",
        ],
    }
    with report_path.open("x", encoding="utf-8") as report:
        json.dump(summary, report, ensure_ascii=False, indent=2)
        report.write("\n")
    print(json.dumps(summary, ensure_ascii=True, indent=2), flush=True)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Downloaded .jsonl.gz file")
    parser.add_argument("output", type=Path, help="Destination .jsonl file (must not already exist)")
    args = parser.parse_args()
    extract(args.source, args.output)


if __name__ == "__main__":
    main()
