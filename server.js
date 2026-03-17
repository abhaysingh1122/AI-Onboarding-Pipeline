import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────
const TAVUS_API_KEY   = process.env.TAVUS_API_KEY;
const TAVUS_API       = "https://tavusapi.com/v2";
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "";
const PERSONA_ID      = process.env.VITE_TAVUS_PERSONA_ID || "";
const REPLICA_ID      = process.env.VITE_TAVUS_REPLICA_ID || "";

// conversation_id → { conversation_url, created_at }
const conversationCache = new Map();

if (!TAVUS_API_KEY) {
  console.error("[Server] FATAL: TAVUS_API_KEY is not set — exiting");
  process.exit(1);
}

console.log("[Server] TAVUS_API_KEY:", TAVUS_API_KEY ? "✓ set" : "✗ MISSING");
console.log("[Server] N8N_WEBHOOK_URL:", N8N_WEBHOOK_URL || "✗ NOT SET");
console.log("[Server] PERSONA_ID:", PERSONA_ID || "(not set)");
console.log("[Server] REPLICA_ID:", REPLICA_ID || "(not set)");

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    n8n_configured: !!N8N_WEBHOOK_URL,
    persona_id: PERSONA_ID,
    replica_id: REPLICA_ID,
  });
});

// ─── Tavus callback receiver ──────────────────────────────────────────────────
//
// Tavus sends callbacks with event_type:
//   • system.replica_joined        → session started
//   • system.shutdown              → room closed
//   • application.transcription_ready → transcript is ready (POST-conversation)
//   • application.recording_ready  → recording available
//   • application.perception_analysis → visual summary
//
// We ONLY forward to n8n on "application.transcription_ready"
// — it fires once, after the chat ends, and includes the full transcript.
//
app.post("/api/callback", async (req, res) => {
  try {
    const data      = req.body;
    const eventType = data.event_type || "";
    const convId    = data.conversation_id || "unknown";

    console.log(`[Callback] ${convId} → event_type="${eventType}"`);
    console.log(`[Callback] Full body:`, JSON.stringify(data));

    // ── Only fire n8n when the transcript is ready ──
    if (eventType !== "application.transcription_ready") {
      console.log(`[Callback] Ignoring "${eventType}" — waiting for transcription_ready`);
      return res.sendStatus(200);
    }

    if (!N8N_WEBHOOK_URL) {
      console.warn("[Callback] N8N_WEBHOOK_URL not set — skipping");
      return res.sendStatus(200);
    }

    const cached     = conversationCache.get(convId) || {};
    const props      = data.properties || {};
    const transcript = props.transcript || [];

    const payload = {
      conversation_id:  convId,
      persona_id:       PERSONA_ID,
      replica_id:       props.replica_id || REPLICA_ID,
      conversation_url: cached.conversation_url || null,
      status:           "ended",
      ended_at:         data.timestamp || new Date().toISOString(),
      created_at:       cached.created_at || null,
      transcript:       transcript,
    };

    console.log("[n8n] Firing webhook →", N8N_WEBHOOK_URL);
    console.log("[n8n] Payload:", JSON.stringify(payload, null, 2));

    const n8nRes = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log("[n8n] Response status:", n8nRes.status);

    // Cleanup cache
    conversationCache.delete(convId);

    res.sendStatus(200);
  } catch (err) {
    console.error("[Callback] Error:", err.message);
    res.sendStatus(500);
  }
});

// ─── Create conversation ──────────────────────────────────────────────────────
app.post("/api/conversations", async (req, res) => {
  try {
    console.log("[Proxy] POST /api/conversations — creating Tavus conversation");

    const body = { ...req.body };

    const proto   = req.headers["x-forwarded-proto"] || "https";
    const host    = req.headers["x-forwarded-host"]  || req.headers.host || "";
    const selfUrl = host ? `${proto}://${host}` : "";

    if (selfUrl) {
      body.callback_url = `${selfUrl}/api/callback`;
      console.log("[Proxy] Injecting callback_url →", body.callback_url);
    }

    const response = await fetch(`${TAVUS_API}/conversations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": TAVUS_API_KEY,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};

    if (!response.ok) {
      console.error(`[Proxy] Tavus create failed (${response.status}):`, text);
    } else {
      console.log(`[Proxy] Conversation created — id: ${data.conversation_id}, url: ${data.conversation_url}`);
      if (data.conversation_id) {
        conversationCache.set(data.conversation_id, {
          conversation_url: data.conversation_url || null,
          created_at: new Date().toISOString(),
        });
      }
    }

    res.status(response.status).json(data);
  } catch (err) {
    console.error("[Proxy] Error creating conversation:", err.message);
    res.status(502).json({ error: "Failed to reach Tavus API" });
  }
});

// ─── End conversation ─────────────────────────────────────────────────────────
app.post("/api/conversations/:id/end", async (req, res) => {
  const convId = req.params.id;
  console.log(`[Proxy] POST /api/conversations/${convId}/end`);

  try {
    const response = await fetch(`${TAVUS_API}/conversations/${convId}/end`, {
      method: "POST",
      headers: { "x-api-key": TAVUS_API_KEY },
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : { ok: true };
    console.log(`[Proxy] Tavus end returned ${response.status}`);

    res.status(response.status).json(data);
  } catch (err) {
    console.error("[Proxy] Error ending conversation:", err.message);
    res.status(502).json({ error: "Failed to reach Tavus API" });
  }
});

// ─── Static frontend ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "dist")));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});
