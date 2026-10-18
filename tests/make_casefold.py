"""Write the fold table of tags, for the page (web/tags.js) and the server
(bundle_library/casefold.py), and its fixture (tests/fixtures/casefold.json),
from this Python's str.casefold():

    python -m tests.make_casefold

The table holds every character casefold() changes. The page never asks the
browser's toLowerCase(), nor the server its own Python's casefold(): either may
know a newer Unicode (R22-07), and the servers' Pythons differ. So the table
changes only when it is written again, with a Python of a newer Unicode; tags
that differ only in a character that Unicode folds anew then become one tag.
Most characters fold by a fixed offset in a run of every first or second code
point: RANGES holds [first, last, step, offset]. FOLD_MORE holds the rest as
text.
"""
import json
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TAGS_JS = ROOT / "web" / "tags.js"
TABLE_PY = ROOT / "bundle_library" / "casefold.py"
CASEFOLD = ROOT / "tests" / "fixtures" / "casefold.json"
BEGIN = "// BEGIN casefold table (tests/make_casefold.py)\n"
END = "// END casefold table\n"
TABLE_DOC = '''"""The fold of tags (tags.key): every character that str.casefold() changes, in
the Unicode named below, and what it becomes. web/tags.js holds the same table,
so the page and the server take the same tags for the same, whatever the
Unicode of the browser or of the server's Python. Most characters fold by a
fixed offset in a run of every first or second code point (RANGES: first,
last, step, offset); FOLD_MORE holds the rest. Written by
tests/make_casefold.py; not edited by hand."""
'''


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


def _wrap(items):
    """`items` joined by commas, in lines of at most 118 characters indented by four spaces."""
    lines, line = [], "    "
    for item in items:
        if len(line) + len(item) + 2 > 118:
            lines.append(line.rstrip())
            line = "    "
        line += item + ", "
    lines.append(line.rstrip().rstrip(","))
    return "\n".join(lines)


def _about(ranges, more):
    count = sum(len(range(a, b + 1, s)) for a, b, s, _ in ranges) + len(more)
    return f"{count} characters of Python {sys.version.split()[0]}, Unicode {unicodedata.unidata_version}."


def source(ranges, more):
    """The table in web/tags.js."""
    rows = [f"[0x{a:x}, 0x{b:x}, {s}, {o}]" for a, b, s, o in ranges]
    pairs = [json.dumps(c, ensure_ascii=True) + ": " + json.dumps(f, ensure_ascii=True) for c, f in sorted(more.items())]
    return (BEGIN + f"// {_about(ranges, more)}\n"
            + "const RANGES = [\n" + _wrap(rows) + "\n];\n"
            + "const FOLD_MORE = {\n" + _wrap(pairs) + "\n};\n"
            + END)


def table_source(ranges, more):
    """bundle_library/casefold.py, the same table for the server."""
    rows = [f"(0x{a:x}, 0x{b:x}, {s}, {o})" for a, b, s, o in ranges]
    pairs = [f"{ascii(c)}: {ascii(f)}" for c, f in sorted(more.items())]
    return (TABLE_DOC + f"# {_about(ranges, more)}\n"
            + f"UNICODE = {unicodedata.unidata_version!r}\n"
            + "RANGES = [\n" + _wrap(rows) + "\n]\n"
            + "FOLD_MORE = {\n" + _wrap(pairs) + "\n}\n")


def main():
    changed = folds()
    ranges, more = table(changed)
    assert expand(ranges, more) == changed
    text = TAGS_JS.read_text(encoding="utf-8")
    start, end = text.index(BEGIN), text.index(END) + len(END)
    TAGS_JS.write_text(text[:start] + source(ranges, more) + text[end:], encoding="utf-8")
    TABLE_PY.write_text(table_source(ranges, more), encoding="utf-8")
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
