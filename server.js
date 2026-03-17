import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Tavus API key — server-side only, never exposed to the browser
const TAVUS_API_KEY = process.env.TAVUS_API_KEY;
const TAVUS_API = "https://tavusapi.com/v2";

if (!TAVUS_API_KEY) {
  console.error("TAVUS_API_KEY is required");
  process.exit(1);
}

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Create conversation — forwards request body to Tavus API
app.post("/api/conversations", async (req, res) => {
  try {
    console.log("[Proxy] POST /conversations — forwarding to Tavus");
    const response = await fetch(`${TAVUS_API}/conversations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": TAVUS_API_KEY,
      },
      body: JSON.stringify(req.body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      console.error(`[Proxy] Tavus create returned ${response.status}:`, text);
    } else {
      console.log(`[Proxy] Tavus create returned ${response.status}, conversation_id:`, data.conversation_id);
    }
    res.status(response.status).json(data);
  } catch (err) {
    console.error("Proxy error (create):", err.message);
    res.status(502).json({ error: "Failed to reach Tavus API" });
  }
});

// End conversation — forwards to Tavus API
app.post("/api/conversations/:id/end", async (req, res) => {
  try {
    console.log(`[Proxy] POST /conversations/${req.params.id}/end — forwarding to Tavus`);
    const response = await fetch(
      `${TAVUS_API}/conversations/${req.params.id}/end`,
      {
        method: "POST",
        headers: { "x-api-key": TAVUS_API_KEY },
      }
    );
    // Tavus may return empty body on end — handle gracefully
    const text = await response.text();
    const data = text ? JSON.parse(text) : { ok: true };
    console.log(`[Proxy] Tavus end returned ${response.status}:`, text || "(empty body)");
    res.status(response.status).json(data);
  } catch (err) {
    console.error("Proxy error (end):", err.message);
    res.status(502).json({ error: "Failed to reach Tavus API" });
  }
});

// Static files — serve the Vite build output
app.use(express.static(path.join(__dirname, "dist")));

// SPA catch-all — any non-API route serves index.html
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
