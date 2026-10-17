"""How the library list is organized: categories, which category each bundle
sits in, and favorites. Kept in organization.json beside bundles/, not in the
bundles, so moving or starring a bundle changes neither its file, its
revision nor the cache of a node that loads it.

The file follows the same rules as bundle files (schema.py): a missing file
is an empty organization; a file this version does not fully understand is
shown if it can be and never written. Imports nothing from ComfyUI.
"""

import json
import logging

from . import schema
from .model import UUID_RE, LibraryError, _name, _Rules, invalid, lone_surrogates
from .text import Text

FORMAT = "comfyui-bundle-library/organization"
SCHEMA_VERSION = 1
MAX_CATEGORIES = 200
MAX_CATEGORY_NAME = 60
# The computed views of the list; a category may not take their names.
SPECIAL_NAMES = ("Favorites", "Uncategorized", "Needs attention")

TOP_KEYS = {"format", "schema_version", "revision", "categories", "placement", "favorites"}
CATEGORY_KEYS = {"id", "name", "parent"}


class Organization:
    """organization.json as read: its `state` (schema's states, OK for a
    missing file), and when it can be read, the categories, the placement
    (bundle id -> category id) and the favorites."""

    def __init__(self, state, problem=None, revision=0, categories=(), placement=None, favorites=(), exists=True,
                 io_error=False):
        self.state = state
        self.io_error = io_error  # could not be read at all: reported apart, read again next time
        self.problem = problem
        self.revision = revision
        self.categories = [dict(c) for c in categories]
        self.placement = dict(placement or {})
        self.favorites = list(favorites)
        self.exists = exists

    @property
    def readable(self):
        return self.state in (schema.OK, schema.READ_ONLY)

    @property
    def writable(self):
        return self.state == schema.OK

    def category(self, category_id):
        return next((c for c in self.categories if c["id"] == category_id), None)

    def category_of(self, bundle_id):
        """The id of the bundle's category, or None (no category, or one that is gone)."""
        category_id = self.placement.get(bundle_id)
        return category_id if self.category(category_id) else None

    def as_file(self):
        return {"format": FORMAT, "schema_version": SCHEMA_VERSION, "revision": self.revision,
                "categories": self.categories, "placement": self.placement, "favorites": self.favorites}


def empty():
    return Organization(schema.OK, exists=False)


def read(text):
    """Sort the content of organization.json into an Organization."""
    try:
        data = json.loads(text)
    except ValueError:
        return Organization(schema.CORRUPT, Text("common.not_json"))
    except RecursionError:
        return Organization(schema.CORRUPT, Text("common.too_deep"))
    if not isinstance(data, dict):
        return Organization(schema.CORRUPT, Text("common.not_json_object"))
    if lone_surrogates(data):
        return Organization(schema.CORRUPT, Text("common.not_unicode"))
    form = data.get("format")
    if form != FORMAT:
        if isinstance(form, str) and form:
            return Organization(schema.UNSUPPORTED, Text("common.other_format", value=form[:60]))
        return Organization(schema.CORRUPT, Text("organization.not_organization_file"))
    version = data.get("schema_version")
    if type(version) is not int or version < 1:
        return Organization(schema.CORRUPT, Text("common.invalid_schema_version", version=repr(version)))
    if version > SCHEMA_VERSION:
        return Organization(schema.NEWER, Text("common.newer_schema", version=version,
                                               SCHEMA_VERSION=SCHEMA_VERSION))
    problem = _shape_problem(data)
    if problem:
        return Organization(schema.CORRUPT, problem)
    unknown = sorted(set(data) - TOP_KEYS) + sorted(
        {key for c in data["categories"] for key in set(c) - CATEGORY_KEYS})
    favorites = list(dict.fromkeys(data["favorites"]))
    return Organization(schema.READ_ONLY if unknown else schema.OK,
                        Text("common.unknown_data", list=", ".join(map(repr, unknown[:5])))
                        if unknown else None,
                        data["revision"], data["categories"], data["placement"], favorites)


def _shape_problem(data):
    revision = data.get("revision")
    if type(revision) is not int or revision < 0:
        return Text("common.invalid_revision")
    categories = data.get("categories")
    if not isinstance(categories, list):
        return Text("organization.categories_list")
    ids = set()
    for category in categories:
        if not isinstance(category, dict):
            return Text("organization.category_object")
        category_id, name = category.get("id"), category.get("name")
        if not isinstance(category_id, str) or not UUID_RE.match(category_id) or category_id in ids:
            return Text("organization.category_id")
        ids.add(category_id)
        if not isinstance(name, str) or not name.strip():
            return Text("organization.category_no_name")
        if category.get("parent") is not None:  # nesting is designed in but not open in version 1
            return Text("organization.nested_categories")
    placement = data.get("placement")
    if not isinstance(placement, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in placement.items()):
        return Text("organization.placement_map")
    favorites = data.get("favorites")
    if not isinstance(favorites, list) or not all(isinstance(f, str) for f in favorites):
        return Text("organization.favorites_list")
    return None


def read_file(path):
    try:
        with open(path, "rb") as f:
            text = f.read()
    except FileNotFoundError:
        return empty()
    except OSError as e:
        return Organization(schema.CORRUPT, Text("common.not_read", reason=e.strerror or type(e).__name__),
                            io_error=True)
    try:
        return read(text)
    except Exception as e:  # noqa: BLE001 — the last defence of the file boundary, logged
        logging.exception("[Bundle Library] could not check organization.json")
        return Organization(schema.CORRUPT, Text("common.not_checked", name=type(e).__name__))


def category_name(value, organization, own_id=None):
    """A category name checked and normalized for saving: the rules of bundle
    names, at most MAX_CATEGORY_NAME characters, not a special view's name,
    and unique (regardless of case) among the categories."""
    name = _name(value, Text("category.name_label"), MAX_CATEGORY_NAME, _Rules(strict=True))
    if name.casefold() in (special.casefold() for special in SPECIAL_NAMES):
        raise invalid(Text("category.name_reserved", name=name))
    for category in organization.categories:
        if category["id"] != own_id and category["name"].casefold() == name.casefold():
            raise LibraryError(409, "category_conflict", Text("category.name_taken", name=category['name']))
    return name
