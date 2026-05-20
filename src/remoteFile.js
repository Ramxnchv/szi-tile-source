/**
 * Default size (bytes) of the tail prefetched on `RemoteFile.create`.
 * Picked to cover EOCD + Zip64 records + Central Directory + the .dzi for typical SZIs,
 * so the whole bootstrap (size discovery, ZIP TOC, DZI options) resolves in 1 round-trip.
 */
const DEFAULT_INITIAL_TAIL_SIZE = 1024 * 1024;

/**
 * Represents a remote file that we are going to try and read from
 */
export class RemoteFile {
  /**
   * Create the remote file. By default, a single suffix-range request is issued to discover
   * the file size *and* prefetch the tail of the file in one round-trip. The prefetched bytes
   * are kept in memory and reused by `fetchRange` whenever the requested range falls within
   * them, so SZI bootstrap (EOCD + Central Directory + .dzi) typically completes with no
   * additional HTTP requests.
   *
   * @param {string} url url of the file that we eventually want to read
   * @param {Object} fetchOptions options to apply to all fetches
   * @param {string} fetchOptions.mode cors mode to use
   * @param {string} fetchOptions.credentials whether to send credentials
   * @param {Object} fetchOptions.headers additional headers to add to all requests
   * @param {Object} [options]
   * @param {number} [options.initialTailSize=1048576] bytes to prefetch from the end of the file
   * @returns {Promise<RemoteFile>}
   */
  static create = async (url, fetchOptions = {}, options = {}) => {
    const initialTailSize = options.initialTailSize ?? DEFAULT_INITIAL_TAIL_SIZE;
    const { size, tailBuffer, tailStart } = await this.fetchSuffix(url, fetchOptions, initialTailSize);
    return new RemoteFile(url, size, fetchOptions, { tailBuffer, tailStart });
  };

  /**
   * Issue a suffix-range request (`Range: bytes=-N`) and parse the Content-Range header to
   * recover both the total file size and where the returned chunk starts inside the file.
   * If the file is smaller than `tailSize`, the server returns the entire file.
   *
   * @param {string} url
   * @param {Object} fetchOptions same shape as `create`
   * @param {number} tailSize bytes to request from the end of the file
   * @returns {Promise<{size: number, tailBuffer: ArrayBuffer, tailStart: number}>}
   */
  static fetchSuffix = async (url, fetchOptions, tailSize) => {
    const headers = fetchOptions.headers
      ? { ...fetchOptions.headers, Range: `bytes=-${tailSize}` }
      : { Range: `bytes=-${tailSize}` };

    const response = await fetch(url, {
      headers,
      mode: fetchOptions.mode,
      credentials: fetchOptions.credentials,
    });

    if (!response.ok) {
      throw new Error(`Could not fetch tail of ${url}, response status: ${response.status}`);
    }

    const contentRange = response.headers.get('Content-Range');
    if (!contentRange) {
      throw new Error(
        `Could not determine size of ${url}, Content-Range header not included in response. ` +
          "Check that your server's CORS settings include it in Access-Control-Expose-Headers.",
      );
    }

    const match = contentRange.match(/bytes (\d+)-(\d+)\/(\d+)/);
    if (!match) {
      throw new Error(`Could not parse Content-Range header (${contentRange}) for ${url}`);
    }

    const tailStart = parseInt(match[1], 10);
    const size = parseInt(match[3], 10);
    const tailBuffer = await response.arrayBuffer();

    return { size, tailBuffer, tailStart };
  };

  constructor(url, size, fetchOptions, cache = {}) {
    this.url = url;
    this.size = size;
    this.fetchOptions = fetchOptions;
    this._cachedTail = cache.tailBuffer ?? null;
    this._cachedTailStart = cache.tailStart ?? null;
  }

  /**
   * Fetch the range of bytes specified. Note that end is *exclusive*, though the header
   * expects *inclusive* values. This removes the need to continually subtract 1 from
   * the more usual end-exclusive values used elsewhere.
   *
   * If the requested range falls entirely within the cached tail prefetched at construction
   * time, it is served from memory without issuing an HTTP request.
   *
   * @param {number} start inclusive start of range to fetch
   * @param {number} end exclusive start of range to fetch
   * @param {AbortSignal }abortSignal AbortController signal, optionally specify this if you might want to
   *        abort the request
   * @throws Error if the start or end lie outside the file, or if start > end. Also throws
   *         an error if the request fails with anything other than a status between 200 and
   *         299.
   */
  fetchRange = async (start, end, abortSignal) => {
    if (start < 0 || start > this.size) {
      throw new Error(`Start of fetch range (${start}) out of bounds (0 - ${this.size})!`);
    }

    if (end < 0 || end > this.size) {
      throw new Error(`Start of fetch range (${start}) out of bounds (0 - ${this.size})!`);
    }

    if (start > end) {
      throw new Error(`Start of fetch range (${start}) greater than end (${end})!`);
    }

    if (
      this._cachedTail !== null &&
      start >= this._cachedTailStart &&
      end <= this._cachedTailStart + this._cachedTail.byteLength
    ) {
      const offset = start - this._cachedTailStart;
      return this._cachedTail.slice(offset, offset + (end - start));
    }

    const rangeHeaderValue = `bytes=${start}-${end - 1}`;
    const headers = this.fetchOptions.headers
      ? { ...this.fetchOptions.headers, Range: rangeHeaderValue }
      : { Range: rangeHeaderValue };

    const response = await fetch(this.url, {
      headers,
      signal: abortSignal,
      mode: this.fetchOptions.mode,
      credentials: this.fetchOptions.credentials,
    });

    if (!response.ok) {
      throw new Error(`Couldn't fetch range ${start}:${end} of ${this.url} status: ${response.status}`);
    }

    return await response.arrayBuffer();
  };

  /**
   * Release the in-memory tail prefetched at construction time. Call once bootstrap is done
   * and tile fetching is about to start, so the prefetch cache doesn't stay pinned for the
   * lifetime of the viewer (relevant when many SZIs are opened in parallel).
   */
  releaseCache = () => {
    this._cachedTail = null;
    this._cachedTailStart = null;
  };
}
