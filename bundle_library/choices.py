"""Choice fields (0.2.0): a value for a dropdown input of another node, and
optionally its source, the input whose options it is checked against:
{"node": <class_type>, "input": <input name>}.

The options come from a provider. ComfyProvider reads ComfyUI's node
definitions (INPUT_TYPES), each class once: make one per judgement (a cache
key, a run, an answer of the API), so that a judgement sees one list and the
next one reads it again. Classifying an input and resolving a value are pure,
and the tests give providers of their own. web/choices.js resolves the same
way (tests/fixtures/choices.json holds both to the same cases)."""
import logging
import os
from dataclasses import dataclass

# What a provider says of a source
READ = "read"                # its options were read (an empty list too)
NOT_FOUND = "not_found"      # no such node or input here (another computer, a node pack removed)
UNSUPPORTED = "unsupported"  # not one choice among text options (the reason says what)
ERROR = "error"              # reading the node's definition failed
# How a value resolves, besides those
NO_SOURCE = "no_source"      # typed freely: nothing to check it against
OK = "ok"                    # one of the options
MISMATCH = "mismatch"        # not one of the options read

# Why: a source not found, or an input this version cannot fill
NO_NODE, NO_INPUT = "no_node", "no_input"
NOT_COMBO, MULTISELECT, REMOTE, DYNAMIC, NOT_TEXT = "not_combo", "multiselect", "remote", "dynamic", "not_text"
FAILED = "failed"


@dataclass(frozen=True)
class Lookup:
    state: str
    options: tuple = ()
    paths: bool = False  # the options are a model folder's files: "/" and "\" may stand for each other
    reason: str = ""
    label: str = ""      # the node's display name

    def answer(self):
        """As the API answers it: the options only when read."""
        out = {"state": self.state, "label": self.label}
        if self.state == READ:
            out.update(options=list(self.options), paths=self.paths)
        if self.reason:
            out["reason"] = self.reason
        return out


@dataclass(frozen=True)
class Resolved:
    output: str       # what the output carries
    state: str        # NO_SOURCE, OK, MISMATCH, or the lookup's state when it was not read
    lookup: object = None


def classify(spec):
    """(state, options, reason) of an input definition from INPUT_TYPES(): one
    choice among text options is READ; anything else is UNSUPPORTED, with why."""
    if not isinstance(spec, (list, tuple)) or not spec:
        return UNSUPPORTED, None, NOT_COMBO
    kind = spec[0]
    extra = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    if kind == "COMFY_DYNAMICCOMBO_V3":
        return UNSUPPORTED, None, DYNAMIC
    if extra.get("remote"):
        return UNSUPPORTED, None, REMOTE
    if isinstance(kind, (list, tuple)):
        options = list(kind)
    elif kind == "COMBO":
        if extra.get("options") is None:  # options only the page is given
            return UNSUPPORTED, None, REMOTE
        options = list(extra["options"])
    else:
        return UNSUPPORTED, None, NOT_COMBO
    # A V3 dropdown says "multiselect": false too; only a choice of several is
    # out. "multi_select" is the page's settings for one, {} when it has none.
    if extra.get("multiselect") is True or extra.get("multi_select") not in (None, False):
        return UNSUPPORTED, None, MULTISELECT
    if not all(isinstance(option, str) for option in options):
        return UNSUPPORTED, None, NOT_TEXT  # numbers stay numbers: "1" is not 1
    return READ, tuple(options), ""


def same_path(a, b):
    return a.replace("\\", "/") == b.replace("\\", "/")


def resolve(value, source, lookup):
    """What a choice field carries (a Resolved): its value as the source's options
    spell it, and whether it is one of them. Only a model folder's list takes a
    path written with the other slash, and only one matching that way (CH05).
    The stored value is never changed."""
    if source is None:
        return Resolved(value, NO_SOURCE)
    if lookup.state != READ:
        return Resolved(value, lookup.state, lookup)
    if value in lookup.options:
        return Resolved(value, OK, lookup)
    if lookup.paths:
        matches = [option for option in lookup.options if same_path(option, value)]
        if len(matches) == 1:
            return Resolved(matches[0], OK, lookup)
    return Resolved(value, MISMATCH, lookup)


