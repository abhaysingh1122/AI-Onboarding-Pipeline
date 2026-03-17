import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────
const TAVUS_API_KEY    = process.env.TAVUS_API_KEY;
const TAVUS_API        = "https://tavusapi.com/v2";
const N8N_WEBHOOK_URL  = process.env.N8N_WEBHOOK_URL || "";
const PERSONA_ID       = process.env.VITE_TAVUS_PERSONA_ID || "";
const REPLICA_ID       = process.env.VITE_TAVUS_REPLICA_ID || "";
const PUBLIC_URL       = process.env.RAILWAY_PUBLIC_DOMAIN
                           ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                           : process.env.PUBLIC_URL || "";

if (!TAVUS_API_KEY) {
  console.error("[Server] TAVUS_API_KEY is required — exiting");
  process.exit(1);
}

if (N8N_WEBHOOK_URL) {
  console.log("[Server] n8n webhook configured →", N8N_WEBHOOK_URL);
} else {
  console.warn("[Server] N8N_WEBHOOK_URL not set — callbacks will be skipped");
}

console.log("[Server] Persona ID:", PERSONA_ID || "(not set)");
console.log("[Server] Replica ID:", REPLICA_ID || "(not set)");

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));

// ─── Tavus callback receiver ──────────────────────────────────────────────────
// Tavus POSTs here when a conversation ends.
// We enrich the payload and forward to n8n.
app.post("/api/callback", async (req, res) => {
  try {
    console.log("[Callback] Received from Tavus:", JSON.stringify(req.body));

    if (!N8N_WEBHOOK_URL) {
      console.warn("[Callback] No N8N_WEBHOOK_URL set — skipping forward");
      return res.sendStatus(200);
    }

    const tavusData = req.body;

    // Build enriched payload for n8n
    const enriched = {
      // ── Identity ──
      conversation_id:   tavusData.conversation_id   || null,
      persona_id:        PERSONA_ID,
      replica_id:        REPLICA_ID,

      // ── Session info ──
      conversation_url:  tavusData.conversation_url  || null,
      status:            tavusData.status             || null,
      shutdown_reason:   tavusData.shutdown_reason    || null,
      created_at:        tavusData.created_at         || null,
      ended_at:          tavusData.ended_at           || null,

      // ── Transcript ──
      transcript:        tavusData.transcript         || [],

      // ── Raw Tavus payload (full) ──
      raw:               tavusData,
    };

    console.log("[Callback] Forwarding enriched payload to n8n →", N8N_WEBHOOK_URL);

    const n8nRes = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(enriched),
    });

    console.log("[Callback] n8n responded with status:", n8nRes.status);
    res.sendStatus(200);
  } catch (err) {
    console.error("[Callback] Error forwarding to n8n:", err.message);
    res.sendStatus(500);
  }
});

// ─── Create conversation ──────────────────────────────────────────────────────
app.post("/api/conversations", async (req, res) => {
  try {
    console.log("[Proxy] POST /conversations — forwarding to Tavus");

    const body = { ...req.body };

    // Inject callback_url — points to THIS server so we can enrich before n8n
    if (N8N_WEBHOOK_URL && PUBLIC_URL) {
      body.callback_url = `${PUBLIC_URL}/api/callback`;
      console.log("[Proxy] Injecting callback_url →", body.callback_url);
    } else {
      console.warn("[Proxy] Skipping callback_url — PUBLIC_URL or N8N_WEBHOOK_URL not set");
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
      console.error(`[Proxy] Tavus create returned ${response.status}:`, text);
    } else {
      console.log(`[Proxy] Tavus create OK — conversation_id: ${data.conversation_id}`);
    }

    res.status(response.status).json(data);
  } catch (err) {
    console.error("[Proxy] Error creating conversation:", err.message);
    res.status(502).json({ error: "Failed to reach Tavus API" });
  }
});

// ─── End conversation ─────────────────────────────────────────────────────────
app.post("/api/conversations/:id/end", async (req, res) => {
  try {
    console.log(`[Proxy] POST /conversations/${req.params.id}/end — forwarding to Tavus`);

    const response = await fetch(`${TAVUS_API}/conversations/${req.params.id}/end`, {
      method: "POST",
      headers: { "x-api-key": TAVUS_API_KEY },
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : { ok: true };
    console.log(`[Proxy] Tavus end returned ${response.status}:`, text || "(empty body)");
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
  console.log(`[Server] Running on port ${PORT}`);
});
