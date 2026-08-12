import worker, { type Env } from "./index";

const DEFAULT_BOT_NAME = "CatTea";

function personalizePanelHtml(html: string): string {
  return html
    .replaceAll("等哥哥说话。", "等猫猫说话。")
    .replaceAll("A breathing audio field for Haven.", "A breathing audio field for CatTea.")
    .replaceAll("haven-voice", "cattea-voice")
    .replaceAll(">HAVEN<", ">CATTEA<");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    env.BOT_NAME = env.BOT_NAME?.trim() || DEFAULT_BOT_NAME;

    const response = await worker.fetch(request, env, ctx);
    const path = new URL(request.url).pathname;
    const contentType = response.headers.get("Content-Type") || "";

    if (path !== "/panel" || !contentType.includes("text/html")) {
      return response;
    }

    const personalizedHtml = personalizePanelHtml(await response.text());
    return new Response(personalizedHtml, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
};
