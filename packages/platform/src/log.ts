type Level = "debug" | "info" | "warn" | "error";
type Fields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** A logger that adds `fields` to every line, e.g. the correlation ID of a request. */
  with(fields: Fields): Logger;
}

export type LogSink = (line: string) => void;

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * One JSON object per line, so CloudWatch Logs Insights can query every field.
 * Never log request bodies or patient data; log identifiers.
 */
export function createLogger(options: { level?: Level; sink?: LogSink; base?: Fields } = {}): Logger {
  const minimum = order[options.level ?? "info"];
  const sink: LogSink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
  const base = options.base ?? {};

  const write = (level: Level, message: string, fields: Fields = {}): void => {
    if (order[level] < minimum) return;
    sink(JSON.stringify({ time: new Date().toISOString(), level, message, ...base, ...fields }, errorReplacer));
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    with: (fields) => createLogger({ level: options.level ?? "info", sink, base: { ...base, ...fields } }),
  };
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}
