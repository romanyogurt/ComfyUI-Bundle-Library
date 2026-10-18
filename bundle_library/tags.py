"""A bundle's tags, changed in place. Two tags are the same tag when they fold
to the same text (key), whatever their case: "Straße" and "STRASSE" are one
tag. The fold is the table of casefold.py, str.casefold() as one Unicode
version has it, and web/tags.js folds with the same table: the page and every
server take the same tags for the same, whatever the Unicode of the browser or
of the server's Python. The batch tag actions and the library-wide rename and
delete change only the tags, so a bundle keeps every other value as it was
stored, also one outside rules tightened since."""
import unicodedata

from .casefold import FOLD_MORE, RANGES

_FOLD = {cp: chr(cp + offset) for first, last, step, offset in RANGES for cp in range(first, last + 1, step)}
_FOLD.update((ord(c), folded) for c, folded in FOLD_MORE.items())


def key(tag):
    """The text two tags share when they are the same tag: its NFC form, folded (as tagKey() in web/tags.js)."""
    return unicodedata.normalize("NFC", tag).translate(_FOLD)


def added(tags, new):
    """`tags` with each tag of `new` that is not there yet at the end, in order."""
    result = list(tags)
    keys = {key(tag) for tag in result}
    for tag in new:
        if key(tag) not in keys:
            keys.add(key(tag))
            result.append(tag)
    return result


def removed(tags, gone):
    """`tags` without those that are a tag of `gone`."""
    keys = {key(tag) for tag in gone}
    return [tag for tag in tags if key(tag) not in keys]


def renamed(tags, old, new):
    """`tags` with `old` called `new`; unchanged if `old` is not there. When
    `new` is there too they merge: one `new`, where the first of the two was.
    Either way the tag is spelled as `new` (a rename may change only the case)."""
    if key(old) not in {key(tag) for tag in tags}:
        return list(tags)
    merging = {key(old), key(new)}
    result = []
    for tag in tags:
        if key(tag) not in merging:
            result.append(tag)
        elif new not in result:
            result.append(new)
    return result


def has(tags, tag):
    return key(tag) in {key(t) for t in tags}
