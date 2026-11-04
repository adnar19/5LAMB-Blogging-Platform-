const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const threshold = () => LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

export const serializeError = (err) =>
  err instanceof Error
    ? { name: err.name, message: err.message, stack: err.stack }
    : { message: String(err) };

const write = (level, message, extra = {}) => {
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({ level, message, ...extra });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export const logger = {
  debug: (message, extra) => write('debug', message, extra),
  info: (message, extra) => write('info', message, extra),
  warn: (message, extra) => write('warn', message, extra),
  error: (message, extra) => write('error', message, extra),
};
