require("dotenv").config();
const axios = require("axios");
const ApiError = require("./ApiError")

/**
 * Handles API errors consistently.
 * @param {import("express").Response} res - Express response object
 * @param {Error|unknown} error - The error thrown
 * @param {string} message - Custom error message
 * @returns {Express.Response}
 */
function handleApiError(res, error, message) {

    console.error(message + ":", error instanceof Error ? error.message : error);

    const apiError = new ApiError(500, message);
    return res.status(500).json(apiError);
}

const ROOT_URL = process.env.ROOT_URL || `http://localhost:${process.env.PORT || 3001}`

/**
 * Shared Axios instance used for all upstream fetches.
 * - Follows redirects automatically.
 * - Returns raw ArrayBuffer so binary streams are preserved.
 * - Decompresses responses automatically (decompress: true with no accept-encoding override).
 */
const fetcher = axios.create({
    timeout: parseInt(process.env.REQUEST_TIMEOUT, 10) || 15_000,
    maxRedirects: 10,
    responseType: "arraybuffer",
    decompress: true, // let axios handle gzip/br/deflate decompression
    headers: {
        "User-Agent":
            process.env.USER_AGENT ||
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "*/*",
    },
    // Don't throw on non-2xx so we can handle it ourselves
    validateStatus: () => true,
});

/**
 * Fetch a URL and return { status, headers, data (Buffer) }.
 * Passes through common request headers from the client.
 *
 * @param {string}  url            – upstream URL to fetch
 * @param {object}  clientHeaders  – incoming request headers to forward
 * @param {string} [customReferer] – optional custom Referer/Origin to send
 */
async function fetchUpstream(url, clientHeaders = {}, customReferer = null) {
    // Forward useful headers from the original client request
    const forwardHeaders = {};
    const passthroughKeys = [
        "range",
        "if-none-match",
        "if-modified-since",
        // NOTE: Do NOT forward accept-encoding; let axios handle it so
        // it can decompress the response for us. If we forward the client's
        // accept-encoding, upstream may compress the response, but axios
        // won't decompress it when responseType is 'arraybuffer', leading
        // to corrupt data being sent back to the player.
    ];
    for (const key of passthroughKeys) {
        if (clientHeaders[key]) forwardHeaders[key] = clientHeaders[key];
    }

    // Use custom referer if provided, otherwise fall back to the target domain
    if (customReferer) {
        forwardHeaders["Referer"] = customReferer;
        try {
            const parsed = new URL(customReferer);
            forwardHeaders["Origin"] = `${parsed.protocol}//${parsed.host}`;
        } catch {
            forwardHeaders["Origin"] = customReferer;
        }
    } else {
        const parsedUrl = new URL(url);
        forwardHeaders["Referer"] = `${parsedUrl.protocol}//${parsedUrl.host}/`;
        forwardHeaders["Origin"] = `${parsedUrl.protocol}//${parsedUrl.host}`;
    }

    const response = await fetcher.get(url, { headers: forwardHeaders });

    return {
        status: response.status,
        headers: response.headers,
        data: Buffer.from(response.data),
    };
}

// ==================== CONFIGURATION ====================
const CONFIG = {
    USER_AGENT: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT, 10) || 15000,
    MAX_REDIRECTS: 10,
    KEY_PATTERNS: ['.key', 'key.bin', 'enc.key', '.keyfile'],
    DISGUISED_PATTERNS: ['.jpg', '.jpeg', '.png', '.gif', '.img', '.picture']
};


