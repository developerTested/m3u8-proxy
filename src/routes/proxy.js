const { Router } = require("express");
const { fetchUpstream } = require("../utils/fetcher");
const { rewriteM3U8 } = require("../services/rewriter");

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// CORS: handle preflight OPTIONS for all proxy routes
// ─────────────────────────────────────────────────────────────────────────────
router.options("*", (_req, res) => {
    setCorsHeaders(res);
    res.sendStatus(204);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build the proxy base URL, respecting X-Forwarded-* headers.
// ─────────────────────────────────────────────────────────────────────────────
function proxyBase(req) {
    const proto = req.get("x-forwarded-proto") || req.protocol;
    const host = req.get("x-forwarded-host") || req.get("host");
    return `${proto}://${host}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validate & decode the `url` query-param present on every endpoint.
// ─────────────────────────────────────────────────────────────────────────────
function extractUrl(req, res) {
    const raw = req.query.url;
    if (!raw) {
        res.status(400).json({ error: "`url` query parameter is required." });
        return null;
    }
    try {
        const decoded = decodeURIComponent(raw);
        new URL(decoded); // validate
        return decoded;
    } catch {
        res.status(400).json({ error: "Invalid URL provided." });
        return null;
    }
}

/**
 * Extract the optional `referer` query param.
 * Returns the decoded string or null.
 */
function extractReferer(req) {
    const raw = req.query.referer;
    if (!raw) return null;
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Set comprehensive CORS headers that HLS.js / vidstack need.
// ─────────────────────────────────────────────────────────────────────────────
function setCorsHeaders(res) {
    res.set({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers":
            "Origin, X-Requested-With, Content-Type, Accept, Range",
        "Access-Control-Expose-Headers":
            "Content-Length, Content-Range, Content-Type, Accept-Ranges, ETag, Last-Modified",
        "Access-Control-Max-Age": "86400",
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1.  /proxy/m3u8?url=<encoded>&referer=<encoded>
//     Fetch an M3U8 playlist, rewrite it, and return it.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/m3u8", async (req, res, next) => {
    try {
        const url = extractUrl(req, res);
        if (!url) return;
        const referer = extractReferer(req);

        const upstream = await fetchUpstream(url, req.headers, referer);

        if (upstream.status >= 400) {
            setCorsHeaders(res);
            return res
                .status(upstream.status)
                .json({ error: `Upstream returned ${upstream.status}` });
        }

        const bodyText = upstream.data.toString("utf-8");
        const rewritten = rewriteM3U8(bodyText, url, proxyBase(req), referer);

        // Detect if this is a media playlist (not a master/multivariant playlist).
        // Media playlists have #EXTINF but no #EXT-X-STREAM-INF.
        // If it's a media playlist and the client hasn't requested _direct mode,
        // wrap it in a synthetic master playlist with safe CODECS so that
        // HLS.js doesn't probe mp4a.40.1 (AAC Main) from ADTS headers,
        // which Chrome's MediaSource API doesn't support.
        const isMaster =
            /^#EXT-X-STREAM-INF:/m.test(bodyText) ||
            /^#EXT-X-MEDIA:/m.test(bodyText);
        const isDirect = req.query._direct === "1";

        if (!isMaster && !isDirect) {
            // Return a synthetic master playlist that wraps this media playlist.
            const refSuffix = referer
                ? `&referer=${encodeURIComponent(referer)}`
                : "";
            const mediaUrl = `${proxyBase(req)}/proxy/m3u8?url=${encodeURIComponent(url)}${refSuffix}&_direct=1`;
            const masterPlaylist = [
                "#EXTM3U",
                '#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.640028,mp4a.40.2"',
                mediaUrl,
                "",
            ].join("\n");

            setCorsHeaders(res);
            res.set({
                "Content-Type":
                    "application/vnd.apple.mpegurl; charset=utf-8",
                "Cache-Control": "no-cache",
            });
            return res.send(masterPlaylist);
        }

        setCorsHeaders(res);
        res.set({
            "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
            "Cache-Control": "no-cache",
        });
        res.send(rewritten);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.  /proxy/segment?url=<encoded>&referer=<encoded>
//     Transparently pipe a TS / fMP4 / CMAF / AAC / MP4 segment.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/segment", async (req, res, next) => {
    try {
        const url = extractUrl(req, res);
        if (!url) return;
        const referer = extractReferer(req);

        const upstream = await fetchUpstream(url, req.headers, referer);

        if (upstream.status >= 400) {
            setCorsHeaders(res);
            return res
                .status(upstream.status)
                .json({ error: `Upstream returned ${upstream.status}` });
        }

        // Determine the correct content-type for this segment.
        // Some upstreams disguise TS/fMP4 segments with fake extensions
        // (e.g. .jpg, .png, .gif) and return image/* content-types.
        // HLS.js / players will reject these, so we override to the
        // correct MPEG transport stream type.
        const upstreamCt = (upstream.headers["content-type"] || "").toLowerCase();
        const contentType = guessSegmentContentType(url, upstreamCt);

        forwardHeaders(res, upstream, [
            "content-range",
            "accept-ranges",
            "etag",
            "last-modified",
            "cache-control",
        ]);
        setCorsHeaders(res);
        // Always set content-length from the actual buffer, not upstream
        // (upstream value may be wrong after decompression).
        res.set("Content-Type", contentType);
        res.set("Content-Length", upstream.data.length);
        res.status(upstream.status).send(upstream.data);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3.  /proxy/key?url=<encoded>&referer=<encoded>
//     Proxy AES-128 / SAMPLE-AES decryption keys.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/key", async (req, res, next) => {
    try {
        const url = extractUrl(req, res);
        if (!url) return;
        const referer = extractReferer(req);

        const upstream = await fetchUpstream(url, req.headers, referer);

        if (upstream.status >= 400) {
            setCorsHeaders(res);
            return res
                .status(upstream.status)
                .json({ error: `Upstream returned ${upstream.status}` });
        }

        setCorsHeaders(res);
        res.set({
            "Content-Type":
                upstream.headers["content-type"] || "application/octet-stream",
            "Cache-Control": "no-store",
        });
        res.send(upstream.data);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4.  /proxy/subtitle?url=<encoded>&referer=<encoded>
//     Proxy WebVTT / SRT subtitle files.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/subtitle", async (req, res, next) => {
    try {
        const url = extractUrl(req, res);
        if (!url) return;
        const referer = extractReferer(req);

        const upstream = await fetchUpstream(url, req.headers, referer);

        if (upstream.status >= 400) {
            setCorsHeaders(res);
            return res
                .status(upstream.status)
                .json({ error: `Upstream returned ${upstream.status}` });
        }

        // If the subtitle is itself an m3u8, rewrite it
        const ct = (upstream.headers["content-type"] || "").toLowerCase();
        if (ct.includes("mpegurl") || url.endsWith(".m3u8")) {
            const bodyText = upstream.data.toString("utf-8");
            const rewritten = rewriteM3U8(bodyText, url, proxyBase(req), referer);
            setCorsHeaders(res);
            res.set({
                "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
            });
            return res.send(rewritten);
        }

        setCorsHeaders(res);
        res.set({
            "Content-Type": ct || "text/vtt; charset=utf-8",
        });
        res.send(upstream.data);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5.  /proxy/audio?url=<encoded>&referer=<encoded>
//     Proxy audio-only renditions (AAC, MP3, Opus, etc.)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/audio", async (req, res, next) => {
    try {
        const url = extractUrl(req, res);
        if (!url) return;
        const referer = extractReferer(req);

        const upstream = await fetchUpstream(url, req.headers, referer);

        if (upstream.status >= 400) {
            setCorsHeaders(res);
            return res
                .status(upstream.status)
                .json({ error: `Upstream returned ${upstream.status}` });
        }

        // If it's an m3u8 for audio rendition, rewrite
        const ct = (upstream.headers["content-type"] || "").toLowerCase();
        if (ct.includes("mpegurl") || /\.m3u8?(\?|$)/i.test(url)) {
            const bodyText = upstream.data.toString("utf-8");
            const rewritten = rewriteM3U8(bodyText, url, proxyBase(req), referer);
            setCorsHeaders(res);
            res.set({
                "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
            });
            return res.send(rewritten);
        }

        forwardHeaders(res, upstream, [
            "content-type",
            "content-length",
            "content-range",
            "accept-ranges",
        ]);
        setCorsHeaders(res);
        res.status(upstream.status).send(upstream.data);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6.  /proxy/image?url=<encoded>&referer=<encoded>
//     Proxy thumbnail / trick-play images.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/image", async (req, res, next) => {
    try {
        const url = extractUrl(req, res);
        if (!url) return;
        const referer = extractReferer(req);

        const upstream = await fetchUpstream(url, req.headers, referer);

        if (upstream.status >= 400) {
            setCorsHeaders(res);
            return res
                .status(upstream.status)
                .json({ error: `Upstream returned ${upstream.status}` });
        }

        forwardHeaders(res, upstream, [
            "content-type",
            "content-length",
            "cache-control",
            "etag",
        ]);
        setCorsHeaders(res);
        res.status(upstream.status).send(upstream.data);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7.  /proxy/raw?url=<encoded>&referer=<encoded>
//     Generic catch-all: proxies anything without rewriting.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/raw", async (req, res, next) => {
    try {
        const url = extractUrl(req, res);
        if (!url) return;
        const referer = extractReferer(req);

        const upstream = await fetchUpstream(url, req.headers, referer);

        if (upstream.status >= 400) {
            setCorsHeaders(res);
            return res
                .status(upstream.status)
                .json({ error: `Upstream returned ${upstream.status}` });
        }

        forwardHeaders(res, upstream, [
            "content-type",
            "content-length",
            "content-range",
            "accept-ranges",
            "cache-control",
            "etag",
            "last-modified",
        ]);
        setCorsHeaders(res);
        res.status(upstream.status).send(upstream.data);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Utility: selectively forward upstream headers to the client response.
// ─────────────────────────────────────────────────────────────────────────────
function forwardHeaders(res, upstream, keys) {
    for (const key of keys) {
        if (upstream.headers[key]) {
            res.set(key, upstream.headers[key]);
        }
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Utility: determine the correct content-type for a segment.
// Some CDNs disguise segments with fake extensions (.jpg, .png, etc.) to
// evade detection.  If the upstream content-type looks wrong for a media
// segment, we override it.
// ─────────────────────────────────────────────────────────────────────────────
function guessSegmentContentType(url, upstreamCt) {
    // Already a known media segment type — trust it.
    const validSegmentTypes = [
        "video/mp2t",           // .ts
        "video/mp4",            // .mp4 / fMP4
        "audio/aac",            // .aac
        "audio/mpeg",           // .mp3
        "audio/mp4",            // audio fMP4
        "application/octet-stream",
    ];
    for (const t of validSegmentTypes) {
        if (upstreamCt.includes(t)) return upstreamCt;
    }

    // If upstream says it's an image, text, or HTML — it's definitely wrong
    // for a media segment.  Override based on URL extension or default to MP2T.
    const ext = url.split("?")[0].split(".").pop().toLowerCase();
    const extMap = {
        ts: "video/MP2T",
        mp4: "video/mp4",
        m4s: "video/mp4",
        m4v: "video/mp4",
        m4a: "audio/mp4",
        aac: "audio/aac",
        mp3: "audio/mpeg",
    };
    if (extMap[ext]) return extMap[ext];

    // Default: assume MPEG transport stream (most common HLS segment type)
    return "video/MP2T";
}

module.exports = router;
