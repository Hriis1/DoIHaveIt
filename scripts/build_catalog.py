"""Extract, normalize, and convert an Open Food Facts dump into a SQLite catalog."""

import argparse
from pathlib import Path

from extract_openfoodfacts import extract
from jsonl_to_sqlite import convert
from normalize_catalog import normalize


DATA_DIR = Path(__file__).resolve().parents[1] / "data"


def build(source, filename, tags=None):
    source = Path(source).resolve()
    if not filename or filename in (".", "..") or Path(filename).name != filename or "/" in filename or "\\" in filename:
        raise ValueError("filename must be a base filename without a directory")
    if not source.is_file():
        raise FileNotFoundError(source)
    extracted = DATA_DIR / f"{filename}.jsonl"
    normalized = DATA_DIR / f"{filename}Normalized.jsonl"
    database = DATA_DIR / "sqlite" / f"{filename}.sqlite"

    # Reject conflicts for every stage before starting the extraction
    for output in (extracted, normalized, database):
        for path in (output, output.with_name(output.name + ".partial")):
            if path.exists():
                raise FileExistsError(f"Refusing to overwrite {path}")

    # Run sequentially, preserving each script's console output and failure behavior
    extraction_summary = extract(source, extracted, tags=tags)
    normalization_summary = normalize(extracted, normalized)
    conversion_summary = convert(normalized, database)
    return {
        "extract": extraction_summary,
        "normalize": normalization_summary,
        "convert": conversion_summary,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Downloaded Open Food Facts .jsonl.gz file")
    parser.add_argument("filename", help="Base filename without an extension; outputs are saved in the project's data/ and data/sqlite/ folders")
    parser.add_argument("--tags", nargs="+", help="Include products matching at least one exact categories_tags value; omit to include all categories")
    args = parser.parse_args()
    build(args.source, args.filename, tags=args.tags)


if __name__ == "__main__":
    main()
