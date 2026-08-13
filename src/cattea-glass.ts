import worker from "./cattea";
import type { Env } from "./index";
export { VoiceHistoryStore } from "./voice-history-store";

const CATTEA_ACCENT = "#A67DF3";

const HISTORY_GLASS_STYLE = `
<style id="catteaHistoryGlassTheme">
  .cattea-history-backdrop {
    background: rgba(0, 0, 0, 0.46);
    backdrop-filter: blur(14px) saturate(72%);
    -webkit-backdrop-filter: blur(14px) saturate(72%);
  }
  .cattea-history-modal {
    border: 1px solid var(--line);
    background:
      linear-gradient(180deg, rgba(10, 13, 15, 0.76), rgba(3, 5, 7, 0.86));
    backdrop-filter: blur(24px) saturate(68%);
    -webkit-backdrop-filter: blur(24px) saturate(68%);
    box-shadow:
      0 30px 90px rgba(0, 0, 0, 0.62),
      inset 0 1px 0 rgba(255, 255, 255, 0.025);
  }
  .cattea-history-head {
    background: rgba(4, 6, 8, 0.26);
    border-bottom-color: color-mix(in oklch, var(--line), transparent 18%);
  }
  .cattea-history-list {
    background: rgba(0, 0, 0, 0.08);
  }
  .cattea-history-item {
    background: rgba(4, 7, 9, 0.5);
    border-color: color-mix(in oklch, var(--line), transparent 10%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.018);
  }
  .cattea-history-item:hover,
  .cattea-history-item:focus-visible {
    background: rgba(9, 13, 15, 0.62);
  }
</style>`;

function applyCatTeaAccent(body: string): string {
  return body
    .replaceAll("#07c160", CATTEA_ACCENT)
    .replaceAll("#4cd964", CATTEA_ACCENT);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await worker.fetch(request, env, ctx);
    const path = new URL(request.url).pathname;
    const contentType = response.headers.get("Content-Type") || "";

    if (path === "/mcp" && (contentType.includes("json") || contentType.includes("text/"))) {
      const body = applyCatTeaAccent(await response.text());
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    if (!["/panel", "/panel-v13", "/panel-v14", "/panel-v15", "/panel-v16"].includes(path) || !contentType.includes("text/html")) {
      return response;
    }

    const html = await response.text();
    const themedHtml = html.includes("</head>")
      ? html.replace("</head>", HISTORY_GLASS_STYLE + "\n</head>")
      : html.replace("</body>", HISTORY_GLASS_STYLE + "\n</body>");

    return new Response(themedHtml, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
};
