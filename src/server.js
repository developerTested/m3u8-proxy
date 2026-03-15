require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const proxyRoutes = require("./routes/proxy");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS || "*";
app.use(
  cors(
    allowedOrigins === "*"
      ? {}
      : {
        origin: allowedOrigins.split(",").map((o) => o.trim()),
        methods: ["GET", "HEAD", "OPTIONS"],
      }
  )
);

// ─── Rate Limiting ───────────────────────────────────────────────────────────
app.use(
  rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, slow down." },
  })
);

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use("/proxy", proxyRoutes);

// Serve test page
const path = require("path");
app.use("/test", express.static(path.join(__dirname, "test.html")));

// Health-check
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "m3u8-proxy",
    endpoints: {
      m3u8: "/proxy/m3u8?url=<encoded_m3u8_url>",
      segment: "/proxy/segment?url=<encoded_segment_url>",
      key: "/proxy/key?url=<encoded_key_url>",
      subtitle: "/proxy/subtitle?url=<encoded_subtitle_url>",
      audio: "/proxy/audio?url=<encoded_audio_url>",
      image: "/proxy/image?url=<encoded_image_url>",
      generic: "/proxy/raw?url=<encoded_url>",
    },
  });
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err.message);
  res.set("Access-Control-Allow-Origin", "*");
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`✅  m3u8-proxy running on http://localhost:${PORT}`);
});
