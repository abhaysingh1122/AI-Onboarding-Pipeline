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

// ─── In-memory state ─────────────────────────────────────────────────────────
const conversationCache = new Map();  // id → { conversation_url, created_at }
const endedSet          = new Set();  // conversations where /end was called
const firedSet          = new Set();  // conversations already sent to n8n (dedup)

if (!TAVUS_API_KEY) {
  console.error("[Server] FATAL: TAVUS_API_KEY is not set — exiting");
  process.exit(1);
}

console.log("[Server] TAVUS_API_KEY:", TAVUS_API_KEY ? "✓ set" : "✗ MISSING");
console.log("[Server] N8N_WEBHOOK_URL:", N8N_WEBHOOK_URL || "✗ NOT SET");
console.log("[Server] PERSONA_ID:", PERSONA_ID || "(not set)");
console.log("[Server] REPLICA_ID:", REPLICA_ID || "(not set)");

// ─── Helper: fire n8n exactly once per conversation ──────────────────────────
async function fireN8nOnce(conversationId, payload) {
  if (!N8N_WEBHOOK_URL) {
    console.warn("[n8n] N8N_WEBHOOK_URL not set — skipping");
    return;
  }
  if (firedSet.has(conversationId)) {
    console.log(`[n8n] Already fired for ${conversationId} — skipping duplicate`);
    return;
  }

  firedSet.add(conversationId);

  try {
    console.log("[n8n] Firing webhook →", N8N_WEBHOOK_URL);
    console.log("[n8n] Payload:", JSON.stringify(payload, null, 2));
    const res = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log("[n8n] Response status:", res.status);
  } catch (err) {
    console.error("[n8n] Failed:", err.message);
    firedSet.delete(conversationId);
  }

  // Cleanup after 10 min to prevent memory leak
  setTimeout(() => {
    firedSet.delete(conversationId);
    endedSet.delete(conversationId);
    conversationCache.delete(conversationId);
  }, 10 * 60 * 1000);
}

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
// Tavus calls this on every event (join, end, disconnect).
// Tavus sends empty "status" field, so we can't rely on it.
// Instead: only fire n8n if /end was already called for this conversation.
app.post("/api/callback", async (req, res) => {
  try {
    const tavusData = req.body;
    const convId    = tavusData.conversation_id || "unknown";

    console.log(`[Callback] Event for ${convId} — full body:`, JSON.stringify(tavusData));

    // Only fire if the session was explicitly ended via /end
    if (!endedSet.has(convId)) {
      console.log(`[Callback] ${convId} not in endedSet — ignoring (session still active)`);
      return res.sendStatus(200);
    }

    const cached = conversationCache.get(convId) || {};

    await fireN8nOnce(convId, {
      conversation_id:  convId,
      persona_id:       PERSONA_ID,
      replica_id:       REPLICA_ID,
      conversation_url: tavusData.conversation_url || cached.conversation_url || null,
      status:           "ended",
      created_at:       tavusData.created_at       || cached.created_at       || null,
      ended_at:         tavusData.ended_at         || new Date().toISOString(),
      transcript:       tavusData.transcript       || [],
    });

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
// Marks the conversation as ended, then proxies to Tavus.
// The next Tavus callback for this conversation will trigger n8n.
app.post("/api/conversations/:id/end", async (req, res) => {
  const convId = req.params.id;
  console.log(`[Proxy] POST /api/conversations/${convId}/end`);

  // Mark as ended BEFORE calling Tavus — so when Tavus sends the
  // callback, our /api/callback handler knows to fire n8n
  endedSet.add(convId);
  console.log(`[Proxy] Marked ${convId} as ended`);

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
