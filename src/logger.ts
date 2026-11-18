/** One JSON line per event on stderr. stdout stays free for MCP stdio. */
export type LogEvent = { level: 'debug' | 'info' | 'warn' | 'error'; event: string } & Record<string, unknown>;
export type Logger = (e: LogEvent) => void;

const RANK = { debug: 10, info: 20, warn: 25, error: 30, silent: 99 } as const;

export function createLogger(min: 'debug' | 'info' | 'error' | 'silent' = 'info', base: Record<string, unknown> = {}): Logger {
  return (e) => {
    if (RANK[e.level] < RANK[min]) return;
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...base, ...e }) + '\n');
  };
}
