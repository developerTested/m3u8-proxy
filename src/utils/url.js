/**
 * Resolve a potentially relative URI against a base URL.
 * Returns the absolute URL string.
 */
function resolveUrl(base, relative) {
    // Already absolute
    if (/^https?:\/\//i.test(relative)) return relative;
    return new URL(relative, base).href;
}

/**
 * Return the "directory" portion of a URL (everything up to the last `/`).
 * Used as the base when resolving relative segment/key paths.
 */
function baseUrl(url) {
    const idx = url.lastIndexOf("/");
    return idx === -1 ? url : url.substring(0, idx + 1);
}

module.exports = { resolveUrl, baseUrl };
