"""A bundle's tags, changed in place. Two tags are the same tag when they fold
to the same text (str.casefold), whatever their case: "Straße" and "STRASSE"
are one tag. The batch tag actions and the library-wide rename and delete
change only the tags, so a bundle keeps every other value as it was stored,
also one outside rules tightened since (web/tags.js folds tags the same way)."""


def key(tag):
    return tag.casefold()


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
