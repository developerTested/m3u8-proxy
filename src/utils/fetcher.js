const axios = require("axios");

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

module.exports = { fetchUpstream };
