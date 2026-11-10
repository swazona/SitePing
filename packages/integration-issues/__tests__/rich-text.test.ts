import type { FeedbackRecord } from "@siteping/core";
import { describe, expect, it } from "vitest";
import { buildIssueMarker, formatIssue } from "../src/core/issue-format.js";
import {
  adfToText,
  htmlToText,
  markdownToAdf,
  markdownToHtml,
  parseInline,
  withHiddenMarker,
  withVisibleMarker,
} from "../src/core/rich-text.js";

const feedback: FeedbackRecord = {
  id: "fb-1",
  type: "bug",
  message: "Hi <script>alert(1)</script> ``` [x](javascript:alert(1)) ![](https://evil.test/p.png) @all",
  status: "open",
  projectName: "pro`ject",
  url: "https://acme.test/page",
  urlPattern: null,
  viewport: "1x1",
  userAgent: "UA",
  authorName: "Eve",
  authorEmail: "eve@example.com",
  clientId: "c",
  resolvedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  annotations: [],
  screenshotUrl: "https://cdn.acme.test/shot.png",
  screenshotRegion: null,
  diagnostics: null,
} as unknown as FeedbackRecord;

const options = {
  redact: (text: string) => text,
  deepLinkParam: "siteping" as const,
  includeAuthorEmail: false,
  siteUrl: "https://acme.test",
};

describe("visible markers", () => {
  it("round-trips a marker whose JSON holds backticks", () => {
    const marker = buildIssueMarker({ feedbackId: "a`b", projectName: "``p" });
    const body = `${marker}\n\nrest`;

    const visible = withVisibleMarker(body);

    expect(visible.split("\n")[0]).not.toBe(marker);
    expect(withHiddenMarker(visible)).toBe(body);
  });

  it("leaves a body whose first line is no hidden comment as is", () => {
    expect(withVisibleMarker("## Title\n\n<!-- x -->")).toBe("## Title\n\n<!-- x -->");
    expect(withHiddenMarker("`code` and text\n\nmore")).toBe("`code` and text\n\nmore");
    expect(withHiddenMarker("`<!-- not alone -->` trailing")).toBe("`<!-- not alone -->` trailing");
  });
});

describe("parseInline", () => {
  it("follows CommonMark code spans: exact closing runs, one stripped space each side", () => {
    expect(parseInline("a ``b ` c`` d")).toEqual([
      { kind: "text", text: "a " },
      { kind: "code", text: "b ` c" },
      { kind: "text", text: " d" },
    ]);
    expect(parseInline("`` ` ``")).toEqual([{ kind: "code", text: "`" }]);
    expect(parseInline("unclosed ` tick")).toEqual([{ kind: "text", text: "unclosed ` tick" }]);
  });

  it("only links http(s) autolinks and images", () => {
    expect(parseInline("<javascript:alert(1)> ![x](<data:image/png,AA>)")).toEqual([
      { kind: "text", text: "<javascript:alert(1)> ![x](<data:image/png,AA>)" },
    ]);
  });
});

describe("the default issue in ADF and HTML", () => {
  const { body } = formatIssue(feedback, options);
  const full = withVisibleMarker(
    `${buildIssueMarker({ feedbackId: feedback.id, projectName: feedback.projectName })}\n\n${body}`,
  );

  it("keeps every visitor value as text: no link, image or markup beyond the deep link and screenshot", () => {
    const html = markdownToHtml(full);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);

    expect(hrefs).toEqual(["https://acme.test/page?siteping=fb-1", "https://cdn.acme.test/shot.png"]);
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

    const adf = JSON.stringify(markdownToAdf(full));
    const links = [...adf.matchAll(/"href":"([^"]*)"/g)].map((match) => match[1]);
    expect(links).toEqual(["https://acme.test/page?siteping=fb-1", "https://cdn.acme.test/shot.png"]);
  });

  it("reads back the marker and the message from either format", () => {
    const marker = buildIssueMarker({ feedbackId: feedback.id, projectName: feedback.projectName });
    for (const text of [adfToText(markdownToAdf(full)), htmlToText(markdownToHtml(full))]) {
      expect(text.split("\n")[0]).toBe(marker);
      expect(text).toContain(feedback.message);
    }
  });

  it("never emits an empty ADF text node, which Jira refuses", () => {
    const adf = JSON.stringify(markdownToAdf("## \n\n```text\n```\n\n- \n\n``  ``"));
    expect(adf).not.toContain('"text":""');
  });
});

describe("htmlToText", () => {
  it("decodes entities once, after dropping tags", () => {
    expect(htmlToText("<p>&lt;b&gt; &amp;lt; &#x41;&#66;</p><p>two</p>")).toBe("<b> &lt; AB\n\ntwo");
  });
});
