import worker, { type Env } from "./index";

const DEFAULT_BOT_NAME = "CatTea";
const RECENT_INDEX_PATH = "/__cattea/recent-index";
const RECENT_EVENT_PREFIX = "/__cattea/recent-event/";
const RECENT_LIMIT = 12;

type VoiceEvent = {
  id: string;
  text: string;
  audio_base64: string;
  created_at: string;
  provider?: string;
  model_id?: string;
  [key: string]: unknown;
};

type RecentVoiceMeta = {
  id: string;
  text: string;
  created_at: string;
  provider?: string;
  model_id?: string;
};

type McpRequestInfo = {
  method?: string;
  toolName?: string;
};

function cacheRequest(origin: string, path: string): Request {
  return new Request(new URL(path, origin).toString(), { method: "GET" });
}

async function readRecentIndex(origin: string): Promise<RecentVoiceMeta[]> {
  const response = await caches.default.match(cacheRequest(origin, RECENT_INDEX_PATH));
  if (!response) return [];
  try {
    const data = await response.json<RecentVoiceMeta[]>();
    return Array.isArray(data) ? data : [];
  } catch (_error) {
    return [];
  }
}

async function appendRecentEvent(origin: string, event: VoiceEvent): Promise<void> {
  if (!event.id || !event.audio_base64) return;

  await caches.default.put(
    cacheRequest(origin, RECENT_EVENT_PREFIX + encodeURIComponent(event.id)),
    Response.json(event, { headers: { "Cache-Control": "public, max-age=86400" } }),
  );

  const current = await readRecentIndex(origin);
  const meta: RecentVoiceMeta = {
    id: event.id,
    text: event.text || "",
    created_at: event.created_at || new Date().toISOString(),
    provider: event.provider,
    model_id: event.model_id,
  };
  const next = [meta, ...current.filter((item) => item.id !== meta.id)].slice(0, RECENT_LIMIT);

  await caches.default.put(
    cacheRequest(origin, RECENT_INDEX_PATH),
    Response.json(next, { headers: { "Cache-Control": "public, max-age=86400" } }),
  );
}

async function captureLatestVoiceEvent(origin: string, env: Env, ctx: ExecutionContext): Promise<void> {
  try {
    const response = await worker.fetch(
      new Request(new URL("/events/latest", origin).toString(), { method: "GET" }),
      env,
      ctx,
    );
    if (!response.ok) return;
    const data = await response.json<{ event?: VoiceEvent | null }>();
    if (data.event) await appendRecentEvent(origin, data.event);
  } catch (error) {
    console.error("Failed to capture recent CatTea voice event", error);
  }
}

async function readMcpRequestInfo(request: Request): Promise<McpRequestInfo> {
  if (request.method !== "POST") return {};
  try {
    const payload = await request.clone().json() as Record<string, unknown> | Array<Record<string, unknown>>;
    const record = Array.isArray(payload) ? payload[0] : payload;
    if (!record || typeof record !== "object") return {};
    const params = record.params && typeof record.params === "object"
      ? record.params as Record<string, unknown>
      : undefined;
    return {
      method: typeof record.method === "string" ? record.method : undefined,
      toolName: typeof params?.name === "string" ? params.name : undefined,
    };
  } catch (_error) {
    return {};
  }
}

function hasAudioPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasAudioPayload);
  const record = value as Record<string, unknown>;
  if (typeof record.audio_base64 === "string" && record.audio_base64.length > 0) return true;
  return Object.values(record).some(hasAudioPayload);
}

function patchPlayerHtml(html: string): string {
  const dataUriLine = "const audioUrl = 'data:audio/mpeg;base64,' + audioBase64;";
  const blobPlayer = [
    "const binary = atob(audioBase64);",
    "      const bytes = new Uint8Array(binary.length);",
    "      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);",
    "      const audioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));",
  ].join("\n");
  return html.replace(dataUriLine, blobPlayer);
}

function patchResourceStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return value.includes("data:audio/mpeg;base64,") ? patchPlayerHtml(value) : value;
  }
  if (Array.isArray(value)) return value.map(patchResourceStrings);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, patchResourceStrings(item)]),
  );
}

