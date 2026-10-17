"""Messages a page can say in its own language (Phase 9b; by id since 0.0.27).

Every message has an id, such as "store.bundle_not_found", and each language a
catalog of them: locales/<language>/bundle_library.json, English included.
A Text is a message by its id and values: as a str it is the English, its
{places} filled from the values, so anyone else reads it
as before; info() gives the id and values, which said() puts beside it in an
answer as "<key>_i18n" (a list of them beside a list of Texts), so the page
says it in its own language (web/i18n.js).
A value is a name, shown as it is (a str), a number, or another Text, which is
said in the page's language too (such as Text("kind.an_image")). A message
with forms for counts ({"one": ..., "other": ...}) takes its form from the
value `count`. Messages hold {name} places only: no format specs, no braces.
"""

import json
import logging
from pathlib import Path

LOCALES = Path(__file__).resolve().parents[1] / "locales"
CATALOG = "bundle_library.json"
ENGLISH = json.loads((LOCALES / "en" / CATALOG).read_text(encoding="utf-8"))


class Text(str):
    def __new__(cls, message_id, /, **values):
        # A value is a str (a name, a Text) or a number; anything else (an exception) as its text.
        # The id goes by position only, so a value may be named "id".
        values = {name: v if isinstance(v, (str, int, float)) else str(v) for name, v in values.items()}
        self = super().__new__(cls, _english(message_id, values))
        self.id = message_id
        self.values = values
        return self

    def info(self):
        """The id and values, for a page: a Text among the values as its own info."""
        return {"id": self.id, "values": {name: _value(v) for name, v in self.values.items()}}


def _english(message_id, values):
    message = ENGLISH.get(message_id, message_id)
    if isinstance(message, dict):
        # English has two forms: "one" for exactly 1, "other" for any other count
        count = values.get("count")
        message = message["one" if count == 1 and not isinstance(count, bool) else "other"]
    return message.format(**values)


def _value(value):
    if isinstance(value, Text):
        return value.info()
    if isinstance(value, str):
        return str(value)
    return value


def said(answer):
    """`answer` with "<key>_i18n" beside each Text in it, at any depth."""
    if isinstance(answer, dict):
        out = {}
        for key, value in answer.items():
            out[key] = said(value)
            if isinstance(value, Text):
                out[f"{key}_i18n"] = value.info()
            elif isinstance(value, list) and any(isinstance(v, Text) for v in value):
                out[f"{key}_i18n"] = [v.info() if isinstance(v, Text) else None for v in value]
        return out
    if isinstance(answer, list):
        return [said(value) for value in answer]
    if isinstance(answer, str):
        return str(answer)
    return answer


def language(code, languages):
    """The language of `languages` for a code such as "ko-KR" or "zh-TW": the same code, else its base
    language ("ko"), else None. Codes are compared without regard to case."""
    code = str(code or "").lower().replace("_", "-")
    by_code = {name.lower(): name for name in languages}
    return by_code.get(code) or by_code.get(code.split("-")[0])


def catalogs(code):
    """The answer to GET /messages: the languages with a catalog, and the catalogs of English and of the
    language for `code`. Read from the disk on each request, so a page newer than this server (updated but
    not yet restarted) gets the catalogs it was made with. A translation is sent as its text alone, without
    the English it was made from. A catalog that cannot be read is left out, and the reason logged."""
    languages = sorted(path.parent.name for path in LOCALES.glob(f"*/{CATALOG}"))
    messages = {"en": json.loads((LOCALES / "en" / CATALOG).read_text(encoding="utf-8"))}
    chosen = language(code, languages)
    if chosen and chosen != "en":
        try:
            entries = json.loads((LOCALES / chosen / CATALOG).read_text(encoding="utf-8"))
            messages[chosen] = {id: entry["text"] for id, entry in entries.items()
                                if isinstance(entry, dict) and isinstance(entry.get("text"), (str, dict))}
        except (OSError, ValueError, AttributeError) as e:
            logging.warning("[Bundle Library] the %s catalog cannot be read: %s", chosen, e)
    return {"languages": languages, "messages": messages}
