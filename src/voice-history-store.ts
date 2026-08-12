import type { Env } from "./index";

const INDEX_KEY = "recent-index-v1";
const RECENT_LIMIT = 12;
const AUDIO_CHUNK_SIZE = 96_000;
const FETCH_TIMEOUT_MS = 15_000;

export type GlobalVoiceEvent = {
  id: string;
  text: string;
  audio_base64: string;
  created_at: string;
  provider?: string;
  model_id?: string;
  history_item_id?: string;
  caption_cues?: Array<{ text: string; start: number; end: number }>;
};

export type GlobalVoiceMeta = Omit<GlobalVoiceEvent, "audio_base64" | "caption_cues">;

type StoredVoiceEvent = Omit<GlobalVoiceEvent, "audio_base64"> & {
  audio_chunks: number;
};

type ElevenLabsHistoryItem = {
  history_item_id?: string;
  date_unix?: number;
  voice_id?: string | null;
  model_id?: string | null;
  text?: string | null;
};

function isValidHistoryItemId(value: string): boolean {
  return /^[A-Za-z0-9_-]{6,128}$/.test(value);
}

function isVoiceEvent(value: unknown): value is GlobalVoiceEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<GlobalVoiceEvent>;
  return typeof event.id === "string"
    && typeof event.text === "string"
    && typeof event.audio_base64 === "string"
    && event.audio_base64.length > 0
    && typeof event.created_at === "string";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
  }
  return btoa(binary);
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

export class VoiceHistoryStore {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  private async readIndex(): Promise<GlobalVoiceMeta[]> {
    const value = await this.state.storage.get<GlobalVoiceMeta[]>(INDEX_KEY);
    return Array.isArray(value) ? value : [];
  }

  private async writeIndex(events: GlobalVoiceMeta[]): Promise<void> {
    await this.state.storage.put(INDEX_KEY, events.slice(0, RECENT_LIMIT));
  }

  private async putEvent(event: GlobalVoiceEvent): Promise<void> {
    const chunks: string[] = [];
    for (let offset = 0; offset < event.audio_base64.length; offset += AUDIO_CHUNK_SIZE) {
      chunks.push(event.audio_base64.slice(offset, offset + AUDIO_CHUNK_SIZE));
    }

    const stored: StoredVoiceEvent = {
      id: event.id,
      text: event.text,
      created_at: event.created_at,
      provider: event.provider,
      model_id: event.model_id,
      history_item_id: event.history_item_id,
      caption_cues: event.caption_cues,
      audio_chunks: chunks.length,
    };
    const entries: Record<string, unknown> = { [`event:${event.id}`]: stored };
    chunks.forEach((chunk, index) => {
      entries[`audio:${event.id}:${index}`] = chunk;
    });
    await this.state.storage.put(entries);

    const current = await this.readIndex();
    const meta: GlobalVoiceMeta = {
      id: event.id,
      text: event.text,
      created_at: event.created_at,
      provider: event.provider,
      model_id: event.model_id,
      history_item_id: event.history_item_id,
    };
    await this.writeIndex([meta, ...current.filter((item) => item.id !== event.id)]);
  }

  private async getEvent(id: string): Promise<GlobalVoiceEvent | null> {
    const stored = await this.state.storage.get<StoredVoiceEvent>(`event:${id}`);
    if (!stored || !stored.audio_chunks) return null;
    const keys = Array.from({ length: stored.audio_chunks }, (_, index) => `audio:${id}:${index}`);
    const values = await this.state.storage.get<string>(keys);
    const chunks = keys.map((key) => values.get(key));
    if (chunks.some((chunk) => typeof chunk !== "string")) return null;
    const { audio_chunks: _audioChunks, ...event } = stored;
    return { ...event, audio_base64: chunks.join("") };
  }

  private configuredVoiceIds(): Set<string> {
    return new Set([
      this.env.ELEVENLABS_VOICE_ID,
      this.env.ELEVENLABS_VOICE_ID_ZH,
      this.env.ELEVENLABS_VOICE_ID_EN,
    ].filter((voiceId): voiceId is string => Boolean(voiceId)));
  }

