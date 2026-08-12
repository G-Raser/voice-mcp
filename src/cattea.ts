import worker, { type Env } from "./index";

const DEFAULT_BOT_NAME = "CatTea";
const RECENT_INDEX_PATH = "/__cattea/recent-index";
const RECENT_EVENT_PREFIX = "/__cattea/recent-event/";
const RECENT_LIMIT = 12;
const RECENT_API_VERSION = "v14";

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
  history_item_id?: string;
};

type ElevenLabsHistoryItem = {
  history_item_id?: string;
  date_unix?: number;
  voice_id?: string | null;
  model_id?: string | null;
  text?: string | null;
};

type HistoryFetchResult = {
  events: RecentVoiceMeta[];
  ok: boolean;
  detail?: string;
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

async function writeRecentIndex(origin: string, events: RecentVoiceMeta[]): Promise<void> {
  await caches.default.put(
    cacheRequest(origin, RECENT_INDEX_PATH),
    Response.json(events.slice(0, RECENT_LIMIT), {
      headers: { "Cache-Control": "public, max-age=86400" },
    }),
  );
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
    history_item_id: typeof event.history_item_id === "string" ? event.history_item_id : undefined,
  };
  const next = [meta, ...current.filter((item) => item.id !== meta.id)].slice(0, RECENT_LIMIT);

  await writeRecentIndex(origin, next);
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

function getConfiguredElevenLabsVoiceIds(env: Env): Set<string> {
  return new Set([
    env.ELEVENLABS_VOICE_ID,
    env.ELEVENLABS_VOICE_ID_ZH,
    env.ELEVENLABS_VOICE_ID_EN,
  ].filter((voiceId): voiceId is string => Boolean(voiceId)));
}

function isValidHistoryItemId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

async function fetchRecentElevenLabsVoices(env: Env): Promise<HistoryFetchResult> {
  if (!env.ELEVENLABS_API_KEY) {
    return { events: [], ok: false, detail: "ElevenLabs API key is unavailable" };
  }

  try {
    const historyUrl = new URL("https://api.elevenlabs.io/v1/history");
    historyUrl.searchParams.set("page_size", "20");
    const response = await fetch(historyUrl.toString(), {
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "Accept": "application/json",
      },
    });
    if (!response.ok) {
      const detail = `ElevenLabs history returned ${response.status}`;
      console.error("Failed to load recent ElevenLabs voices", response.status, await response.text());
      return { events: [], ok: false, detail };
    }

    const data = await response.json() as { history?: ElevenLabsHistoryItem[] };
    const history = Array.isArray(data.history) ? data.history : [];
    const configuredVoiceIds = getConfiguredElevenLabsVoiceIds(env);
    const matchingHistory = configuredVoiceIds.size
      ? history.filter((item) => typeof item.voice_id === "string" && configuredVoiceIds.has(item.voice_id))
      : history;

    const events = matchingHistory
      .filter((item): item is ElevenLabsHistoryItem & { history_item_id: string } => (
        typeof item.history_item_id === "string" && isValidHistoryItemId(item.history_item_id)
      ))
      .map((item) => ({
        id: `elevenlabs-${item.history_item_id}`,
        text: item.text?.trim() || "Voice clip",
        created_at: typeof item.date_unix === "number" && Number.isFinite(item.date_unix)
          ? new Date(item.date_unix * 1000).toISOString()
          : new Date().toISOString(),
        provider: "elevenlabs",
        model_id: item.model_id || "eleven_v3",
        history_item_id: item.history_item_id,
      }));
    return { events, ok: true };
  } catch (error) {
    console.error("Failed to load recent ElevenLabs voices", error);
    return {
      events: [],
      ok: false,
      detail: error instanceof Error ? error.message : "ElevenLabs history request failed",
    };
  }
}

