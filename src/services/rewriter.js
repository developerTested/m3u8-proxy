const { resolveUrl, baseUrl } = require("../utils/url");

/**
 * Rewrite an M3U8 playlist so that every referenced resource
 * is routed through the local proxy.
 *
 * @param {string}  body       – raw M3U8 text
 * @param {string}  sourceUrl  – original absolute URL of this playlist
 * @param {string}  proxyBase  – proxy server base, e.g. "http://localhost:3500"
 * @param {string} [referer]   – optional custom referer to propagate
 * @returns {string}           – rewritten M3U8 text
 */
function rewriteM3U8(body, sourceUrl, proxyBase, referer = null) {
    const base = baseUrl(sourceUrl);
    const lines = body.split("\n");
    const result = [];
    const refSuffix = referer ? `&referer=${enc(referer)}` : "";

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trimEnd();

        // ── 1. Tags that carry a URI= attribute ──────────────────────────────
        line = rewriteUriAttribute(line, base, proxyBase, refSuffix);

        // ── 2. #EXT-X-STREAM-INF  →  the NEXT line is the variant URL ────────
        if (/^#EXT-X-STREAM-INF:/i.test(line)) {
            result.push(line);
            i++;
            if (i < lines.length) {
                const nextLine = lines[i].trim();
                if (nextLine && !nextLine.startsWith("#")) {
                    result.push(proxyPlaylistUrl(nextLine, base, proxyBase, refSuffix));
                } else {
                    result.push(nextLine);
                }
            }
            continue;
        }

        // ── 3. Bare segment lines (no # prefix) ─────────────────────────────
        if (line && !line.startsWith("#")) {
            result.push(proxySegmentUrl(line, base, proxyBase, refSuffix));
            continue;
        }

        result.push(line);
    }

    return result.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Rewrite every URI="…" inside a tag line.
 * Picks the correct proxy endpoint based on the tag type.
 */
function rewriteUriAttribute(line, base, proxyBase, refSuffix) {
    // Key tags → /proxy/key
    if (/^#EXT-X-(SESSION-)?KEY:/i.test(line)) {
        return line.replace(
            /URI="([^"]+)"/gi,
            (_match, uri) =>
                `URI="${proxyBase}/proxy/key?url=${enc(resolveUrl(base, uri))}${refSuffix}"`
        );
    }

    // Map (init segment) → /proxy/segment
    if (/^#EXT-X-MAP:/i.test(line)) {
        return line.replace(
            /URI="([^"]+)"/gi,
            (_match, uri) =>
                `URI="${proxyBase}/proxy/segment?url=${enc(resolveUrl(base, uri))}${refSuffix}"`
        );
    }

    // Preload hint → /proxy/segment
    if (/^#EXT-X-PRELOAD-HINT:/i.test(line)) {
        return line.replace(
            /URI="([^"]+)"/gi,
            (_match, uri) =>
                `URI="${proxyBase}/proxy/segment?url=${enc(resolveUrl(base, uri))}${refSuffix}"`
        );
    }

    // Media renditions (audio / subtitle / video)
    if (/^#EXT-X-MEDIA:/i.test(line)) {
        return line.replace(/URI="([^"]+)"/gi, (_match, uri) => {
            const abs = resolveUrl(base, uri);
            if (isPlaylistUri(uri)) {
                return `URI="${proxyBase}/proxy/m3u8?url=${enc(abs)}${refSuffix}"`;
            }
            return `URI="${proxyBase}/proxy/segment?url=${enc(abs)}${refSuffix}"`;
        });
    }

    // I-Frame / Image stream
    if (
        /^#EXT-X-I-FRAME-STREAM-INF:/i.test(line) ||
        /^#EXT-X-IMAGE-STREAM-INF:/i.test(line)
    ) {
        return line.replace(
            /URI="([^"]+)"/gi,
            (_match, uri) =>
                `URI="${proxyBase}/proxy/m3u8?url=${enc(resolveUrl(base, uri))}${refSuffix}"`
        );
    }

    // Rendition report
    if (/^#EXT-X-RENDITION-REPORT:/i.test(line)) {
        return line.replace(
            /URI="([^"]+)"/gi,
            (_match, uri) =>
                `URI="${proxyBase}/proxy/m3u8?url=${enc(resolveUrl(base, uri))}${refSuffix}"`
        );
    }

    return line;
}

/** Proxy URL for a sub-playlist (variant / rendition). */
function proxyPlaylistUrl(rawUri, base, proxyBase, refSuffix) {
    const abs = resolveUrl(base, rawUri.trim());
    return `${proxyBase}/proxy/m3u8?url=${enc(abs)}${refSuffix}`;
}

/** Proxy URL for a media segment. */
function proxySegmentUrl(rawUri, base, proxyBase, refSuffix) {
    const abs = resolveUrl(base, rawUri.trim());
    return `${proxyBase}/proxy/segment?url=${enc(abs)}${refSuffix}`;
}

/** URL-encode helper */
function enc(str) {
    return encodeURIComponent(str);
}

/** Check if a URI looks like a playlist file rather than a segment. */
function isPlaylistUri(uri) {
    return /\.m3u8?(\?|$)/i.test(uri);
}

module.exports = { rewriteM3U8 };