  private async syncHistory(): Promise<GlobalVoiceMeta[]> {
    if (!this.env.ELEVENLABS_API_KEY) throw new Error("ElevenLabs API key is unavailable");
    const historyUrl = new URL("https://api.elevenlabs.io/v1/history");
    historyUrl.searchParams.set("page_size", "20");
    const response = await fetchWithTimeout(historyUrl, {
      headers: {
        "xi-api-key": this.env.ELEVENLABS_API_KEY,
        "Accept": "application/json",
      },
    });
    if (!response.ok) throw new Error(`ElevenLabs history returned ${response.status}`);

    const data = await response.json() as { history?: ElevenLabsHistoryItem[] };
    const configuredVoiceIds = this.configuredVoiceIds();
    const history = Array.isArray(data.history) ? data.history : [];
    const matching = configuredVoiceIds.size
      ? history.filter((item) => typeof item.voice_id === "string" && configuredVoiceIds.has(item.voice_id))
      : history;
    const events: GlobalVoiceMeta[] = matching
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

    const current = await this.readIndex();
    const merged = new Map<string, GlobalVoiceMeta>();
    for (const item of [...current, ...events]) {
      const key = item.history_item_id || item.id;
      const existing = merged.get(key);
      if (!existing || Date.parse(item.created_at) > Date.parse(existing.created_at)) merged.set(key, item);
    }
    const recent = [...merged.values()]
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
      .slice(0, RECENT_LIMIT);
    await this.writeIndex(recent);
    return recent;
  }

  private async recoverHistory(historyItemId: string): Promise<GlobalVoiceEvent> {
    if (!isValidHistoryItemId(historyItemId)) throw new Error("Invalid ElevenLabs history item ID");
    const id = `elevenlabs-${historyItemId}`;
    const cached = await this.getEvent(id);
    if (cached) return cached;
    if (!this.env.ELEVENLABS_API_KEY) throw new Error("ElevenLabs API key is unavailable");

    const historyUrl = `https://api.elevenlabs.io/v1/history/${encodeURIComponent(historyItemId)}`;
    const headers = { "xi-api-key": this.env.ELEVENLABS_API_KEY };
    const [metadataResponse, audioResponse] = await Promise.all([
      fetchWithTimeout(historyUrl, { headers: { ...headers, "Accept": "application/json" } }),
      fetchWithTimeout(`${historyUrl}/audio`, { headers }),
    ]);
    if (!metadataResponse.ok) throw new Error(`ElevenLabs history returned ${metadataResponse.status}`);
    if (!audioResponse.ok) throw new Error(`ElevenLabs audio returned ${audioResponse.status}`);

    const metadata = await metadataResponse.json() as ElevenLabsHistoryItem;
    const event: GlobalVoiceEvent = {
      id,
      text: metadata.text?.trim() || `ElevenLabs history ${historyItemId}`,
      audio_base64: arrayBufferToBase64(await audioResponse.arrayBuffer()),
      created_at: typeof metadata.date_unix === "number" && Number.isFinite(metadata.date_unix)
        ? new Date(metadata.date_unix * 1000).toISOString()
        : new Date().toISOString(),
      provider: "elevenlabs",
      model_id: metadata.model_id || "eleven_v3",
      history_item_id: metadata.history_item_id || historyItemId,
    };
    await this.putEvent(event);
    return event;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/events" && request.method === "GET") {
        return Response.json({ events: await this.readIndex() });
      }
      if (url.pathname === "/event" && request.method === "PUT") {
        const event = await request.json<unknown>();
        if (!isVoiceEvent(event)) return Response.json({ error: "Invalid voice event" }, { status: 400 });
        await this.putEvent(event);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/event" && request.method === "GET") {
        const id = url.searchParams.get("id")?.trim() || "";
        const event = id ? await this.getEvent(id) : null;
        return event ? Response.json({ event }) : Response.json({ error: "Voice event not found" }, { status: 404 });
      }
      if (url.pathname === "/recover" && request.method === "GET") {
        const historyItemId = url.searchParams.get("id")?.trim() || "";
        return Response.json({ event: await this.recoverHistory(historyItemId) });
      }
      if (url.pathname === "/sync" && request.method === "POST") {
        const events = await this.syncHistory();
        return Response.json({ events, synced: events.length });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : String(error),
      }, { status: 502 });
    }
  }
}
