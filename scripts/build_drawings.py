#!/usr/bin/env python3
"""
Regenerate crates/pastel-loadtest/data/drawings.bin by appending new
Quick Draw categories to the existing pool.

Bin format (little-endian, no header):
    u32 count
    repeat count times:
      u8  word_len
      word_len bytes (utf-8)
      u8  stroke_count
      repeat stroke_count times:
        u16 point_count
        point_count * (u8 x, u8 y)        // canvas coords 0-255

Source: Google Quick Draw "simplified" NDJSON, one file per category at
    https://storage.googleapis.com/quickdraw_dataset/full/simplified/{cat}.ndjson

Quick Draw simplified is already in 256x256 coord space, so x/y fit u8
directly. Each line is one drawing sample.

We stream each NDJSON, find one sample per category that:
  - has `recognized: true`
  - has 1..=20 strokes, every stroke has >= 2 points
  - has a reasonable total point count (cap so replay isn't sluggish)

Run with: python3 scripts/build_drawings.py
"""

import argparse
import io
import json
import struct
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
BIN_PATH = REPO_ROOT / "crates" / "pastel-loadtest" / "data" / "drawings.bin"

# Hand-picked categories from Quick Draw that aren't in the current bin.
# Skipped: abstract / ambiguous (animal migration, camouflage, squiggle,
# zigzag, spreadsheet, stitches), too vague (face, smiley face, goatee),
# and weapons (rifle) for a cozy game.
NEW_CATEGORIES = [
    "anvil",
    "asparagus",
    "bench",
    "binoculars",
    "bottlecap",
    "bowtie",
    "bulldozer",
    "cello",
    "clarinet",
    "cooler",
    "cruise ship",
    "dishwasher",
    "diving board",
    "dresser",
    "eyeglasses",
    "garden hose",
    "harp",
    "hedgehog",
    "hockey puck",
    "hot tub",
    "hourglass",
    "house plant",
    "matches",
    "paint can",
    "pear",
    "peas",
    "picture frame",
    "police car",
    "postcard",
    "purse",
    "school bus",
    "see saw",
    "skyscraper",
    "snorkel",
    "speedboat",
    "stereo",
    "teddy-bear",
    "The Eiffel Tower",
    "The Great Wall of China",
    "The Mona Lisa",
    "wristwatch",
]

# Cap total points per drawing so bot replays stay snappy. The existing
# 295 average ~42 total points per drawing; this leaves headroom.
MAX_TOTAL_POINTS = 80
MIN_STROKES = 1
MAX_STROKES = 12

QD_BASE = "https://storage.googleapis.com/quickdraw_dataset/full/simplified/"


def read_existing_bin(path: Path) -> dict[str, list[list[tuple[int, int]]]]:
    """Decode the existing bin into {word: [stroke_pts...]}."""
    data = path.read_bytes()
    pos = 0
    count = struct.unpack_from("<I", data, pos)[0]
    pos += 4
    out: dict[str, list[list[tuple[int, int]]]] = {}
    for _ in range(count):
        wlen = data[pos]
        pos += 1
        word = data[pos:pos + wlen].decode("utf-8")
        pos += wlen
        stroke_count = data[pos]
        pos += 1
        strokes = []
        for _ in range(stroke_count):
            n = struct.unpack_from("<H", data, pos)[0]
            pos += 2
            pts = []
            for _ in range(n):
                pts.append((data[pos], data[pos + 1]))
                pos += 2
            strokes.append(pts)
        out[word] = strokes
    return out


def encode_bin(entries: dict[str, list[list[tuple[int, int]]]]) -> bytes:
    """Encode {word: strokes} back to the bin format."""
    buf = io.BytesIO()
    buf.write(struct.pack("<I", len(entries)))
    for word, strokes in entries.items():
        wb = word.encode("utf-8")
        assert len(wb) <= 255, f"word too long: {word!r}"
        buf.write(struct.pack("<B", len(wb)))
        buf.write(wb)
        assert len(strokes) <= 255, f"too many strokes: {word!r}"
        buf.write(struct.pack("<B", len(strokes)))
        for stroke in strokes:
            buf.write(struct.pack("<H", len(stroke)))
            for x, y in stroke:
                assert 0 <= x <= 255 and 0 <= y <= 255, (
                    f"coord out of u8 range: {word!r} ({x}, {y})"
                )
                buf.write(struct.pack("<BB", x, y))
    return buf.getvalue()


