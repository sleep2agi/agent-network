"""Offline README image/source gate; not a substitute for GitHub browser UAT."""
from html.parser import HTMLParser
from pathlib import Path
import markdown
from PIL import Image


class Images(HTMLParser):
    def __init__(self):
        super().__init__()
        self.images = []
        self.sources = []
        self.details = 0
        self.summaries = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "img":
            self.images.append(attrs)
        if tag == "source":
            self.sources.append(attrs)
        self.details += tag == "details"
        self.summaries += tag == "summary"


hero = "docs-site/docs/public/hero/"
features = "docs-site/docs/public/features/"
expected = [hero + "desktop-chat-light.png", features + "tasks-board.webp",
            features + "task-detail.webp", features + "scheduled-tasks.webp"]
site = Path("docs-site/docs/index.md").read_text()
component = Path("docs-site/docs/.vitepress/theme/components/HeroLive.vue").read_text()
for path in expected + [hero + "desktop-chat-dark.png"]:
    assert Path(path).name in site + component, f"not used by website: {path}"
    with Image.open(path) as im:
        im.load()
        assert im.width >= 1440 and im.height >= 900, path
        print(f"PASS decode {path}: {im.width}x{im.height}")

for name in ["README.md", "README.en.md"]:
    source = Path(name).read_text()
    assert "docs/assets/readme/chat-" not in source
    assert "docs/assets/readme/tasks-" not in source
    assert "sample data" in source or "示例数据" in source
    # Raw HTML is intentionally kept as GitHub-supported picture/details/img.
    parsed = Images()
    parsed.feed(markdown.markdown(source, extensions=["tables", "fenced_code"]))
    screenshots = [a for a in parsed.images if a.get("src", "").startswith("docs-site/")]
    assert [a["src"] for a in screenshots] == expected, name
    assert all(a.get("alt") and a.get("width") == "880" for a in screenshots)
    assert parsed.sources == [{"media": "(prefers-color-scheme: dark)",
                               "srcset": hero + "desktop-chat-dark.png"}], name
    assert parsed.details == parsed.summaries == 1, name
    assert source.count("</details>") == 1 and source.count("</picture>") == 1
    for attrs in parsed.images + parsed.sources:
        path = attrs.get("src") or attrs.get("srcset")
        if not path.startswith("https://"):
            assert Path(path).is_file(), f"missing local image: {path}"
    print(f"PASS {name}: shared sources, order, alt, width, themes, details, local paths")
print("PASS README visual-source gate; no product/runtime tests required for docs-only change")
