import { LoggerService, LogLevel } from '@nestjs/common';

/**
 * Structured JSON logger for production environments.
 * Outputs one JSON line per log event with consistent schema.
 *
 * Usage:
 *   app = await NestFactory.create(AppModule, { logger: new JsonLoggerService() });
 *
 * Environment:
 *   LOG_FORMAT=json  → JSON output (default in production)
 *   LOG_FORMAT=text  → Passthrough to console (default locally)
 *   LOG_LEVEL=debug|log|warn|error → Minimum level (default: log)
 */
export class JsonLoggerService implements LoggerService {
  private readonly useJson: boolean;
  private readonly minLevel: number;

  private static readonly LEVELS: Record<string, number> = {
    debug: 0,
    verbose: 1,
    log: 2,
    warn: 3,
    error: 4,
  };

  constructor() {
    this.useJson =
      (process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'text')) === 'json';
    const configuredLevel = (process.env.LOG_LEVEL || 'log').toLowerCase();
    this.minLevel = JsonLoggerService.LEVELS[configuredLevel] ?? 2;
  }

  log(message: any, ...optionalParams: any[]) {
    if (this.minLevel > 2) return;
    this.emit('info', message, optionalParams);
  }

  error(message: any, ...optionalParams: any[]) {
    this.emit('error', message, optionalParams);
  }

  warn(message: any, ...optionalParams: any[]) {
    if (this.minLevel > 3) return;
    this.emit('warn', message, optionalParams);
  }

  debug(message: any, ...optionalParams: any[]) {
    if (this.minLevel > 0) return;
    this.emit('debug', message, optionalParams);
  }

  verbose(message: any, ...optionalParams: any[]) {
    if (this.minLevel > 1) return;
    this.emit('verbose', message, optionalParams);
  }

  setLogLevels(_levels: LogLevel[]) {
    // No-op — level controlled by LOG_LEVEL env var
  }

  private emit(level: string, message: any, params: any[]) {
    const context = typeof params[params.length - 1] === 'string' ? params.pop() : undefined;
    const stack = level === 'error' && params.length > 0 ? params[0] : undefined;

    if (!this.useJson) {
      const prefix = context ? `[${context}] ` : '';
      const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      console[method](`${prefix}${message}`);
      if (stack) console[method](stack);
      return;
    }

    const entry: Record<string, any> = {
      timestamp: new Date().toISOString(),
      level,
      message: typeof message === 'string' ? message : JSON.stringify(message),
    };
    if (context) entry.context = context;
    if (stack) entry.stack = typeof stack === 'string' ? stack : String(stack);

    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[method](JSON.stringify(entry));
  }
}
