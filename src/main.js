import { RemoteFile } from './remoteFile.js';
import { SziFileReader } from './sziFileReader.js';
import { resolveLogger } from './logger.js';

export const enableSziTileSource = (OpenSeadragon) => {
  /**
   * SZI Tile Source that enables OpenSeadragon to load remote SZI files.
   *
   * This a relatively small extension of the DziTileSource, with a large part of the difference being at the
   * initialisation stage. The need to do this initialisation asynchronously combined with the need to do superclass
   * initialisation means that the class has a static factory constructor that must be called explicitly by the
   * user, as opposed to relying on OSD creating instances automatically in response to its configuration settings.
   *
   * For more on how to use this Tile Source see the
   * [README.md]{@link https://github.com/sundogbio/szi-tile-source/blob/main/README.md#usage}
   */
  class SziTileSource extends OpenSeadragon.DziTileSource {
    /**
     * Create an SZI tile source for use with OpenSeadragon. This static factory constructor should be used
     * instead of the standard Construct, as the majority of the configuration of the image source happens
     * here asynchronously.
     *
     * @param {string} url location of the SZI file we want to read
     * @param fetchOptions options to use when making HTTP requests to fetch parts of the file
     * @param fetchOptions.mode cors mode to use. Note that "no-cors" is not accepted, as it breaks Range requests.
     *        (See: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#making_cross-origin_requests)
     * @param fetchOptions.credentials when and how to pass credentials
     *        (see:https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#including_credentials)
     * @param fetchOptions.headers additional HTTP headers to send with each request
     * @param {Object} [loggingOptions] optional logging configuration
     * @param {('silent'|'info'|'debug')} [loggingOptions.logLevel='silent']
     *        'silent' (default) — no console output, same as before.
     *        'info'   — bootstrap milestones (tail prefetch, central directory parsed, DZI metadata).
     *        'debug'  — every range request and tile download with size + timings.
     * @param {string} [loggingOptions.logLabel] short label prefixed to every log line; defaults to the SZI filename.
     * @param {Object} [loggingOptions.logger] pre-built logger object ({info, debug, warn}) to use instead of the level/label.
     * @returns {Promise<SziTileSource>}
     */
    static createSziTileSource = async (url, fetchOptions = {}, loggingOptions = {}) => {
      if (fetchOptions && fetchOptions.mode === 'no-cors') {
        throw new Error("'no-cors' mode is not supported, as Range headers don't work with it");
      }

      const logger = resolveLogger(loggingOptions.logger ?? loggingOptions, url);
      logger.info('reading SZI bootstrap…');
      const bootstrapStart = performance.now();

      const remoteSziFile = await RemoteFile.create(url, fetchOptions, { logger });
      const remoteSziReader = await SziFileReader.create(remoteSziFile, { logger });

      logger.info(`reading DZI descriptor: ${remoteSziReader.dziFilename()}`);
      const options = await this.readOptionsFromDziXml(remoteSziReader);

      // The 1 MB tail prefetched by RemoteFile.create is NOT released here. Overview tiles
      // (L0–L4 of the DZI pyramid) live at the end of the SZI archive, inside that same
      // tail window. Keeping the buffer alive lets the first handful of tile fetches resolve
      // as cache hits instead of issuing fresh Range requests. The buffer is auto-released
      // inside downloadTileStart once SziTileSource.RELEASE_TAIL_AFTER_TILES tiles have been
      // served, which is enough to cover the overview band of every common viewport.

      const tileSource = new SziTileSource(remoteSziReader, remoteSziFile, options, logger);
      logger.info(
        `DZI ready: ${options.width}×${options.height}, tileSize=${options.tileSize}, maxLevel=${tileSource.maxLevel} | bootstrap ${(performance.now() - bootstrapStart).toFixed(0)} ms`,
      );
      return tileSource;
    };

    static async readOptionsFromDziXml(remoteSziReader) {
      const dziFilename = remoteSziReader.dziFilename();
      const dziUint8Buffer = await remoteSziReader.fetchFileBody(dziFilename);
      const dziXmlText = new TextDecoder().decode(dziUint8Buffer);
      const dziXml = OpenSeadragon.parseXml(dziXmlText);
      return OpenSeadragon.DziTileSource.prototype.configure(dziXml, dziFilename, '');
    }

    /**
     * Number of tile fetches after which the prefetched tail buffer (held by RemoteFile)
     * is released. Sized to cover the DZI overview band (typically L0–L4 is 1 tile each,
     * plus a couple of tiles from the first non-overview level) before letting go of the
     * ~1 MB cache so it does not stay pinned for the lifetime of the viewer.
     */
    static RELEASE_TAIL_AFTER_TILES = 8;

    /**
     * Do not call this directly, for internal use only!
     *
     * @param remoteSziReader
     * @param remoteSziFile underlying RemoteFile, kept so the tail prefetch cache can be
     *        released once enough overview tiles have been served from it.
     * @param options
     * @param logger optional leveled logger built by createSziTileSource
     */
    constructor(remoteSziReader, remoteSziFile, options, logger = null) {
      super(options);
      this.remoteSziReader = remoteSziReader;
      this._remoteSziFile = remoteSziFile;
      this._logger = logger;
      this._tilesServed = 0;
      this._tailReleased = false;
    }

    /**
     * Download tile data. Intended for use by OSD, not end users!
     *
     * This is a cut down implementation of the XML-specific path of TileSource.Download
     * that instead of calling makeAjaxRequest uses the remoteSziFileReader.
     *
     * Note that this ignores all the Ajax options as the remoteSziReader uses the fetchOptions supplied in
     * the createSziTileSourceInstead. Also note that only the documented parts of context are used below.
     *
     * @param {ImageJob} context job context that you have to call finish(...) on.
     * @param {String} [context.src] - URL of image to download.
     * @param {*} [context.userData] - Empty object to attach your own data and helper variables to.
     * @param {Function} [context.finish] - Should be called unless abort() was executed, e.g. on all occasions,
     */
    downloadTileStart = (context) => {
      const image = new Image();
      image.onload = function () {
        resetImageHandlers();
        context.finish(image, context.userData.request, 'image');
      };
      image.onabort = image.onerror = function () {
        resetImageHandlers();
        context.finish(null, context.userData.request, 'Image load aborted.');
      };

      const resetImageHandlers = () => {
        image.onload = image.onerror = image.onabort = null;
      };

      context.userData.image = image;
      context.userData.abortController = new AbortController();

      // Extract pyramid level from the SZI-internal path: "<name>_files/<level>/<col>_<row>.<ext>".
      // Falls back to '?' when the path doesn't match (shouldn't happen for DZI tiles).
      const levelMatch = typeof context.src === 'string' ? context.src.match(/_files\/(\d+)\//) : null;
      const level = levelMatch ? levelMatch[1] : '?';
      const tileStart = performance.now();
      this._logger?.debug?.(`downloading tile level=${level}/${this.maxLevel} (${context.src})`);

      this.remoteSziReader.fetchFileBody(context.src, context.userData.abortController.signal).then(
        (arrayBuffer) => {
          const imageBlob = new Blob([arrayBuffer]);
          if (imageBlob.size === 0) {
            resetImageHandlers();
            context.finish(null, null, 'Empty image!');
          } else {
            this._logger?.debug?.(
              `tile level=${level} ready: ${(imageBlob.size / 1024).toFixed(1)} KB | ${(performance.now() - tileStart).toFixed(0)} ms`,
            );
            // Once enough overview tiles have been served (most of which come straight from
            // the prefetched tail), let the ~1 MB tail cache go so it doesn't stay pinned
            // for the lifetime of the viewer when many SZIs are open at the same time.
            this._tilesServed += 1;
            if (
              !this._tailReleased &&
              this._tilesServed >= SziTileSource.RELEASE_TAIL_AFTER_TILES &&
              this._remoteSziFile
            ) {
              this._tailReleased = true;
              this._remoteSziFile.releaseCache();
              this._logger?.info?.(`tail cache released after ${this._tilesServed} tiles`);
            }
            // Turn the blob into an image,
            // When this completes it will trigger finish via the onLoad method of the image
            image.src = (window.URL || window.webkitURL).createObjectURL(imageBlob);
          }
        },
        (error) => {
          resetImageHandlers();
          context.finish(null, null, 'Download failed: ' + error.message);
        },
      );
    };

    /**
     * Provide means of aborting the execution. Intended for use by OSD, not end users!
     *
     * @param {ImageJob} context job, the same object as with downloadTileStart(..)
     * @param {*} [context.userData] - Empty object to attach (and mainly read) your own data.
     */
    downloadTileAbort = (context) => {
      const abortController = context.userData.abortController;
      if (abortController) {
        abortController.abort();
      }
      const image = context.userData.image;
      if (image) {
        image.onload = image.onerror = image.onabort = null;
      }
    };
  }

  OpenSeadragon.SziTileSource = SziTileSource;
};

(function (global, factory) {
  // Skip if currently in ESM mode
  if (typeof exports === 'undefined') {
    return;
  }

  // Check if OpenSeadragon is available
  if (typeof global.OpenSeadragon !== 'undefined') {
    // Attach the SziTileSource to the OpenSeadragon namespace
    factory(global.OpenSeadragon);
  }
})(typeof window !== 'undefined' ? window : this, enableSziTileSource);
