import MarkdownIt from "markdown-it";

/**
 * Markdown made into HTML for a note. A note may come in an experiment
 * from someone else, so nothing in it may run, style the app or fetch
 * anything by being shown:
 *
 * - HTML written in the text is shown as text, not taken as HTML
 * - links go only to http, https and mailto addresses, and open in a new
 *   tab that cannot reach back to the app; any other link is plain text
 * - pictures are shown only when they are in the text (data:image/...);
 *   one at an address is a link to it, so that showing a note never loads
 *   anything from elsewhere (which would tell that site it was read)
 *
 * The HTML is cleaned again by the window that shows it (see NoteWindow).
 */
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });

/** Addresses a note's links may go to. */
export const SAFE_LINK = /^(https?:|mailto:)/i;
/** Pictures a note may show: those whose data is in the text. */
export const INLINE_IMAGE = /^data:image\/(gif|png|jpeg|webp);/i;

markdown.validateLink = (url: string): boolean => {
  const address = url.trim();
  return SAFE_LINK.test(address) || INLINE_IMAGE.test(address);
};

markdown.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const token = tokens[index]!;
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return self.renderToken(tokens, index, options);
};

const defaultImage = markdown.renderer.rules.image!;
markdown.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  const source = String(token.attrGet("src") ?? "");
  if (INLINE_IMAGE.test(source)) return defaultImage(tokens, index, options, env, self);
  const alt = self.renderInlineAsText(token.children ?? [], options, env);
  const label = markdown.utils.escapeHtml(alt ? `Picture: ${alt}` : "Picture");
  return SAFE_LINK.test(source)
    ? `<a href="${markdown.utils.escapeHtml(source)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : label;
};

/** A note's Markdown as HTML (still to be cleaned before it is shown). */
export function markdownToHtml(text: string): string {
  return markdown.render(text);
}