async function patchMcpResourceResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.includes("json")) return response;
  try {
    const data = await response.clone().json<unknown>();
    const patched = patchResourceStrings(data);
    return new Response(JSON.stringify(patched), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (_error) {
    return response;
  }
}

function recentPanelAddon(): string {
  return `
<style>
  .cattea-recent { display: grid; gap: 8px; margin-top: 4px; }
  .cattea-recent-title { color: var(--muted); font-size: 0.78rem; letter-spacing: 0.12em; text-transform: uppercase; }
  .cattea-recent-list { display: grid; gap: 6px; max-height: 180px; overflow: auto; }
  .cattea-recent-item { width: 100%; border: 1px solid var(--line); border-radius: 12px; background: transparent; color: var(--muted); padding: 8px 10px; text-align: left; cursor: pointer; }
  .cattea-recent-item:hover, .cattea-recent-item:focus-visible { color: var(--ink); border-color: var(--ice); outline: none; }
  .cattea-recent-item strong { display: block; color: inherit; font-size: 0.86rem; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cattea-recent-item span { display: block; margin-top: 3px; color: var(--faint); font-size: 0.74rem; }
</style>
<script>
(() => {
  const messageEl = document.getElementById('message');
  if (!messageEl || document.getElementById('catteaRecentList')) return;

  const wrap = document.createElement('div');
  wrap.className = 'cattea-recent';
  wrap.innerHTML = '<div class="cattea-recent-title">recent voices</div><div class="cattea-recent-list" id="catteaRecentList"></div>';
  messageEl.insertAdjacentElement('afterend', wrap);
  const list = document.getElementById('catteaRecentList');

  function formatRecentTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  async function openRecentVoice(id) {
    try {
      const response = await fetch('/events/recent?id=' + encodeURIComponent(id), { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.event) throw new Error(data.error || 'Recent voice unavailable');
      if (typeof receiveVoiceEvent === 'function') receiveVoiceEvent(data.event);
    } catch (error) {
      if (typeof setMessage === 'function') setMessage(error instanceof Error ? error.message : String(error), true);
    }
  }

  async function loadRecentVoices() {
    try {
      const response = await fetch('/events/recent', { cache: 'no-store' });
      const data = await response.json();
      const events = Array.isArray(data.events) ? data.events : [];
      list.replaceChildren();
      if (!events.length) {
        const empty = document.createElement('div');
        empty.style.color = 'var(--faint)';
        empty.style.fontSize = '0.8rem';
        empty.textContent = 'No recent voices yet';
        list.appendChild(empty);
        return;
      }
      events.forEach((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cattea-recent-item';
        const title = document.createElement('strong');
        title.textContent = item.text || 'Voice clip';
        const meta = document.createElement('span');
        meta.textContent = [formatRecentTime(item.created_at), item.model_id || ''].filter(Boolean).join(' · ');
        button.append(title, meta);
        button.addEventListener('click', () => openRecentVoice(item.id));
        list.appendChild(button);
      });
    } catch (_error) {}
  }

  loadRecentVoices();
  setInterval(loadRecentVoices, 3000);
})();
</script>`;
}

function personalizePanelHtml(html: string): string {
  const personalized = html
    .replaceAll("等哥哥说话。", "等猫猫说话。")
    .replaceAll("A breathing audio field for Haven.", "A breathing audio field for CatTea.")
    .replaceAll("haven-voice", "cattea-voice")
    .replaceAll(">HAVEN<", ">CATTEA<");
  return personalized.replace("</body>", recentPanelAddon() + "\n</body>");
}

async function handleRecentEvents(request: Request, origin: string): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id")?.trim();
  if (!id) {
    return Response.json({ events: await readRecentIndex(origin) }, {
      headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    });
  }

  const response = await caches.default.match(
    cacheRequest(origin, RECENT_EVENT_PREFIX + encodeURIComponent(id)),
  );
  if (!response) {
    return Response.json({ error: "Recent voice not found" }, {
      status: 404,
      headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    });
  }
  const event = await response.json<VoiceEvent>();
  return Response.json({ event }, {
    headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    env.BOT_NAME = env.BOT_NAME?.trim() || DEFAULT_BOT_NAME;

    const url = new URL(request.url);
    const path = url.pathname;
    const origin = url.origin;

    if (path === "/events/recent" && request.method === "GET") {
      return handleRecentEvents(request, origin);
    }

    const mcpInfo = path === "/mcp" || path === "/mcp/" || path === "/sse"
      ? await readMcpRequestInfo(request)
      : {};

    let response = await worker.fetch(request, env, ctx);
    const contentType = response.headers.get("Content-Type") || "";

    if (path === "/panel" && contentType.includes("text/html")) {
      const personalizedHtml = personalizePanelHtml(await response.text());
      return new Response(personalizedHtml, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    if (mcpInfo.method === "resources/read") {
      response = await patchMcpResourceResponse(response);
    }

    if (path === "/speak" && response.ok && contentType.includes("audio/")) {
      ctx.waitUntil(captureLatestVoiceEvent(origin, env, ctx));
    } else if (mcpInfo.method === "tools/call" && mcpInfo.toolName === "speak" && response.ok) {
      try {
        const data = await response.clone().json<unknown>();
        if (hasAudioPayload(data)) ctx.waitUntil(captureLatestVoiceEvent(origin, env, ctx));
      } catch (_error) {}
    }

    return response;
  },
};
