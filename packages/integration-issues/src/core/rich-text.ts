import { parseHttpUrl } from "@siteping/core";
import { codeSpan } from "./markdown.js";

/*
 * The Markdown the issue format writes, for trackers that take another
 * format: Jira's Atlassian Document Format (ADF) and Plane's HTML. Only the
 * subset `formatIssue` emits is recognised — `#` headings, fenced code
 * blocks, `- ` lists, code spans, `<https://…>` autolinks, `![alt](<url>)`
 * images and a paragraph wrapped in `_` — and everything else stays plain
 * text. Nothing a visitor typed can become markup: it is quoted as code by
 * the format, and plain text by this converter, which only ever builds text
 * nodes (ADF) or escaped text (HTML). Links only point to http(s) URLs.
 *
 * Trackers that do not render HTML comments would show, or drop, the hidden
 * markers that link an issue to its feedback (`<!-- siteping-feedback … -->`).
 * `withVisibleMarker` turns such a first line into a code span, which every
 * tracker keeps verbatim, and `withHiddenMarker` turns it back when reading.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "break" };

export type Block =
  | { kind: "heading"; level: number; content: Inline[]; emphasis?: false }
  | { kind: "paragraph"; content: Inline[]; emphasis: boolean }
  | { kind: "code"; text: string }
  | { kind: "list"; items: Inline[][] };

const FENCE = /^(`{3,})[^`]*$/;
const HEADING = /^(#{1,6}) (.*)$/;
const LIST_ITEM = /^- (.*)$/;
const AUTOLINK = /^<(https?:\/\/[^\s<>]+)>/;
const IMAGE = /^!\[([^\]]*)\]\((?:<([^<>\s]+)>|([^()\s]+))\)/;
const HIDDEN_LINE = /^<!--.*-->$/;

/** A run of backticks closes a code span only when it has the opening run's exact length. */
function closingRun(text: string, from: number, length: number): number {
  const runs = /`+/g;
  runs.lastIndex = from;
  for (let run = runs.exec(text); run; run = runs.exec(text)) {
    if (run[0].length === length) return run.index;
  }
  return -1;
}

/** Inline content of one line or paragraph. */
export function parseInline(text: string): Inline[] {
  const nodes: Inline[] = [];
  let plain = "";
  const flush = () => {
    if (plain) nodes.push({ kind: "text", text: plain });
    plain = "";
  };
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const char = text[index];
    if (char === "\n") {
      flush();
      nodes.push({ kind: "break" });
      index += 1;
      continue;
    }
    if (char === "`") {
      const opening = /^`+/.exec(rest)?.[0].length ?? 1;
      const close = closingRun(text, index + opening, opening);
      if (close < 0) {
        plain += "`".repeat(opening);
        index += opening;
        continue;
      }
      let code = text.slice(index + opening, close).replace(/\n/g, " ");
      // CommonMark strips one space on both sides, unless the span is only spaces.
      if (/^ .* $/s.test(code) && code.trim() !== "") code = code.slice(1, -1);
      flush();
      nodes.push({ kind: "code", text: code });
      index = close + opening;
      continue;
    }
    const autolink = char === "<" ? AUTOLINK.exec(rest) : null;
    const autolinkUrl = autolink?.[1] ? parseHttpUrl(autolink[1]) : null;
    if (autolink && autolinkUrl) {
      flush();
      nodes.push({ kind: "link", text: autolink[1] as string, href: autolinkUrl.href });
      index += autolink[0].length;
      continue;
    }
    const image = char === "!" ? IMAGE.exec(rest) : null;
    const imageUrl = image ? parseHttpUrl(image[2] ?? image[3] ?? "") : null;
    if (image && imageUrl) {
      flush();
      nodes.push({ kind: "link", text: image[1] || imageUrl.href, href: imageUrl.href });
      index += image[0].length;
      continue;
    }
    plain += char;
    index += 1;
  }
  flush();
  return nodes;
}

