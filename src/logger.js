/**
 * Lightweight leveled logger used by the SZI tile source to give callers visibility into
 * what's happening behind the Range-request abstraction. Three levels:
 *
 *   - 'silent': no output (default; preserves the plugin's previous behaviour)
 *   - 'info':   high-level milestones (bootstrap start/end, DZI dimensions, prefetch hit/miss)
 *   - 'debug':  every HTTP range request and every tile download, with timings and sizes
 *
 * A short label (derived from the SZI url by default) is prefixed to every line so logs from
 * multiple SZIs loaded in parallel can be told apart in the browser console.
 */

const LOG_LEVELS = { silent: 0, info: 1, debug: 2 };

const STYLE_INFO = 'color:#2563eb;font-weight:bold';
const STYLE_DEBUG = 'color:#6b7280';
const STYLE_WARN = 'color:#b45309;font-weight:bold';

function defaultLabelFromUrl(url) {
  try {
    const path = new URL(url, 'http://x/').pathname;
    const last = path.split('/').filter(Boolean).pop() ?? url;
    return last.length > 40 ? `...${last.slice(-37)}` : last;
  } catch {
    return url;
  }
}

export function createLogger(level, label, url) {
  const numLevel = LOG_LEVELS[level] ?? LOG_LEVELS.silent;
  const tag = label ?? (url ? defaultLabelFromUrl(url) : 'szi');
  const prefix = `%c[SZI ${tag}]`;

  const emit = (method, style, msg) => {
    // eslint-disable-next-line no-console
    console[method](`${prefix} ${msg}`, style);
  };

  return {
    label: tag,
    level: numLevel,
    info: (msg) => {
      if (numLevel >= LOG_LEVELS.info) emit('log', STYLE_INFO, msg);
    },
    debug: (msg) => {
      if (numLevel >= LOG_LEVELS.debug) emit('log', STYLE_DEBUG, msg);
    },
    warn: (msg) => {
      if (numLevel >= LOG_LEVELS.info) emit('warn', STYLE_WARN, msg);
    },
  };
}

const noopLogger = {
  label: '',
  level: 0,
  info: () => {},
  debug: () => {},
  warn: () => {},
};

export function resolveLogger(loggerOrOptions, url) {
  if (!loggerOrOptions) return noopLogger;
  if (typeof loggerOrOptions.info === 'function' && typeof loggerOrOptions.debug === 'function') {
    return loggerOrOptions;
  }
  const { logLevel = 'silent', logLabel } = loggerOrOptions;
  if (logLevel === 'silent' || !LOG_LEVELS[logLevel]) return noopLogger;
  return createLogger(logLevel, logLabel, url);
}
