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
  .cattea-history-trigger {
    min-height: 34px;
    border: 1px solid color-mix(in oklch, var(--line), transparent 8%);
    border-radius: 999px;
    background: oklch(0.08 0.012 220 / 0.62);
    color: var(--muted);
    padding: 0 13px;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .cattea-history-trigger:hover, .cattea-history-trigger:focus-visible {
    color: var(--ice);
    border-color: color-mix(in oklch, var(--ice), var(--line) 34%);
    outline: none;
  }
  .cattea-history-backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: grid;
    place-items: center;
    padding: 18px;
    background: rgba(0, 0, 0, 0.58);
    backdrop-filter: blur(10px);
  }
  .cattea-history-backdrop[hidden] { display: none; }
  .cattea-history-modal {
    width: min(620px, 100%);
    max-height: min(72vh, 720px);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 22px;
    background: color-mix(in oklch, var(--panel-strong), black 8%);
    box-shadow: 0 28px 90px rgba(0, 0, 0, 0.52);
  }
  .cattea-history-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid color-mix(in oklch, var(--line), transparent 18%);
  }
  .cattea-history-title {
    color: var(--ink);
    font-size: 0.9rem;
    font-weight: 720;
    letter-spacing: 0.02em;
  }
  .cattea-history-close {
    width: 30px;
    height: 30px;
    border: 1px solid var(--line);
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .cattea-history-close:hover, .cattea-history-close:focus-visible {
    color: var(--ice);
    outline: none;
  }
  .cattea-history-list {
    min-height: 120px;
    display: grid;
    gap: 8px;
    overflow: auto;
    padding: 12px;
  }
  .cattea-history-item {
    width: 100%;
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    border: 1px solid color-mix(in oklch, var(--line), transparent 10%);
    border-radius: 14px;
    background: oklch(0.08 0.012 220 / 0.46);
    color: var(--muted);
    padding: 9px 11px;
    text-align: left;
    cursor: pointer;
  }
  .cattea-history-item:hover, .cattea-history-item:focus-visible {
    color: var(--ink);
    border-color: color-mix(in oklch, var(--ice), var(--line) 30%);
    outline: none;
  }
  .cattea-history-play {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: color-mix(in oklch, var(--green), transparent 12%);
    color: oklch(0.12 0.03 154);
    font-size: 0.72rem;
  }
  .cattea-history-copy { min-width: 0; }
  .cattea-history-copy strong {
    display: block;
    color: inherit;
    font-size: 0.86rem;
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cattea-history-copy span {
    display: block;
    margin-top: 3px;
    color: var(--faint);
    font-size: 0.74rem;
  }
  .cattea-history-empty {
    min-height: 110px;
    display: grid;
    place-items: center;
    color: var(--faint);
    font-size: 0.82rem;
  }
</style>
<script>
(() => {
  const receiver = document.querySelector('.receiver');
  if (!receiver || document.getElementById('catteaHistoryButton')) return;

  const trigger = document.createElement('button');
  trigger.id = 'catteaHistoryButton';
  trigger.className = 'cattea-history-trigger';
  trigger.type = 'button';
  trigger.textContent = 'History';

  const receiverActions = receiver.querySelector('.receiver-actions');
  if (receiverActions) receiverActions.prepend(trigger);
  else receiver.appendChild(trigger);

  const backdrop = document.createElement('div');
  backdrop.className = 'cattea-history-backdrop';
  backdrop.id = 'catteaHistoryBackdrop';
  backdrop.hidden = true;
  backdrop.innerHTML = ` + "`" + `
    <section class="cattea-history-modal" role="dialog" aria-modal="true" aria-labelledby="catteaHistoryTitle">
      <div class="cattea-history-head">
        <div class="cattea-history-title" id="catteaHistoryTitle">Recent voices</div>
        <button class="cattea-history-close" id="catteaHistoryClose" type="button" aria-label="Close history">×</button>
      </div>
      <div class="cattea-history-list" id="catteaHistoryList"></div>
      <audio id="catteaHistoryAudio" preload="metadata"></audio>
    </section>
  ` + "`" + `;
  document.body.appendChild(backdrop);

  const modal = backdrop.querySelector('.cattea-history-modal');
  const closeButton = document.getElementById('catteaHistoryClose');
  const list = document.getElementById('catteaHistoryList');
  const historyAudio = document.getElementById('catteaHistoryAudio');
  let historyObjectUrl = '';
  let activeButton = null;

  function formatRecentTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function setActiveButton(button, playing) {
    if (activeButton && activeButton !== button) {
      const previousIcon = activeButton.querySelector('.cattea-history-play');
      if (previousIcon) previousIcon.textContent = '▶';
    }
    activeButton = button;
    const icon = button?.querySelector('.cattea-history-play');
    if (icon) icon.textContent = playing ? '❚❚' : '▶';
  }

  function closeHistory() {
    backdrop.hidden = true;
  }

  async function playRecentVoice(id, button) {
    try {
      const response = await fetch('/events/recent?id=' + encodeURIComponent(id), { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.event?.audio_base64) throw new Error(data.error || 'Recent voice unavailable');

      if (historyObjectUrl) URL.revokeObjectURL(historyObjectUrl);
      const binary = atob(data.event.audio_base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      historyObjectUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      historyAudio.src = historyObjectUrl;
      setActiveButton(button, true);
      await historyAudio.play();
    } catch (error) {
      if (typeof setMessage === 'function') setMessage(error instanceof Error ? error.message : String(error), true);
      setActiveButton(button, false);
    }
  }

  async function loadRecentVoices() {
    list.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'cattea-history-empty';
    loading.textContent = 'Loading history…';
    list.appendChild(loading);

    try {
      const response = await fetch('/events/recent', { cache: 'no-store' });
      const data = await response.json();
      const events = Array.isArray(data.events) ? data.events : [];
      list.replaceChildren();
      if (!events.length) {
        const empty = document.createElement('div');
        empty.className = 'cattea-history-empty';
        empty.textContent = 'No recent voices yet';
        list.appendChild(empty);
        return;
      }

      events.forEach((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cattea-history-item';

        const play = document.createElement('span');
        play.className = 'cattea-history-play';
        play.textContent = '▶';

        const copy = document.createElement('span');
        copy.className = 'cattea-history-copy';
        const title = document.createElement('strong');
        title.textContent = item.text || 'Voice clip';
        const meta = document.createElement('span');
        meta.textContent = [formatRecentTime(item.created_at), item.model_id || ''].filter(Boolean).join(' · ');
        copy.append(title, meta);
        button.append(play, copy);
        button.addEventListener('click', () => {
          if (activeButton === button && !historyAudio.paused) {
            historyAudio.pause();
            setActiveButton(button, false);
            return;
          }
          playRecentVoice(item.id, button);
        });
        list.appendChild(button);
      });
    } catch (_error) {
      list.replaceChildren();
      const failed = document.createElement('div');
      failed.className = 'cattea-history-empty';
      failed.textContent = 'History unavailable';
      list.appendChild(failed);
    }
  }

  trigger.addEventListener('click', async (event) => {
    event.stopPropagation();
    backdrop.hidden = false;
    await loadRecentVoices();
    closeButton.focus();
  });

  closeButton.addEventListener('click', closeHistory);
  modal.addEventListener('click', (event) => event.stopPropagation());
  backdrop.addEventListener('click', closeHistory);
  historyAudio.addEventListener('ended', () => {
    if (activeButton) setActiveButton(activeButton, false);
  });
  historyAudio.addEventListener('pause', () => {
    if (activeButton && historyAudio.currentTime < historyAudio.duration) setActiveButton(activeButton, false);
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !backdrop.hidden) closeHistory();
  });
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
