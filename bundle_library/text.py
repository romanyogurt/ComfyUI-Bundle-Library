"""Messages a page can say in its own language (Phase 9b).

A Text is an English sentence, exactly as before (it is a str), that remembers
its template and values: the template "Field '{name}'" with name "ref" is the
text "Field 'ref'".
A value may be a Word, a word or phrase to translate ("an image"), unlike a
name, which is shown as it is; or another Text. said() puts beside each Text
in an answer its template and values, as "<key>_i18n" (a list of them beside
a list of Texts), so the page says it with its own dictionary (web/i18n.js,
where the English template is the key). Anyone else reads the English as
before. Templates hold {name} places only: no format specs, no braces.
"""


class Word(str):
    """A value of a Text that is itself a word to translate, such as "an image"."""


class Text(str):
    def __new__(cls, template, **values):
        # A value is a str (a name, a Word, a Text) or a number; anything else (an exception) as its text.
        values = {name: v if isinstance(v, (str, int, float)) else str(v) for name, v in values.items()}
        self = super().__new__(cls, template.format(**values))
        self.template = template
        self.values = values
        return self

    def info(self):
        """The template and values, for a page: a Word as {"word"}, a Text as its own info."""
        return {"template": self.template, "values": {name: _value(v) for name, v in self.values.items()}}


def _value(value):
    if isinstance(value, Text):
        return value.info()
    if isinstance(value, Word):
        return {"word": str(value)}
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
