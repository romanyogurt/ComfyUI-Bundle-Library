"""The wiki's pages (wiki/, published to the repository's wiki): every link between them leads to a page
and a heading that exist, and the sidebar lists every page. Links name the file (Page.md), so that they also
work where the pages are read in the repository; publishing them to the wiki takes the ".md" off."""

import re
import unittest
from pathlib import Path

WIKI = Path(__file__).resolve().parents[1] / "wiki"
LINK = re.compile(r"\]\(([^)\s]+)\)")


def anchors(text):
    """The anchors GitHub gives the headings of a page: lower case, punctuation dropped, spaces as hyphens."""
    return {re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-")
            for heading in re.findall(r"^#{2,6} (.+)$", text, re.M)}


class WikiTest(unittest.TestCase):
    def setUp(self):
        self.pages = {path.stem: path.read_text(encoding="utf-8") for path in WIKI.glob("*.md")}

    def test_links_between_pages_lead_somewhere(self):
        self.assertIn("Home", self.pages)
        broken = []
        for name, text in self.pages.items():
            for target in LINK.findall(text):
                if target.startswith(("http://", "https://", "mailto:")):
                    continue
                page, _, anchor = target.partition("#")
                if page and not page.endswith(".md"):
                    broken.append(f"{name}: {target} names no file (Page.md)")
                    continue
                page = page.removesuffix(".md") or name
                if page not in self.pages:
                    broken.append(f"{name}: no page {target}")
                elif anchor and anchor not in anchors(self.pages[page]):
                    broken.append(f"{name}: no heading {target}")
        self.assertEqual(broken, [])

    def test_the_sidebar_lists_every_page(self):
        listed = {target.partition("#")[0].removesuffix(".md") for target in LINK.findall(self.pages["_Sidebar"])}
        self.assertEqual(sorted(set(self.pages) - listed - {"_Sidebar"}), [])


if __name__ == "__main__":
    unittest.main()
