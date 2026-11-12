"""Verify local URLs and fragment targets in the built Starlight HTML."""

import argparse
from functools import cache
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SITE = "https://ks250206.github.io"
APP = "/OresmePro/"
DOCS = f"{APP}docs/"


class Document(HTMLParser):
    def __init__(self, path):
        super().__init__()
        self.ids = set()
        self.urls = set()
        self.feed(path.read_text(encoding="utf-8"))

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        for name, value in attrs:
            if not value:
                continue
            if name == "id":
                self.ids.add(value)
            elif name in {"href", "src"}:
                self.urls.add((value, attributes.get("rel") if tag == "link" else None))
            elif name == "srcset":
                self.urls.update(
                    (src.split()[0], None) for src in value.split(",") if src.strip()
                )


@cache
def read_document(path):
    return Document(path)


def output_file(root, path):
    target = root / path.lstrip("/")
    if target.is_dir():
        target /= "index.html"
    return target


def check(root, pages):
    errors = []
    sources = sorted(root.rglob("*.html"))
    if not sources:
        raise SystemExit(f"No built HTML in {root}. Build the documentation first.")
    for source in sources:
        relative = source.relative_to(root).as_posix()
        base = APP if pages else DOCS
        page_url = f"{SITE}{base}{relative.removesuffix('index.html')}"
        for url, rel in sorted(
            read_document(source).urls, key=lambda link: (link[0], link[1] or "")
        ):
            # Starlight emits metadata for /404/ and /en/404/. GitHub Pages
            # serves the generated 404.html as the response to missing URLs.
            if source.name == "404.html" and rel in {"canonical", "alternate"}:
                continue
            target = urlsplit(urljoin(page_url, url))
            if target.scheme != "https" or target.netloc != urlsplit(SITE).netloc:
                continue
            path = unquote(target.path)
            if path.startswith(DOCS):
                file = output_file(
                    pages or root, path.removeprefix(APP if pages else DOCS)
                )
            elif pages and path.startswith(APP):
                file = output_file(pages, path.removeprefix(APP))
            elif path == APP and pages is None:
                # The standalone docs build links to the app root of the combined deployment.
                continue
            else:
                errors.append(f"{relative}: URL outside the deployment: {url}")
                continue
            if not file.is_file():
                errors.append(f"{relative}: missing target: {url}")
            elif (
                target.fragment
                and file.suffix == ".html"
                and unquote(target.fragment) not in read_document(file).ids
            ):
                errors.append(f"{relative}: missing fragment: {url}")
    if errors:
        raise SystemExit("\n".join(errors))
    print(f"Checked internal URLs and fragments in {len(sources)} HTML files.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pages", type=Path, help="combined Pages output directory")
    args = parser.parse_args()
    check(args.pages or ROOT / "dist", args.pages)


if __name__ == "__main__":
    main()
