"""Stream a compact product JSONL catalog into a standalone SQLite database."""

import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import time


def get_record(line, line_number):
    # Validate every record, including duplicates, before inserting it
    try:
        record = json.loads(line.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError(f"Line {line_number}: invalid UTF-8 or JSON") from error
    if not isinstance(record, dict):
        raise ValueError(f"Line {line_number}: expected a product object")
    for field in ("barcode", "brand", "name"):
        if not isinstance(record.get(field), str) or not record[field].strip():
            raise ValueError(f"Line {line_number}: {field} must be a non-empty string")
    size = record.get("size")
    if size is not None and not isinstance(size, str):
        raise ValueError(f"Line {line_number}: size must be a string or null")
    return (
        record["barcode"].strip(), record["brand"].strip(), record["name"].strip(),
        size.strip() or None if isinstance(size, str) else None,
    )


def convert(source, output):
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
    last_progress = started
    total_bytes = source.stat().st_size
    counts = {"read": 0, "kept": 0, "duplicates": 0}
    batch = []
    statement = """
        INSERT INTO catalog_products (barcode, brand, name, size)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(barcode) DO NOTHING;
    """

    # Reserve the temporary filename without overwriting an earlier conversion
    with partial.open("xb"):
        pass
    with closing(sqlite3.connect(partial)) as database:
        database.execute("""
            CREATE TABLE catalog_products (
                source_id INTEGER PRIMARY KEY,
                barcode TEXT NOT NULL UNIQUE,
                brand TEXT NOT NULL,
                name TEXT NOT NULL,
                size TEXT
            );
        """)
        database.execute("BEGIN TRANSACTION;")
        try:
            # Stream input and use the barcode index for deduplication, keeping memory bounded
            with source.open("rb") as records:
                for line_number, line in enumerate(records, 1):
                    batch.append(get_record(line, line_number))
                    counts["read"] += 1
                    if len(batch) == 1000:
                        database.executemany(statement, batch)
                        batch.clear()
                    now = time.monotonic()
                    if now - last_progress >= 10:
                        print(f"{records.tell() / total_bytes:.1%} read | {counts['read']:,} records | {database.total_changes:,} stored | {now - started:.0f}s", flush=True)
                        last_progress = now
            if batch:
                database.executemany(statement, batch)
            counts["kept"] = database.total_changes
            counts["duplicates"] = counts["read"] - counts["kept"]
            database.commit()
        except BaseException:
            database.rollback()
            raise

        # Verify the completed database before publishing it
        result = database.execute("PRAGMA integrity_check;").fetchone()
        if result != ("ok",):
            raise sqlite3.DatabaseError(f"SQLite integrity check failed: {result}")

    if output.exists():
        raise FileExistsError(f"Refusing to overwrite {output}")
    partial.rename(output)
    summary = {
        "source": str(source),
        "output": str(output),
        "source_bytes": total_bytes,
        "output_bytes": output.stat().st_size,
        "counts": counts,
        "elapsed_seconds": round(time.monotonic() - started, 1),
    }
    print(json.dumps(summary, ensure_ascii=True, indent=2), flush=True)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Compact UTF-8 .jsonl product catalog")
    parser.add_argument("output", type=Path, help="Destination .sqlite file (must not already exist)")
    args = parser.parse_args()
    convert(args.source, args.output)


if __name__ == "__main__":
    main()
