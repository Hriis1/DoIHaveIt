"""Stream an Open Food Facts dump into a compact, UTF-8 product catalog."""

import argparse
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import re
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


def get_image_url(product, barcode):
    # Use supplied front-image URLs when the export includes them
    selected = product.get("selected_images") or {}
    front = selected.get("front", {})
    for size in ("display", "small", "thumb"):
        urls = front.get(size, {})
        if not isinstance(urls, dict):
            continue
        for language in get_languages(product, urls):
            url = get_text(urls.get(language))
            if url.startswith("https://"):
                return url
    for field in ("image_front_url", "image_url", "image_front_small_url"):
        url = get_text(product.get(field))
        if url.startswith("https://"):
            return url

    # Dumps store selected-image revisions instead of computed URLs
    images = product.get("images") or {}
    fronts = dict((images.get("selected") or {}).get("front") or {})
    for key, image in images.items():
        if key.startswith("front_"):
            fronts.setdefault(key[6:], image)
    if not re.fullmatch(r"[0-9]+", barcode):
        return None
    folder = barcode if len(barcode) <= 8 else f"{barcode[:3]}/{barcode[3:6]}/{barcode[6:9]}/{barcode[9:]}"
    for language in get_languages(product, fronts):
        image = fronts.get(language)
        if not isinstance(image, dict) or not re.fullmatch(r"[a-z]{2,3}", language):
            continue
        revision = str(image.get("rev", ""))
        if not revision.isdigit():
            continue
        sizes = image.get("sizes") or {}
        size = next((value for value in ("400", "200", "100", "full") if value in sizes), None)
        if size:
            return f"https://images.openfoodfacts.org/images/products/{folder}/front_{language}.{revision}.{size}.jpg"
    return None


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
        "image_url": get_image_url(product, barcode),
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
    counts = {"read": 0, "kept": 0, "missing_required": 0, "invalid_json": 0, "with_size": 0, "with_image": 0}
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
            else:
                destination.write(json.dumps(compact, ensure_ascii=False, separators=(",", ":")) + "\n")
                counts["kept"] += 1
                counts["with_size"] += compact["size"] is not None
                counts["with_image"] += compact["image_url"] is not None
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
        "image_license": "CC-BY-SA; see the source licensing guidance",
        "license_url": "https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/tutorials/license-be-on-the-legal-side/",
        "notes": [
            "International coverage; no country filter.",
            "Missing sizes and images are null. Original product names and languages are retained.",
            "Image URLs come from supplied URLs or selected-front-image metadata; images were not downloaded or checked online.",
            "No barcode deduplication or database import was performed.",
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