// ─────────────────────────────────────────────────────────────────────────────
// Utility: determine the correct content-type for a segment.
// Some CDNs disguise segments with fake extensions (.jpg, .png, etc.) to
// evade detection.  If the upstream content-type looks wrong for a media
// segment, we override it.
// ─────────────────────────────────────────────────────────────────────────────
function guessSegmentContentType(url, upstreamCt, segmentData) {
    // Log what we're detecting
    console.log('Detecting content-type for:', {
        url,
        upstreamCt,
        dataLength: segmentData?.length
    });

    // Valid media types
    const validSegmentTypes = [
        "video/mp2t",
        "video/mp4",
        "audio/aac",
        "audio/mpeg",
        "audio/mp4",
        "application/octet-stream",
        "video/quicktime",
        "video/3gpp"
    ];

    // If upstream content-type is valid, trust it
    if (upstreamCt) {
        for (const t of validSegmentTypes) {
            if (upstreamCt.includes(t)) {
                console.log('Using upstream content-type:', upstreamCt);
                return upstreamCt;
            }
        }
    }

    // Get extension
    const urlPath = url.split("?")[0];
    const ext = urlPath.split(".").pop().toLowerCase();

    // Enhanced extension mapping
    const extMap = {
        // Video formats
        ts: "video/MP2T",
        m2ts: "video/MP2T",
        mts: "video/MP2T",
        mp4: "video/mp4",
        m4v: "video/mp4",
        m4s: "video/mp4",
        mov: "video/quicktime",

        // Audio formats
        m4a: "audio/mp4",
        aac: "audio/aac",
        mp3: "audio/mpeg",

        // Disguised extensions
        jpg: "video/MP2T",
        jpeg: "video/MP2T",
        png: "video/MP2T",
        gif: "video/MP2T",
        webp: "video/MP2T",
        bmp: "video/MP2T",
        img: "video/MP2T",
        picture: "video/MP2T",
        data: "video/MP2T",
        bin: "application/octet-stream"
    };

    if (extMap[ext]) {
        console.log('Using extension mapping:', ext, '->', extMap[ext]);
        return extMap[ext];
    }

    // Try content-based detection
    if (segmentData && segmentData.length > 4) {
        // Check for MPEG-TS sync byte (0x47) at start of each packet
        // MPEG-TS packets are 188 bytes and start with 0x47
        let tsCount = 0;
        for (let i = 0; i < Math.min(segmentData.length, 1880); i += 188) {
            if (segmentData[i] === 0x47) tsCount++;
        }
        if (tsCount > 5) { // If multiple sync bytes found
            console.log('Detected MPEG-TS by sync byte pattern');
            return "video/MP2T";
        }

        // Check for MP4/fMP4 signature
        const header = segmentData.toString('utf8', 0, 8);
        if (header.includes('ftyp')) {
            console.log('Detected MP4 by ftyp header');
            return "video/mp4";
        }
    }

    console.log('Using default content-type: video/MP2T');
    return "video/MP2T";
}


// ==================== CONTROLLER ====================
class ProxyController {
    constructor() {
        this.refererStore = new Map();
        this.requestTracker = new Map(); // Track duplicate requests
    }

