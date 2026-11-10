import {
  type CommentResponse,
  errorFromResponse,
  type FeedbackQuery,
  type FeedbackResponse,
  type FeedbackResponseList,
  type FeedbackStatus,
  feedbackQueryToSearchParams,
  networkErrorFromException,
  newClientId,
  parseHttpUrl,
  withSearchParams,
} from "@siteping/core";

/** How the server is reached. */
export interface SitepingApiClientOptions {
  /** URL of the mounted `@siteping/server` handler, e.g. `https://example.com/api/siteping`. */
  endpoint: string;
  /** The handler's `apiKey`, sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** The project the widget reports to (`projectName`). */
  projectName: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch | undefined;
}

/** Server-side filters of one list page (the handler's GET query). */
export type SitepingListQuery = Omit<FeedbackQuery, "projectName" | "url" | "urlPattern">;

/** A screenshot's bytes, as MCP image content wants them. */
export interface SitepingScreenshot {
  /** Base64, without a `data:` prefix. */
  data: string;
  mimeType: string;
}

/** The server's largest page (`getQuerySchema`). */
export const SERVER_PAGE_LIMIT = 100;

/** Largest screenshot fetched: the widget's own cap is 1.5 MB of data URL. */
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface SitepingApiClient {
  readonly projectName: string;
  /** One page of the project's feedbacks, newest first. */
  list(query: SitepingListQuery): Promise<FeedbackResponseList>;
  /**
   * One feedback by id. The HTTP API has no single-feedback route, so this
   * walks the list (100 at a time, at most `maxPages` pages) — `null` when
   * it is not found there.
   */
  find(id: string, maxPages?: number): Promise<FeedbackResponse | null>;
  /** PATCH a feedback's status; the server derives `resolvedAt`. */
  setStatus(id: string, status: FeedbackStatus): Promise<FeedbackResponse>;
  /** POST a reply to a feedback's thread, as the team (the API key vouches for the role). */
  addComment(feedbackId: string, body: string, authorName: string): Promise<CommentResponse>;
  /**
   * A feedback's screenshot: decoded from an inline data URL, or fetched —
   * with the API key only when it lives on the endpoint's own origin.
   */
  screenshot(feedback: Pick<FeedbackResponse, "screenshotUrl">): Promise<SitepingScreenshot>;
}

/** A thin client over the `@siteping/server` HTTP API, authenticated with its API key. */
export function createSitepingApiClient(options: SitepingApiClientOptions): SitepingApiClient {
  const { endpoint, apiKey, projectName } = options;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const endpointUrl = parseHttpUrl(endpoint);
  if (!endpointUrl)
    throw new Error(`[siteping-mcp] SITEPING_URL must be an http(s) URL, got ${JSON.stringify(endpoint)}`);
  const auth = { Authorization: `Bearer ${apiKey}` };

  async function request(label: string, url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await doFetch(url, init);
    } catch (error) {
      throw networkErrorFromException(error, label);
    }
    if (!response.ok) throw await errorFromResponse(response, label);
    return response;
  }

  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const list: SitepingApiClient["list"] = async (query) => {
    const params = feedbackQueryToSearchParams({ ...query, projectName });
    const response = await request("Failed to list feedbacks", withSearchParams(endpoint, params), {
      method: "GET",
      headers: auth,
      cache: "no-store",
    });
    return (await response.json()) as FeedbackResponseList;
  };

  return {
    projectName,
    list,

    async find(id, maxPages = 50) {
      for (let page = 1; page <= maxPages; page++) {
        const result = await list({ page, limit: SERVER_PAGE_LIMIT });
        const found = result.feedbacks.find((feedback) => feedback.id === id);
        if (found) return found;
        if (page * SERVER_PAGE_LIMIT >= result.total || result.feedbacks.length === 0) return null;
      }
      return null;
    },

    async setStatus(id, status) {
      const response = await request("Failed to update feedback", endpoint, json("PATCH", { id, projectName, status }));
      return (await response.json()) as FeedbackResponse;
    },

    async addComment(feedbackId, body, authorName) {
      const response = await request(
        "Failed to post reply",
        endpoint,
        json("POST", {
          projectName,
          feedbackId,
          body,
          authorName,
          authorEmail: "",
          authorRole: "team",
          clientId: newClientId(),
        }),
      );
      return (await response.json()) as CommentResponse;
    },

    async screenshot({ screenshotUrl }) {
      if (!screenshotUrl) throw new Error("This feedback has no screenshot.");
      const inline = /^data:(image\/[a-z+.-]+);base64,(.*)$/is.exec(screenshotUrl);
      if (inline) {
        const [, mimeType = "", data = ""] = inline;
        if (!IMAGE_TYPES.has(mimeType.toLowerCase())) throw new Error(`Unsupported screenshot type ${mimeType}.`);
        return { data, mimeType: mimeType.toLowerCase() };
      }
      const url = parseHttpUrl(screenshotUrl, endpointUrl.href);
      if (!url) throw new Error("The screenshot URL is neither an inline image nor an http(s) URL.");
      // The key authenticates this server only: never sent to a bucket or a CDN.
      const headers = url.origin === endpointUrl.origin ? auth : undefined;
      const response = await request("Failed to fetch the screenshot", url.href, headers ? { headers } : {});
      const mimeType = (response.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (!IMAGE_TYPES.has(mimeType))
        throw new Error(`The screenshot URL did not return an image (${mimeType || "no type"}).`);
      const declared = Number(response.headers.get("Content-Length"));
      if (declared > MAX_SCREENSHOT_BYTES) throw new Error("The screenshot is too large to return.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_SCREENSHOT_BYTES) throw new Error("The screenshot is too large to return.");
      return { data: Buffer.from(bytes).toString("base64"), mimeType };
    },
  };
}
