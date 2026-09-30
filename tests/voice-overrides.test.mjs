import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";

const TOKEN = "cattea-pwa-voice-test-token-32-characters-minimum";
const BUNDLE = resolve(process.env.VOICE_WORKER_BUNDLE || ".wrangler/voice-v4-test-bundle/cattea-glass.js");
const fakeAudio = Buffer.from("ID3mock-audio", "utf8").toString("base64");

function createWorker(authorized = true, token = TOKEN) {
  const outbound = [];
  const bindings = {
    TTS_PROVIDER: "elevenlabs",
    BOT_NAME: "CatTea",
    ELEVENLABS_MODEL_ID: "eleven_v3",
    ELEVENLABS_VOICE_ID: "voice-clone-test",
    ELEVENLABS_LANGUAGE_CODE_EN: "en",
    ELEVENLABS_STABILITY: "0.36",
    ELEVENLABS_STYLE: "0.82",
    ELEVENLABS_SPEED: "1.14",
    ELEVENLABS_API_KEY: "ElevenLabs-test-key-never-used",
    ...(authorized ? { CATTEA_PWA_VOICE_OVERRIDE_TOKEN: token } : {}),
  };
  const mf = new Miniflare({
    modules: true,
    scriptPath: BUNDLE,
    compatibilityDate: "2025-04-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings,
    durableObjects: { VOICE_HISTORY: { className: "VoiceHistoryStore", useSQLite: true } },
    outboundService: async (request) => {
      assert.equal(new URL(request.url).origin, "https://api.elevenlabs.io");
      if (new URL(request.url).pathname === '/v1/history') return Response.json({ history: [] });
      outbound.push({ url: request.url, body: JSON.parse(await request.text()) });
      return Response.json({
        audio_base64: fakeAudio,
        alignment: { characters: ["H", "i"], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] },
      }, { headers: { "history-item-id": "mock-history" } });
    },
  });
  const dispatch = mf.dispatchFetch.bind(mf);
  mf.dispatchFetch = (input, init) => input instanceof Request
    ? dispatch(input.url, { method: input.method, headers: input.headers })
    : dispatch(input, init);
  return { mf, outbound };
}
const speech = (query, header = "") => new Request("https://voice.local/speak?" + new URLSearchParams(query), {
  headers: header ? { "X-CatTea-Voice-Token": header } : {},
});

test("read-only status advertises overrides only when private secret exists", async () => {
  const a = createWorker(true), b = createWorker(false);
  try {
    const enabled = await (await a.mf.dispatchFetch("https://voice.local/status", { headers: { "X-CatTea-Voice-Token": TOKEN } })).json();
    const publicStatus = await (await a.mf.dispatchFetch("https://voice.local/status")).json();
    const disabled = await (await b.mf.dispatchFetch("https://voice.local/status", { headers: { "X-CatTea-Voice-Token": TOKEN } })).json();
    assert.equal(publicStatus.request_overrides.model_id, false);
    assert.equal(enabled.model_id, "eleven_v3");
    assert.equal(enabled.request_overrides.model_id, true);
    assert.equal(disabled.request_overrides.model_id, false);
    assert.equal(a.outbound.length + b.outbound.length, 0);
  } finally { await a.mf.dispose(); await b.mf.dispose(); }
});

test("short secrets never advertise or authorize model overrides", async () => {
  const shortSecret = "too-short";
  const { mf, outbound } = createWorker(true, shortSecret);
  try {
    const status = await (await mf.dispatchFetch("https://voice.local/status", { headers: { "X-CatTea-Voice-Token": shortSecret } })).json();
    assert.equal(status.request_overrides.model_id, false);
    const base = { text: "Hello Crown.", model_id: "eleven_v4", language_code: "en" };
    assert.equal((await mf.dispatchFetch(speech(base, shortSecret))).status, 403);
    assert.equal(outbound.length, 0);
  } finally { await mf.dispose(); }
});

