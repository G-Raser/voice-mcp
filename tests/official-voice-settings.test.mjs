import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BUNDLE = resolve(process.env.VOICE_WORKER_BUNDLE || ".wrangler/voice-v4-test-bundle/cattea-glass.js");
const fakeAudio = Buffer.from("ID3mock-audio", "utf8").toString("base64");

function createWorker() {
  const outbound = [];
  const mf = new Miniflare({
    modules: true,
    scriptPath: BUNDLE,
    compatibilityDate: "2025-04-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      TTS_PROVIDER: "elevenlabs",
      BOT_NAME: "CatTea",
      ELEVENLABS_MODEL_ID: "eleven_v3",
      ELEVENLABS_VOICE_ID: "voice-clone-test",
      ELEVENLABS_LANGUAGE_CODE_EN: "en",
      ELEVENLABS_API_KEY: "ElevenLabs-test-key-never-used",
    },
    durableObjects: { VOICE_HISTORY: { className: "VoiceHistoryStore", useSQLite: true } },
    outboundService: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.elevenlabs.io");
      if (url.pathname === "/v1/history") return Response.json({ history: [] });
      outbound.push({ url: request.url, body: JSON.parse(await request.text()) });
      return Response.json({
        audio_base64: fakeAudio,
        alignment: {
          characters: ["H", "i"],
          character_start_times_seconds: [0, 0.1],
          character_end_times_seconds: [0.1, 0.2],
        },
      }, { headers: { "history-item-id": "mock-history" } });
    },
  });
  return { mf, outbound };
}

async function savePreferences(mf, preferences) {
  return mf.dispatchFetch("https://voice.local/settings/voice", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://voice.local",
      "X-CatTea-Panel": "voice-settings-v1",
    },
    body: JSON.stringify(preferences),
  });
}

test("existing CatTea Voice panel exposes official-only model settings", async () => {
  const { mf } = createWorker();
  try {
    const panel = await mf.dispatchFetch("https://voice.local/panel");
    assert.equal(panel.status, 200);
    const html = await panel.text();
    assert.match(html, /catteaVoiceSettingsButton/);
    assert.match(html, /value="eleven_v3"/);
    assert.match(html, /value="eleven_v4"/);
    assert.match(html, /value="eleven_v4_turbo"/);
    assert.match(html, /Official ChatGPT voice only/);
  } finally {
    await mf.dispose();
  }
});

test("official preferences persist separately and sanitize v3 language", async () => {
  const { mf } = createWorker();
  try {
    const savedV4 = await savePreferences(mf, {
      model_id: "eleven_v4",
      language_code: "zh",
      settings_mode: "custom",
      stability: 0.41,
      similarity_boost: 0.88,
    });
    assert.equal(savedV4.status, 200, await savedV4.clone().text());
    const v4 = await savedV4.json();
    assert.equal(v4.preferences.model_id, "eleven_v4");
    assert.equal(v4.preferences.language_code, "zh");

    const savedV3 = await savePreferences(mf, {
      model_id: "eleven_v3",
      language_code: "zh",
      settings_mode: "default",
      stability: 0.2,
      similarity_boost: 0.3,
    });
    assert.equal(savedV3.status, 200, await savedV3.clone().text());
    const v3 = await savedV3.json();
    assert.equal(v3.preferences.model_id, "eleven_v3");
    assert.equal(v3.preferences.language_code, "en");

    const loaded = await (await mf.dispatchFetch("https://voice.local/settings/voice")).json();
    assert.equal(loaded.preferences.model_id, "eleven_v3");
    assert.equal(loaded.preferences.language_code, "en");
  } finally {
    await mf.dispose();
  }
});

test("official MCP speak reads panel preference while direct PWA route remains independent", async () => {
  const { mf, outbound } = createWorker();
  const saved = await savePreferences(mf, {
    model_id: "eleven_v4",
    language_code: "zh",
    settings_mode: "custom",
    stability: 0.41,
    similarity_boost: 0.88,
  });
  assert.equal(saved.status, 200, await saved.clone().text());

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).origin !== "https://voice.local") return realFetch(input, init);
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : Buffer.from(await request.arrayBuffer());
    return mf.dispatchFetch(request.url, { method: request.method, headers: request.headers, body });
  };

  const client = new Client({ name: "official-settings-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://voice.local/mcp"));
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "speak",
      arguments: { text: "[whispers] 主人，过来一点。", raw_tags: true },
    });
    assert.equal(result.structuredContent?.model_id, "eleven_v4");
    assert.equal(outbound.length, 1);
    assert.match(outbound[0].url, /\/v1\/text-to-dialogue\/with-timestamps/);
    assert.equal(outbound[0].body.model_id, "eleven_v4");
    assert.equal(outbound[0].body.language_code, "zh");
    assert.deepEqual(outbound[0].body.settings, { stability: 0.41, similarity_boost: 0.88 });

    const direct = await mf.dispatchFetch("https://voice.local/speak?text=Hello%20Crown.");
    assert.equal(direct.status, 200, await direct.clone().text());
    assert.equal(outbound.length, 2);
    assert.equal(outbound[1].body.model_id, "eleven_v3");
    assert.match(outbound[1].url, /\/v1\/text-to-speech\/voice-clone-test\/with-timestamps/);
  } finally {
    try { await client.close(); } catch {}
    try { await transport.close(); } catch {}
    globalThis.fetch = realFetch;
    await mf.dispose();
  }
});