    trackRequest(req, targetUrl) {
        const key = `${req.ip}:${targetUrl}`;
        const now = Date.now();

        if (!this.requestTracker.has(key)) {
            this.requestTracker.set(key, []);
        }

        const requests = this.requestTracker.get(key);
        requests.push(now);

        // Clean up old requests (older than 10 seconds)
        const recentRequests = requests.filter(time => now - time < 10000);
        this.requestTracker.set(key, recentRequests);

        return recentRequests.length;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Utility: selectively forward upstream headers to the client response.
    // ─────────────────────────────────────────────────────────────────────────────
    forwardHeaders(res, upstream, keys) {
        for (const key of keys) {
            if (upstream.headers[key]) {
                res.set(key, upstream.headers[key]);
            }
        }
    }
    // ─────────────────────────────────────────────────────────────────────────────
    // Set comprehensive CORS headers that HLS.js / vidstack need.
    // ─────────────────────────────────────────────────────────────────────────────
    setCorsHeaders(res) {
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

    isManifest(url, contentType) {
        return contentType?.includes('mpegurl') ||
            contentType?.includes('application/vnd.apple.mpegurl') ||
            url.includes('.m3u8');
    }

    extractTargetUrl(req) {
        if (req.query.url) return decodeURIComponent(req.query.url);
        if (req.params.encodedUrl) {
            return Buffer.from(req.params.encodedUrl, 'base64').toString('utf8');
        }
        if (req.params[0]) return decodeURIComponent(req.params[0]);
        return null;
    }

    /**
 * Extract the optional `referer` query param.
 * Returns the decoded string or null.
 */
    extractReferer(req) {
        const raw = req.query?.referer;
        if (!raw) return null;
        try {
            return decodeURIComponent(raw);
        } catch {
            return raw;
        }
    }

    storeReferer(domain, referer) {
        if (referer) {
            this.refererStore.set(domain, referer);
        }
    }

    getReferer(url) {
        try {
            const domain = new URL(url).hostname;
            return this.refererStore.get(domain);
        } catch (err) {
            return null;
        }
    }


    async processPlaylist(content, targetUrl, referer) {
        let lines = content.split('\n');
        const processedLines = [];

        const refSuffix = referer ? `&referer=${encodeURIComponent(referer)}` : "";

        for (const line of lines) {
            let trimmedLine = line.trim();

            // Process EXT-X-STREAM-INF lines
            if (trimmedLine.includes('#EXT-X-STREAM-INF')) {
                // Add BANDWIDTH if missing (prevents player issues)
                if (!trimmedLine.includes('BANDWIDTH=')) {
                    trimmedLine = trimmedLine.replace('#EXT-X-STREAM-INF:', '#EXT-X-STREAM-INF:BANDWIDTH=2000000,');
                }
                processedLines.push(trimmedLine);
            }
            // Process EXT-X-KEY lines
            else if (trimmedLine.startsWith('#EXT-X-KEY')) {
                const uriMatch = line.match(/URI="([^"]+)"/);
                if (uriMatch && uriMatch[1]) {
                    const keyUri = uriMatch[1];
                    const absoluteKeyUrl = keyUri.startsWith('http')
                        ? keyUri
                        : new URL(keyUri, targetUrl).href;

                    const encodedKey = encodeURIComponent(absoluteKeyUrl);
                    const newLine = line.replace(/URI="[^"]+"/, `URI="${ROOT_URL}/proxy/key?url=${encodedKey}${refSuffix}"`);
                    processedLines.push(newLine);
                } else {
                    processedLines.push(line);
                }
            }
            // Handle URLs
            else if (trimmedLine && !trimmedLine.startsWith('#')) {
                try {
                    const absoluteUrl = trimmedLine.startsWith('http')
                        ? trimmedLine
                        : new URL(trimmedLine, targetUrl).href;

                    // Check if it's a playlist or segment
                    if (absoluteUrl.includes('.m3u8')) {
                        processedLines.push(`${ROOT_URL}/proxy/m3u8?url=${encodeURIComponent(absoluteUrl)}${refSuffix}&_direct=1`);
                    } else {
                        // For segments, use the /proxy/segment endpoint
                        processedLines.push(`${ROOT_URL}/proxy/segment?url=${encodeURIComponent(absoluteUrl)}${refSuffix}`);
                    }
                } catch (e) {
                    processedLines.push(line);
                }
            } else {
                processedLines.push(line);
            }
        }

        return processedLines.join('\n');
    }

    handleOptions = (req, res) => {
        res.set({
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers":
                "Origin, X-Requested-With, Content-Type, Accept, Range",
            "Access-Control-Expose-Headers":
                "Content-Length, Content-Range, Content-Type, Accept-Ranges, ETag, Last-Modified",
            "Access-Control-Max-Age": "86400",
        }).status(204).end();
    }

    getDebugInfo = (req, res) => {
        res.json({
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            referers: Array.from(this.refererStore.entries())
        });
    }

    clearStores = (req, res) => {
        this.refererStore.clear();
        res.json({ message: 'Referer store cleared' });
    }

    showHome = (req, res) => {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>M3U8 Proxy</title>
                <style>
                    body { font-family: Arial; max-width: 800px; margin: 50px auto; padding: 20px; }
                    code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; }
                </style>
            </head>
            <body>
                <h1>🎥 M3U8 Proxy</h1>
                <p>Changes audio codec from mp4a.40.1 to mp4a.40.2</p>
                <p><a href="/debug">Debug Info</a></p>
                <h3>Usage:</h3>
                <code>GET /proxy?url=https://example.com/stream.m3u8</code>
            </body>
            </html>
        `);
    }

    getSegmentStats = (req, res) => {
        const stats = {};
        this.requestTracker.forEach((times, url) => {
            stats[url] = {
                count: times.length,
                lastRequest: new Date(Math.max(...times)).toISOString(),
                frequency: times.length > 1 ? `${(times.length / 10).toFixed(1)}/sec` : 'normal'
            };
        });
        res.json(stats);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // 1.  /proxy/m3u8?url=<encoded>&referer=<encoded>
    //     Fetch an M3U8 playlist, rewrite it, and return it.
    // ─────────────────────────────────────────────────────────────────────────────
    handleRequest = async (req, res) => {
        try {
            let targetUrl = this.extractTargetUrl(req);

            if (!targetUrl) {
                return res.status(400).json({ error: 'Missing URL parameter' });
            }

            console.log(`[${new Date().toISOString()}] 📹 ${targetUrl}`);

            const parsedUrl = new URL(targetUrl);
            const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

            let referer = this.extractReferer(req);

            if (this.isManifest(targetUrl)) {
                referer = req.query.referer || req.headers.referer || baseUrl;
                this.storeReferer(parsedUrl.hostname, referer);
            }

            if (!referer) {
                referer = baseUrl;
            }

            const response = await axios({
                method: 'GET',
                url: targetUrl,
                // responseType: 'arraybuffer',
                headers: {
                    'User-Agent': CONFIG.USER_AGENT,
                    'Referer': referer,
                    'Origin': referer,
                    ...(req.headers.range ? { 'Range': req.headers.range } : {})
                },
                timeout: CONFIG.TIMEOUT,
                maxRedirects: CONFIG.MAX_REDIRECTS
            });

            // Set CORS headers
            res.set({
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Allow-Credentials': 'true'
            });

            // Handle manifest files
            if (this.isManifest(targetUrl, response.headers['content-type'])) {
                const content = response.data.toString('utf8');

                const isDirect = req.query._direct === "1";

                let referer = req.query.referer;

                const isMaster =
                    /^#EXT-X-STREAM-INF:/m.test(content) ||
                    /^#EXT-X-MEDIA:/m.test(content);

                if (!isMaster && !isDirect) {
                    // Return a synthetic master playlist that wraps this media playlist.
                    const refSuffix = referer
                        ? `&referer=${encodeURIComponent(referer)}`
                        : "";
                    const mediaUrl = `${ROOT_URL}/proxy/m3u8?url=${encodeURIComponent(targetUrl)}${refSuffix}&_direct=1`;
                    const processedContent = [
                        "#EXTM3U",
                        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.640028,mp4a.40.2"',
                        mediaUrl,
                        "",
                    ].join("\n");

                    res.set({
                        "Content-Type":
                            "application/vnd.apple.mpegurl; charset=utf-8",
                        "Cache-Control": "no-cache",
                    });
                    return res.send(processedContent);
                }

                const processedContent = await this.processPlaylist(content, targetUrl, referer);

                // Log the codec change
                if (content.includes('mp4a.40.1')) {
                    console.log('✅ Changed audio codec from mp4a.40.1 to mp4a.40.2');
                }


                this.setCorsHeaders(res);
                res.set({
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Cache-Control': 'no-cache'
                });
                return res.send(processedContent);
            }

            const data = Buffer.from(response.data);

            // Determine content type
            let contentType = response.headers['content-type'];

            if (targetUrl.includes('.m4s') || targetUrl.includes('.mp4')) {
                contentType = 'video/mp4';
            } else if (targetUrl.includes('.m4a')) {
                contentType = 'audio/mp4';
            } else if (targetUrl.includes('.ts')) {
                contentType = 'video/MP2T';
            } else if (targetUrl.includes('.key') || targetUrl.includes('key.bin')) {
                contentType = 'application/octet-stream';
            } else if (targetUrl.includes('.aac')) {
                contentType = 'audio/aac';
            } else if (targetUrl.includes('.m4v')) {
                contentType = 'video/mp4';
            }

            res.set({
                'Content-Type': contentType,
                'Content-Length': data.length,
                'Cache-Control': 'public, max-age=3600',
                'Accept-Ranges': 'bytes'
            });

            // Handle range requests
            if (req.headers.range) {
                const range = req.headers.range;
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : data.length - 1;
                const chunkSize = (end - start) + 1;

                res.status(206);
                res.set({
                    'Content-Range': `bytes ${start}-${end}/${data.length}`,
                    'Content-Length': chunkSize
                });

                return res.send(data.slice(start, end + 1));
            }

            res.send(data);

        } catch (err) {
            return handleApiError(res, err, "Something went wrong while fetching handle request");
        }
    }


    // ─────────────────────────────────────────────────────────────
    // 2. /proxy/segment - Handle segment requests
    // ─────────────────────────────────────────────────────────────
    handleSegment = async (req, res) => {
        try {
            const targetUrl = this.extractTargetUrl(req);
            if (!targetUrl) return;

            // Track duplicate requests
            const requestCount = this.trackRequest(req, targetUrl);
            const requestId = Math.random().toString(36).substring(7);

            console.log(`[${requestId}] [${new Date().toISOString()}] 📦 Segment #${requestCount}: ${targetUrl}`);
            console.log(`[${requestId}] Headers:`, {
                range: req.headers.range,
                ice: req.headers['if-none-match'] ? 'yes' : 'no',
                ims: req.headers['if-modified-since'] ? 'yes' : 'no'
            });

            const parsedUrl = new URL(targetUrl);
            const referer = this.extractReferer(req) || parsedUrl.origin;

            // Check if it's a range request (partial content)
            const isRangeRequest = !!req.headers.range;

                        const upstream = await fetchUpstream(targetUrl, {
                ...req.headers,
                range: req.headers.range // Forward range header
            }, referer);

            // Log upstream response
            console.log(`[${requestId}] Upstream status: ${upstream.status}`);
            console.log(`[${requestId}] Upstream content-type: ${upstream.headers['content-type']}`);
            console.log(`[${requestId}] Upstream content-length: ${upstream.data.length}`);

            if (upstream.status >= 400) {
                this.setCorsHeaders(res);
                return handleApiError(res, upstream, `Upstream returned ${upstream.status}`)
            }

            const upstreamCt = (upstream.headers["content-type"] || "").toLowerCase();
            const contentType = guessSegmentContentType(targetUrl, upstreamCt, upstream.data);

            console.log(`[${requestId}] Final content-type: ${contentType}`);

            // Set strong cache headers to prevent retries
            this.setCorsHeaders(res);

            // Forward useful headers
            this.forwardHeaders(res, upstream, [
                "content-range",
                "accept-ranges",
                "cache-control",
                "etag",
                "last-modified",
            ]);

            // Add strong caching headers if not a range request
            if (!isRangeRequest) {
                res.set({
                    "Cache-Control": "public, max-age=3600", // Cache for 1 hour
                    "Last-Modified": new Date().toUTCString()
                });
            }

            // Always set content-type and length
            res.set({
                "Content-Type": contentType,
                "Content-Length": upstream.data.length
            });

            // Handle range requests properly
            if (upstream.status === 206 || isRangeRequest) {
                res.status(206);
                if (upstream.headers['content-range']) {
                    res.set('Content-Range', upstream.headers['content-range']);
                }
            } else {
                res.status(200);
            }

            // Send response
            res.send(upstream.data);

            console.log(`[${requestId}] ✅ Sent ${upstream.data.length} bytes`);

        } catch (err) {
            console.error("❌ Segment error:", err);
            return handleApiError(res, err, "Something went wrong while segments");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // 3.  /proxy/key?url=<encoded>&referer=<encoded>
    //     Proxy AES-128 / SAMPLE-AES decryption keys.
    // ─────────────────────────────────────────────────────────────────────────────
    handleKey = async (req, res) => {
        try {
            const targetUrl = this.extractTargetUrl(req);

            if (!targetUrl) {
                return res.status(400).json({ error: 'Missing URL parameter' });
            }

            console.log(`[${new Date().toISOString()}] 🔑 Key: ${targetUrl}`);

            const parsedUrl = new URL(targetUrl);
            const referer = this.extractReferer(req) || parsedUrl.origin;

            const upstream = await fetchUpstream(targetUrl, req.headers, referer);

            if (upstream.status >= 400) {
                return res
                    .status(upstream.status)
                    .json({ error: `Upstream returned ${upstream.status}` });
            }

            res.set({
                "Content-Type":
                    upstream.headers["content-type"] || "application/octet-stream",
                "Cache-Control": "no-store",
            });
            res.send(upstream.data);

        } catch (err) {
            console.error('❌ Key error:', err.message);
            return handleApiError(res, err, "Something went wrong while fetching key");
        }
    };

    // ─────────────────────────────────────────────────────────────────────────────
    // 4.  /proxy/subtitle?url=<encoded>&referer=<encoded>
    //     Proxy WebVTT / SRT subtitle files.
    // ─────────────────────────────────────────────────────────────────────────────
    subtitle = async (req, res) => {
        try {
            const url = this.extractTargetUrl(req);

            if (!url) {
                return res.status(400).json({ error: 'Missing URL parameter' });
            }

            const referer = this.extractReferer(req);

            const upstream = await fetchUpstream(url, req.headers, referer);

            if (upstream.status >= 400) {
                this.setCorsHeaders(res);
                return res
                    .status(upstream.status)
                    .json({ error: `Upstream returned ${upstream.status}` });
            }

            // If the subtitle is itself an m3u8, rewrite it
            const ct = (upstream.headers["content-type"] || "").toLowerCase();
            if (ct.includes("mpegurl") || url.endsWith(".m3u8")) {
                const bodyText = upstream.data.toString("utf-8");
                const rewritten = this.processPlaylist(bodyText, url, referer);
                this.setCorsHeaders(res);
                res.set({
                    "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
                });
                return res.send(rewritten);
            }

            this.setCorsHeaders(res);
            res.set({
                "Content-Type": ct || "text/vtt; charset=utf-8",
            });
            res.send(upstream.data);

        } catch (err) {
            return handleApiError(res, err, "Something went wrong while fetching subtitle");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // 5.  /proxy/audio?url=<encoded>&referer=<encoded>
    //     Proxy audio-only renditions (AAC, MP3, Opus, etc.)
    // ─────────────────────────────────────────────────────────────────────────────
    handleAudio = async (req, res) => {
        try {
            const url = this.extractTargetUrl(req);

            if (!url) {
                return res.status(400).json({ error: 'Missing URL parameter' });
            }

            const referer = this.extractReferer(req);

            const upstream = await fetchUpstream(url, req.headers, referer);

            if (upstream.status >= 400) {
                this.setCorsHeaders(res);
                return res
                    .status(upstream.status)
                    .json({ error: `Upstream returned ${upstream.status}` });
            }

            // If it's an m3u8 for audio rendition, rewrite
            const ct = (upstream.headers["content-type"] || "").toLowerCase();
            if (ct.includes("mpegurl") || /\.m3u8?(\?|$)/i.test(url)) {
                const bodyText = upstream.data.toString("utf-8");
                const rewritten = this.processPlaylist(bodyText, url, referer, rootUrl);
                this.setCorsHeaders(res);
                res.set({
                    "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
                });
                return res.send(rewritten);
            }

            this.forwardHeaders(res, upstream, [
                "content-type",
                "content-length",
                "content-range",
                "accept-ranges",
            ]);
            this.setCorsHeaders(res);
            res.status(upstream.status).send(upstream.data);



        } catch (err) {
            return handleApiError(res, err, "Something went wrong while fetching audio");
        }
    }


    // ─────────────────────────────────────────────────────────────────────────────
    // 6.  /proxy/image?url=<encoded>&referer=<encoded>
    //     Proxy thumbnail / trick-play images.
    // ─────────────────────────────────────────────────────────────────────────────
    handleImage = async (req, res) => {
        try {
            const url = this.extractTargetUrl(req);

            if (!url) {
                return res.status(400).json({ error: 'Missing URL parameter' });
            }

            const referer = this.extractReferer(req);

            const upstream = await fetchUpstream(url, req.headers, referer);

            if (upstream.status >= 400) {
                this.setCorsHeaders(res);
                return res
                    .status(upstream.status)
                    .json({ error: `Upstream returned ${upstream.status}` });
            }


            this.forwardHeaders(res, upstream, [
                "content-type",
                "content-length",
                "cache-control",
                "etag",
            ]);
            this.setCorsHeaders(res);
            res.status(upstream.status).send(upstream.data);

        } catch (err) {
            return handleApiError(res, err, "Something went wrong while fetching image");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // 7.  /proxy/raw?url=<encoded>&referer=<encoded>
    //     Generic catch-all: proxies anything without rewriting.
    // ─────────────────────────────────────────────────────────────────────────────
    rawRequest = async (req, res) => {
        try {
            const url = this.extractTargetUrl(req);

            if (!url) {
                return res.status(400).json({ error: 'Missing URL parameter' });
            }

            const referer = this.extractReferer(req);

            const upstream = await fetchUpstream(url, req.headers, referer);

            if (upstream.status >= 400) {
                this.setCorsHeaders(res);
                return res
                    .status(upstream.status)
                    .json({ error: `Upstream returned ${upstream.status}` });
            }

            this.forwardHeaders(res, upstream, [
                "content-type",
                "content-length",
                "content-range",
                "accept-ranges",
                "cache-control",
                "etag",
                "last-modified",
            ]);
            this.setCorsHeaders(res);
            res.status(upstream.status).send(upstream.data);
        } catch (err) {
            return handleApiError(res, err, "Something went wrong while fetching raw request");
        }
    }

}

const proxyController = new ProxyController();
module.exports = proxyController;