test("unauthorized and malformed overrides never reach paid upstream", async () => {
  const { mf, outbound } = createWorker();
  try {
    const base = { text: "[whispers] Hello, Crown.", model_id: "eleven_v4", language_code: "en" };
    assert.equal((await mf.dispatchFetch(speech(base))).status, 403);
    assert.equal((await mf.dispatchFetch(speech(base, "invalid-token"))).status, 403);
    assert.equal((await mf.dispatchFetch(speech({ ...base, model_id: "not-a-model" }, TOKEN))).status, 400);
    assert.equal((await mf.dispatchFetch(speech({ ...base, stability: "0.5" }, TOKEN))).status, 400);
    assert.equal((await mf.dispatchFetch(speech({ ...base, stability: "-1", similarity_boost: "0.75" }, TOKEN))).status, 400);
    assert.equal(outbound.length, 0);
  } finally { await mf.dispose(); }
});

test("legacy unauthenticated v3 route keeps its tags and old synthesis path", async () => {
  const { mf, outbound } = createWorker();
  try {
    const res = await mf.dispatchFetch(speech({ text: "[whispers] Hello, Crown.", raw_tags: "true" }));
    assert.equal(res.status, 200);
    assert.equal(Buffer.compare(Buffer.from(await res.arrayBuffer()), Buffer.from("ID3mock-audio")), 0);
    assert.equal(outbound.length, 1);
    assert.match(outbound[0].url, /\/v1\/text-to-speech\/voice-clone-test\/with-timestamps/);
    assert.equal(outbound[0].body.model_id, "eleven_v3");
    assert.match(outbound[0].body.text, /^\[whispers\] Hello, Crown\./);
    assert.equal(outbound[0].body.voice_settings.style, 0.82);
    assert.equal(outbound[0].body.voice_settings.speed, 1.14);
  } finally { await mf.dispose(); }
});

test("authenticated v4 Chinese forwards tags, voice and only supported controls", async () => {
  const { mf, outbound } = createWorker();
  try {
    const res = await mf.dispatchFetch(speech({
      text: "[whispers] 主人，过来一点。",
      raw_tags: "true", model_id: "eleven_v4", language_code: "zh",
      stability: "0.41", similarity_boost: "0.88",
    }, TOKEN));
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(outbound.length, 1);
    assert.match(outbound[0].url, /\/v1\/text-to-dialogue\/with-timestamps/);
    assert.equal(outbound[0].body.model_id, "eleven_v4");
    assert.deepEqual(outbound[0].body.inputs, [{ text: "[whispers] 主人，过来一点。", voice_id: "voice-clone-test" }]);
    assert.equal(outbound[0].body.language_code, "zh");
    assert.deepEqual(outbound[0].body.settings, { stability: 0.41, similarity_boost: 0.88 });
    assert.ok(!("voice_settings" in outbound[0].body));
    assert.ok(!("style" in outbound[0].body.settings));
    assert.ok(!("speed" in outbound[0].body.settings));
  } finally { await mf.dispose(); }
});

test("authenticated POST v4 request uses dialogue endpoint without putting speech in the URL", async () => {
  const { mf, outbound } = createWorker();
  try {
    const res = await mf.dispatchFetch("https://voice.local/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CatTea-Voice-Token": TOKEN },
      body: JSON.stringify({ text: "主人，过来一点。", model_id: "eleven_v4", language_code: "zh" }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(outbound.length, 1);
    assert.match(outbound[0].url, /\/v1\/text-to-dialogue\/with-timestamps/);
    assert.deepEqual(outbound[0].body.inputs, [{ text: "主人，过来一点。", voice_id: "voice-clone-test" }]);
  } finally { await mf.dispose(); }
});

test("v4 auto omits forced language and v4 Turbo receives selected model", async () => {
  const { mf, outbound } = createWorker();
  try {
    const v4 = await mf.dispatchFetch(speech({ text: "Hello Crown.", model_id: "eleven_v4", language_code: "auto" }, TOKEN));
    assert.equal(v4.status, 200);
    assert.equal(outbound[0].body.model_id, "eleven_v4");
    assert.ok(!("language_code" in outbound[0].body));
    assert.ok(!("settings" in outbound[0].body));
    const turbo = await mf.dispatchFetch(speech({ text: "Hello Crown.", model_id: "eleven_v4_turbo", language_code: "en" }, TOKEN));
    assert.equal(turbo.status, 200);
    assert.equal(outbound[1].body.model_id, "eleven_v4_turbo");
    assert.match(outbound[1].url, /text-to-dialogue\/with-timestamps/);
  } finally { await mf.dispose(); }
});
