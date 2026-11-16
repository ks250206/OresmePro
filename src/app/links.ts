/** Where the project lives on GitHub. */
export const GITHUB_URL = "https://github.com/ks250206/OresmePro";

/** The official documentation: Japanese, with an English version under /en/. */
const DOCS_URL = "https://ks250206.github.io/OresmePro/docs/";

/** Whether the documentation should open in Japanese, as the browser's language says. */
const prefersJapanese = (): boolean =>
  typeof navigator !== "undefined" &&
  (navigator.languages ?? [navigator.language]).some((language) => /^ja\b/i.test(language));

/**
 * A page of the documentation, by its path below the docs root
 * ("guides/curve-fitting/"), in the reader's language; the root without one.
 */
export function docsUrl(page = "", japanese = prefersJapanese()): string {
  return `${DOCS_URL}${japanese ? "" : "en/"}${page}`;
}

/** Opens a page in a new tab, sharing nothing with this one. */
export function openLink(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