class ComfyProvider:
    """Options of node inputs from ComfyUI's node definitions. Each class's
    INPUT_TYPES() is read once by a provider, outside the store's lock, and an
    exception stays with that class (CH06). `nodes` and `folder_paths` are
    ComfyUI's modules; the tests give stand-ins."""

    # Not a model folder, and every file of every node pack would be listed
    NOT_MODELS = {"custom_nodes"}

    def __init__(self, nodes=None, folder_paths=None):
        self._nodes, self._folder_paths = nodes, folder_paths
        self._types = {}
        self._folder_lists = {}

    def _modules(self):
        if self._nodes is None:
            import folder_paths  # noqa: PLC0415 — ComfyUI's, there only when it runs
            import nodes  # noqa: PLC0415
            self._nodes, self._folder_paths = nodes, folder_paths
        return self._nodes, self._folder_paths

    def _definitions(self, node):
        """INPUT_TYPES() of `node`'s class: (inputs by name, None), or (None, a reason)."""
        if node not in self._types:
            nodes, _ = self._modules()
            cls = nodes.NODE_CLASS_MAPPINGS.get(node)
            if cls is None:
                self._types[node] = (None, NO_NODE)
            else:
                try:
                    types = cls.INPUT_TYPES()
                    inputs = {}
                    for group in ("required", "optional"):
                        inputs.update(types.get(group) or {})
                    self._types[node] = (inputs, None)
                except Exception as e:  # noqa: BLE001 — a node's own code: its failure stays with it
                    logging.warning("[Bundle Library] could not read the inputs of %s: %s", node, e)
                    self._types[node] = (None, FAILED)
        return self._types[node]

    def label(self, node):
        nodes, _ = self._modules()
        return getattr(nodes, "NODE_DISPLAY_NAME_MAPPINGS", {}).get(node) or node

    def lookup(self, node, input_name):
        inputs, why = self._definitions(node)
        if inputs is None:
            return Lookup(ERROR if why == FAILED else NOT_FOUND, reason=why,
                          label=self.label(node) if why == FAILED else node)
        spec = inputs.get(input_name)
        if spec is None:
            return Lookup(NOT_FOUND, reason=NO_INPUT, label=self.label(node))
        state, options, reason = classify(spec)
        if state != READ:
            return Lookup(state, reason=reason, label=self.label(node))
        return Lookup(READ, options, self._is_model_list(options), label=self.label(node))

    def _is_model_list(self, options):
        """Whether `options` is exactly the file list of one of ComfyUI's model
        folders (folder_paths.get_filename_list(), cached by ComfyUI). A folder
        whose kinds of files the options are not is not listed."""
        if not options:
            return False
        _, folder_paths = self._modules()
        kinds = {os.path.splitext(option)[-1].lower() for option in options}
        for folder, entry in list(getattr(folder_paths, "folder_names_and_paths", {}).items()):
            extensions = entry[1] if isinstance(entry, (list, tuple)) and len(entry) > 1 else ()
            if folder in self.NOT_MODELS or (extensions and not kinds <= set(extensions)):
                continue
            if folder not in self._folder_lists:
                try:
                    self._folder_lists[folder] = tuple(folder_paths.get_filename_list(folder))
                except Exception:  # noqa: BLE001 — a folder that cannot be listed is no model list
                    self._folder_lists[folder] = None
            if self._folder_lists[folder] == options:
                return True
        return False

    def catalog(self):
        """The nodes with a dropdown input, for the editor's "Options from…": each
        with its display name, category and dropdown inputs, supported or why not."""
        nodes, _ = self._modules()
        found = []
        for node in sorted(nodes.NODE_CLASS_MAPPINGS):
            inputs, why = self._definitions(node)
            if inputs is None:
                continue
            entries = []
            for name, spec in inputs.items():
                state, options, reason = classify(spec)
                if state == READ:
                    entries.append({"input": name, "supported": True, "count": len(options)})
                elif reason != NOT_COMBO:
                    entries.append({"input": name, "supported": False, "reason": reason})
            if entries:
                cls = nodes.NODE_CLASS_MAPPINGS[node]
                found.append({"node": node, "label": self.label(node), "category": str(getattr(cls, "CATEGORY", "") or ""),
                              "inputs": entries})
        return found