def fetch_one_sample(category: str) -> Optional[list[list[tuple[int, int]]]]:
    """Stream the category's NDJSON until we find a usable recognized sample.
    Returns strokes as [[(x, y), ...], ...] in 0..255 coord space, or None
    if nothing acceptable was found in the first chunk we read."""
    url = QD_BASE + urllib.parse.quote(category) + ".ndjson"
    print(f"  GET {url}", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "pastel-bot-builder"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        # Read up to ~5 MB; that's hundreds of samples, way more than enough
        # to find one acceptable one. Streaming further wastes bandwidth.
        chunk = resp.read(5 * 1024 * 1024).decode("utf-8", errors="replace")
    # The chunk likely ends mid-line. Drop the final partial line.
    lines = chunk.split("\n")
    if lines and not lines[-1].endswith("\n"):
        lines = lines[:-1]
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not obj.get("recognized"):
            continue
        raw_strokes = obj.get("drawing") or []
        if not (MIN_STROKES <= len(raw_strokes) <= MAX_STROKES):
            continue
        strokes: list[list[tuple[int, int]]] = []
        total_pts = 0
        ok = True
        for s in raw_strokes:
            if len(s) < 2:
                ok = False
                break
            xs, ys = s[0], s[1]
            if len(xs) < 2 or len(xs) != len(ys):
                ok = False
                break
            pts = []
            for x, y in zip(xs, ys):
                if not (0 <= x <= 255 and 0 <= y <= 255):
                    # Quick Draw simplified should always be in range, but
                    # clamp defensively rather than reject the whole sample.
                    x = max(0, min(255, int(x)))
                    y = max(0, min(255, int(y)))
                pts.append((int(x), int(y)))
            strokes.append(pts)
            total_pts += len(pts)
        if not ok:
            continue
        if total_pts < 8:
            continue
        if total_pts > MAX_TOTAL_POINTS:
            continue
        return strokes
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Don't write the bin; just print stats.",
    )
    args = parser.parse_args()

    print(f"Reading existing bin: {BIN_PATH}")
    entries = read_existing_bin(BIN_PATH)
    print(f"  {len(entries)} existing entries")

    new_added = []
    skipped = []
    for cat in NEW_CATEGORIES:
        if cat in entries:
            skipped.append((cat, "already present"))
            continue
        print(f"Fetching: {cat}")
        try:
            strokes = fetch_one_sample(cat)
        except Exception as e:
            skipped.append((cat, f"fetch failed: {e}"))
            continue
        if strokes is None:
            skipped.append((cat, "no acceptable sample found"))
            continue
        entries[cat] = strokes
        total = sum(len(s) for s in strokes)
        new_added.append((cat, len(strokes), total))
        print(f"  ok: {len(strokes)} strokes, {total} points")

    print()
    print(f"Added {len(new_added)} new entries:")
    for cat, sc, tp in new_added:
        print(f"  {cat:30s}  {sc} strokes / {tp} pts")
    if skipped:
        print()
        print(f"Skipped {len(skipped)}:")
        for cat, reason in skipped:
            print(f"  {cat:30s}  {reason}")

    print()
    print(f"Total entries after merge: {len(entries)}")
    encoded = encode_bin(entries)
    print(f"New bin size: {len(encoded)} bytes (was {BIN_PATH.stat().st_size})")

    if args.dry_run:
        print("(dry-run; not writing)")
        return 0

    BIN_PATH.write_bytes(encoded)
    print(f"Wrote {BIN_PATH}")

    # Also write a sorted word list for the bot-guess pool. The loader in
    # bot.rs already unions this with the game word lists, but keeping
    # this file authoritative is the convention.
    words_bot = REPO_ROOT / "crates" / "pastel-server" / "data" / "words-bot.txt"
    sorted_words = sorted(entries.keys(), key=lambda s: s.lower())
    words_bot.write_text("\n".join(sorted_words) + "\n")
    print(f"Wrote {words_bot} ({len(sorted_words)} lines)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