/** Blocks of the Markdown subset described above. */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join("\n");
    const emphasis = /^_[^_\n].*_$/s.test(text) && !text.slice(1, -1).includes("_");
    blocks.push({ kind: "paragraph", content: parseInline(emphasis ? text.slice(1, -1) : text), emphasis });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push({ kind: "list", items: list.map(parseInline) });
    list = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    const fence = FENCE.exec(line);
    if (fence?.[1]) {
      flushParagraph();
      flushList();
      const closing = fence[1];
      const code: string[] = [];
      index += 1;
      // A fence closes at a line of at least as many backticks and nothing else.
      while (index < lines.length && !new RegExp(`^${closing}\`*\\s*$`).test(lines[index] as string)) {
        code.push(lines[index] as string);
        index += 1;
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading?.[1]) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", level: heading[1].length, content: parseInline(heading[2] ?? "") });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      list.push(item[1] ?? "");
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** The body with a first line that is an HTML comment rewritten as a code span, which trackers keep. */
export function withVisibleMarker(body: string): string {
  const [first = "", ...rest] = body.split("\n");
  if (!HIDDEN_LINE.test(first)) return body;
  return [codeSpan(first), ...rest].join("\n");
}

/**
 * The body as the hooks read it: a first line that is a code span holding
 * an HTML comment — `withVisibleMarker`'s output, as a Markdown tracker
 * returns it — back to the bare comment. Plain text from `adfToText` or
 * `htmlToText` already has it bare.
 */
export function withHiddenMarker(text: string): string {
  const [first = "", ...rest] = text.replace(/\r\n?/g, "\n").split("\n");
  const [only, ...others] = parseInline(first.trim());
  if (others.length > 0 || only?.kind !== "code" || !HIDDEN_LINE.test(only.text)) return text;
  return [only.text, ...rest].join("\n");
}

// --- Atlassian Document Format (Jira) ---

export type AdfNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: AdfNode[];
};

export interface AdfDocument {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

function adfInline(nodes: Inline[], emphasis: boolean): AdfNode[] {
  const em = emphasis ? [{ type: "em" }] : [];
  // ADF refuses empty text nodes.
  return nodes.flatMap((node): AdfNode[] => {
    if (node.kind === "break") return [{ type: "hardBreak" }];
    if (node.text === "") return [];
    if (node.kind === "code") return [{ type: "text", text: node.text, marks: [{ type: "code" }] }];
    if (node.kind === "link") {
      return [{ type: "text", text: node.text, marks: [...em, { type: "link", attrs: { href: node.href } }] }];
    }
    return [{ type: "text", text: node.text, ...(em.length > 0 ? { marks: em } : {}) }];
  });
}

const withContent = (node: AdfNode, content: AdfNode[]): AdfNode => (content.length > 0 ? { ...node, content } : node);

function adfBlock(block: Block): AdfNode {
  if (block.kind === "heading") {
    return withContent({ type: "heading", attrs: { level: block.level } }, adfInline(block.content, false));
  }
  if (block.kind === "paragraph") return withContent({ type: "paragraph" }, adfInline(block.content, block.emphasis));
  if (block.kind === "code") {
    return withContent(
      { type: "codeBlock", attrs: { language: "text" } },
      block.text ? [{ type: "text", text: block.text }] : [],
    );
  }
  return {
    type: "bulletList",
    content: block.items.map((item) => ({
      type: "listItem",
      content: [withContent({ type: "paragraph" }, adfInline(item, false))],
    })),
  };
}

/** An ADF document of the Markdown subset. */
export function markdownToAdf(markdown: string): AdfDocument {
  return { version: 1, type: "doc", content: parseBlocks(markdown).map(adfBlock) };
}

/** Plain text of an ADF node: blocks separated by a blank line, hard breaks as line breaks. */
export function adfToText(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const { type, text, content } = node as AdfNode;
  if (type === "text") return typeof text === "string" ? text : "";
  if (type === "hardBreak") return "\n";
  const children = Array.isArray(content) ? content : [];
  if (type === "paragraph" || type === "heading" || type === "codeBlock") return children.map(adfToText).join("");
  const separator = type === "bulletList" || type === "orderedList" || type === "listItem" ? "\n" : "\n\n";
  return children.map(adfToText).join(separator);
}

// --- HTML (Plane) ---

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] as string);

function htmlInline(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "break") return "<br>";
      if (node.kind === "code") return `<code>${escapeHtml(node.text)}</code>`;
      if (node.kind === "link") {
        return `<a href="${escapeHtml(node.href)}" rel="noopener noreferrer nofollow">${escapeHtml(node.text)}</a>`;
      }
      return escapeHtml(node.text);
    })
    .join("");
}

function htmlBlock(block: Block): string {
  if (block.kind === "heading") return `<h${block.level}>${htmlInline(block.content)}</h${block.level}>`;
  if (block.kind === "paragraph") {
    const inline = htmlInline(block.content);
    return `<p>${block.emphasis ? `<em>${inline}</em>` : inline}</p>`;
  }
  if (block.kind === "code") return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
  return `<ul>${block.items.map((item) => `<li><p>${htmlInline(item)}</p></li>`).join("")}</ul>`;
}

/** HTML of the Markdown subset, every text escaped. */
export function markdownToHtml(markdown: string): string {
  return parseBlocks(markdown).map(htmlBlock).join("");
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/** Plain text of tracker HTML: block elements on lines of their own, tags dropped, entities decoded. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|h[1-6]|pre|li|ul|ol|div|blockquote)>/gi, "\n\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