function mergeRecentVoices(cached: RecentVoiceMeta[], history: RecentVoiceMeta[]): RecentVoiceMeta[] {
  const enrichedCached = cached.map((item) => {
    if (item.history_item_id) return item;
    const createdAt = Date.parse(item.created_at);
    const match = history.find((historyItem) => (
      historyItem.text.trim() === item.text.trim()
      && Number.isFinite(createdAt)
      && Math.abs(Date.parse(historyItem.created_at) - createdAt) <= 90_000
    ));
    return match ? { ...item, id: match.id, history_item_id: match.history_item_id } : item;
  });
  const merged = new Map<string, RecentVoiceMeta>();

  for (const item of [...enrichedCached, ...history]) {
    const key = item.history_item_id ? `history:${item.history_item_id}` : `event:${item.id}`;
    const existing = merged.get(key);
    if (!existing || Date.parse(item.created_at) > Date.parse(existing.created_at)) {
      merged.set(key, item);
    } else if (existing.id.startsWith("elevenlabs-") && !item.id.startsWith("elevenlabs-")) {
      merged.set(key, { ...existing, ...item });
    }
  }

  return [...merged.values()]
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    .slice(0, RECENT_LIMIT);
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
    grid-template-rows: auto auto minmax(0, 1fr);
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
  .cattea-history-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .cattea-history-sync {
    min-height: 30px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: transparent;
    color: var(--muted);
    padding: 0 11px;
    font-size: 0.76rem;
    cursor: pointer;
  }
  .cattea-history-sync:hover, .cattea-history-sync:focus-visible {
    color: var(--ice);
    outline: none;
  }
  .cattea-history-sync:disabled { cursor: wait; opacity: 0.58; }
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
  .cattea-history-error {
    margin: 10px 12px 0;
    border: 1px solid color-mix(in oklch, #ff6b6b, var(--line) 54%);
    border-radius: 12px;
    background: color-mix(in oklch, #ff6b6b, transparent 90%);
    color: #ff9b9b;
    padding: 8px 10px;
    font-size: 0.76rem;
    line-height: 1.4;
  }
  .cattea-history-error[hidden] { display: none; }
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
        <div class="cattea-history-actions">
          <button class="cattea-history-sync" id="catteaHistorySync" type="button">Sync</button>
          <button class="cattea-history-close" id="catteaHistoryClose" type="button" aria-label="Close history">×</button>
        </div>
      </div>
      <div class="cattea-history-error" id="catteaHistoryError" role="status" hidden></div>
      <div class="cattea-history-list" id="catteaHistoryList"></div>
      <audio id="catteaHistoryAudio" preload="metadata"></audio>
    </section>
  ` + "`" + `;
  document.body.appendChild(backdrop);

  const modal = backdrop.querySelector('.cattea-history-modal');
  const closeButton = document.getElementById('catteaHistoryClose');
  const syncButton = document.getElementById('catteaHistorySync');
  const list = document.getElementById('catteaHistoryList');
  const historyError = document.getElementById('catteaHistoryError');
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

  function setHistoryError(message) {
    historyError.textContent = message || '';
    historyError.hidden = !message;
  }

  async function playRecentVoice(id, button) {
    try {
      setHistoryError('');
      const audioEndpoint = '/events/recent/audio?id=' + encodeURIComponent(id)
        + '&history_version=${RECENT_API_VERSION}&_=' + Date.now();
      if (historyObjectUrl) URL.revokeObjectURL(historyObjectUrl);
      historyObjectUrl = '';
      historyAudio.pause();
      historyAudio.src = audioEndpoint;
      historyAudio.load();
      setActiveButton(button, true);
      await historyAudio.play();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHistoryError(message);
      if (typeof setMessage === 'function') setMessage(message, true);
      setActiveButton(button, false);
    }
  }

  function renderRecentVoices(events) {
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
  }

  async function loadRecentVoices() {
    setHistoryError('');
    list.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'cattea-history-empty';
    loading.textContent = 'Loading history…';
    list.appendChild(loading);

    try {
      const response = await fetch('/events/recent?history_version=${RECENT_API_VERSION}&_=' + Date.now(), { cache: 'no-store' });
      const data = await response.json();
      const events = Array.isArray(data.events) ? data.events : [];
      renderRecentVoices(events);
    } catch (_error) {
      list.replaceChildren();
      const failed = document.createElement('div');
      failed.className = 'cattea-history-empty';
      failed.textContent = 'History unavailable';
      list.appendChild(failed);
    }
  }

  async function syncRecentVoices() {
    const previousLabel = syncButton.textContent;
    syncButton.disabled = true;
    syncButton.textContent = 'Syncing…';
    setHistoryError('');
    try {
      const response = await fetch('/events/recent/sync?history_version=${RECENT_API_VERSION}&_=' + Date.now(), {
        method: 'POST',
        cache: 'no-store',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'History sync failed');
      const events = Array.isArray(data.events) ? data.events : [];
      renderRecentVoices(events);
      syncButton.textContent = 'Synced ' + events.length;
      setTimeout(() => { syncButton.textContent = previousLabel; }, 1800);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
      syncButton.textContent = 'Retry';
    } finally {
      syncButton.disabled = false;
    }
  }

  trigger.addEventListener('click', async (event) => {
    event.stopPropagation();
    backdrop.hidden = false;
    await loadRecentVoices();
    closeButton.focus();
  });

  closeButton.addEventListener('click', closeHistory);
  syncButton.addEventListener('click', syncRecentVoices);
  modal.addEventListener('click', (event) => event.stopPropagation());
  backdrop.addEventListener('click', closeHistory);
  historyAudio.addEventListener('ended', () => {
    if (activeButton) setActiveButton(activeButton, false);
  });
  historyAudio.addEventListener('error', () => {
    setHistoryError('This browser could not decode the recovered voice. Try the download button or reload the panel.');
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

async function handleRecentEvents(
  request: Request,
  origin: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id")?.trim();
  if (!id) {
    const [cached, historyResult] = await Promise.all([
      readRecentIndex(origin),
      fetchRecentElevenLabsVoices(env),
    ]);
    return Response.json({
      events: mergeRecentVoices(cached, historyResult.events),
      sync: {
        ok: historyResult.ok,
        history_count: historyResult.events.length,
        detail: historyResult.detail,
        colo: request.cf?.colo,
        version: RECENT_API_VERSION,
      },
    }, {
      headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    });
  }

  const response = await caches.default.match(
    cacheRequest(origin, RECENT_EVENT_PREFIX + encodeURIComponent(id)),
  );
  if (!response && id.startsWith("elevenlabs-")) {
    const historyItemId = id.slice("elevenlabs-".length);
    if (isValidHistoryItemId(historyItemId)) {
      return worker.fetch(
        new Request(new URL(`/history?id=${encodeURIComponent(historyItemId)}&align=0`, origin).toString()),
        env,
        ctx,
      );
    }
  }
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

async function handleRecentSync(request: Request, origin: string, env: Env): Promise<Response> {
  const historyResult = await fetchRecentElevenLabsVoices(env);
  const cached = await readRecentIndex(origin);
  const events = mergeRecentVoices(cached, historyResult.events);
  const colo = request.cf?.colo || "unknown";

  if (!historyResult.ok) {
    return Response.json({
      error: `Sync failed at Cloudflare ${colo}: ${historyResult.detail || "ElevenLabs history unavailable"}`,
      events,
      version: RECENT_API_VERSION,
    }, {
      status: 502,
      headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    });
  }

  await writeRecentIndex(origin, events);
  return Response.json({
    events,
    synced: historyResult.events.length,
    colo,
    version: RECENT_API_VERSION,
  }, {
    headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });
}

function createRecentAudioResponse(request: Request, audioBase64: string): Response {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "CDN-Cache-Control": "no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "Content-Type": "audio/mpeg",
    "X-CatTea-History-Version": RECENT_API_VERSION,
  });
  const range = request.headers.get("Range");
  if (!range) {
    headers.set("Content-Length", String(bytes.length));
    return new Response(bytes, { headers });
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    headers.set("Content-Range", `bytes */${bytes.length}`);
    return new Response(null, { status: 416, headers });
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : bytes.length - 1;
  const end = Math.min(requestedEnd, bytes.length - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) {
    headers.set("Content-Range", `bytes */${bytes.length}`);
    return new Response(null, { status: 416, headers });
  }

  const chunk = bytes.slice(start, end + 1);
  headers.set("Content-Length", String(chunk.length));
  headers.set("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
  return new Response(chunk, { status: 206, headers });
}

async function handleRecentAudio(
  request: Request,
  origin: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id")?.trim();
  if (!id) {
    return Response.json({ error: "Missing recent voice ID" }, { status: 400 });
  }

  const cached = await caches.default.match(
    cacheRequest(origin, RECENT_EVENT_PREFIX + encodeURIComponent(id)),
  );
  if (cached) {
    const event = await cached.json<VoiceEvent>();
    if (event.audio_base64) return createRecentAudioResponse(request, event.audio_base64);
  }

  if (id.startsWith("elevenlabs-")) {
    const historyItemId = id.slice("elevenlabs-".length);
    if (isValidHistoryItemId(historyItemId)) {
      const response = await worker.fetch(
        new Request(new URL(`/history?id=${encodeURIComponent(historyItemId)}&align=0`, origin).toString()),
        env,
        ctx,
      );
      if (response.ok) {
        const data = await response.json<{ event?: VoiceEvent }>();
        if (data.event?.audio_base64) return createRecentAudioResponse(request, data.event.audio_base64);
      }
    }
  }

  return Response.json({ error: "Recent voice could not be recovered" }, {
    status: 404,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "X-CatTea-History-Version": RECENT_API_VERSION,
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    env.BOT_NAME = env.BOT_NAME?.trim() || DEFAULT_BOT_NAME;

    const url = new URL(request.url);
    const path = url.pathname;
    const origin = url.origin;

    if (path === "/events/recent" && request.method === "GET") {
      return handleRecentEvents(request, origin, env, ctx);
    }
    if (path === "/events/recent/sync" && request.method === "POST") {
      return handleRecentSync(request, origin, env);
    }
    if (path === "/events/recent/audio" && request.method === "GET") {
      return handleRecentAudio(request, origin, env, ctx);
    }

    const mcpInfo = path === "/mcp" || path === "/mcp/" || path === "/sse"
      ? await readMcpRequestInfo(request)
      : {};

    let response = await worker.fetch(request, env, ctx);
    const contentType = response.headers.get("Content-Type") || "";

    if ((path === "/panel" || path === "/panel-v13" || path === "/panel-v14") && contentType.includes("text/html")) {
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
    } else if (path === "/events/announce" && request.method === "POST" && response.ok) {
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
