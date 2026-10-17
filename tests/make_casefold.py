"""Write the page's fold table (web/tags.js) and its fixture (tests/fixtures/casefold.json)
from this Python's str.casefold(). Run it with the server's Python when that
Python's Unicode changes (tests/test_tags.py says so):

    python -m tests.make_casefold

The table holds every character casefold() changes, so the page never asks the
browser's toLowerCase(), whose Unicode may be newer (R22-07). Most characters
fold by a fixed offset in a run of every first or second code point: RANGES
holds [first, last, step, offset]. FOLD_MORE holds the rest as text.
"""
import json
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TAGS_JS = ROOT / "web" / "tags.js"
CASEFOLD = ROOT / "tests" / "fixtures" / "casefold.json"
BEGIN = "// BEGIN casefold table (tests/make_casefold.py)\n"
END = "// END casefold table\n"


def chars():
    return [chr(cp) for cp in range(0x110000) if not 0xD800 <= cp <= 0xDFFF]


def folds():
    """Every character casefold() changes, and what it becomes."""
    return {c: c.casefold() for c in chars() if c.casefold() != c}


def table(changed):
    """(ranges, more): runs of single characters folding by one offset, and the rest."""
    offset = {ord(c): ord(f) - ord(c) for c, f in changed.items() if len(f) == 1}
    more = {c: f for c, f in changed.items() if len(f) != 1}
    left, ranges = set(offset), []
    while left:
        first = min(left)
        best = (first, 1)
        for step in (1, 2):
            last = first
            while last + step in left and offset[last + step] == offset[first]:
                last += step
            if last > best[0]:
                best = (last, step)
        last, step = best
        ranges.append([first, last, step, offset[first]])
        left -= set(range(first, last + 1, step))
    return ranges, more


def expand(ranges, more):
    """The table as the page builds it."""
    found = dict(more)
    for first, last, step, offset in ranges:
        for cp in range(first, last + 1, step):
            found[chr(cp)] = chr(cp + offset)
    return found


def source(ranges, more):
    rows = [f"[0x{a:x}, 0x{b:x}, {s}, {o}]" for a, b, s, o in ranges]
    lines, line = [], "    "
    for row in rows:
        if len(line) + len(row) + 2 > 118:
            lines.append(line.rstrip())
            line = "    "
        line += row + ", "
    lines.append(line.rstrip().rstrip(","))
    pairs = [json.dumps(c, ensure_ascii=True) + ": " + json.dumps(f, ensure_ascii=True) for c, f in sorted(more.items())]
    more_lines, line = [], "    "
    for pair in pairs:
        if len(line) + len(pair) + 2 > 118:
            more_lines.append(line.rstrip())
            line = "    "
        line += pair + ", "
    more_lines.append(line.rstrip().rstrip(","))
    version = f"Python {sys.version.split()[0]}, Unicode {unicodedata.unidata_version}"
    return (BEGIN
            + f"// {sum(len(range(a, b + 1, s)) for a, b, s, _ in ranges) + len(more)} characters of {version}.\n"
            + "const RANGES = [\n" + "\n".join(lines) + "\n];\n"
            + "const FOLD_MORE = {\n" + "\n".join(more_lines) + "\n};\n"
            + END)


def main():
    changed = folds()
    ranges, more = table(changed)
    assert expand(ranges, more) == changed
    text = TAGS_JS.read_text(encoding="utf-8")
    start, end = text.index(BEGIN), text.index(END) + len(END)
    TAGS_JS.write_text(text[:start] + source(ranges, more) + text[end:], encoding="utf-8")
    fixture = {c: unicodedata.normalize("NFC", c).casefold() for c in chars()
               if unicodedata.normalize("NFC", c).casefold() != c}
    CASEFOLD.write_text(json.dumps({
        "about": "Every character that Python's casefold() of its NFC form changes, and what it becomes: tagKey() in "
                 "web/tags.js must give the same, and leave every other character as it is.",
        "python": sys.version.split()[0], "unicode": unicodedata.unidata_version, "chars": fixture,
    }, ensure_ascii=True, indent=0, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{len(changed)} characters in {len(ranges)} runs and {len(more)} more; fixture {len(fixture)}")


if __name__ == "__main__":
    main()
