import { defu } from "defu";
import { LogTypes, LogType, LogLevel } from "./constants";
import { isLogObj } from "./utils/index";
import type {
  ConsolaReporter,
  InputLogObject,
  LogObject,
  ConsolaOptions,
} from "./types";
import type { PromptOptions } from "./prompt";

let paused = false;
const queue: any[] = [];

export class Consola {
  options: ConsolaOptions;

  _lastLog: {
    serialized?: string;
    object?: LogObject;
    count?: number;
    time?: Date;
    timeout?: ReturnType<typeof setTimeout>;
  };

  constructor(options: Partial<ConsolaOptions> = {}) {
    // Options
    const types = options.types || LogTypes;
    this.options = defu(
      <ConsolaOptions>{
        ...options,
        defaults: { ...options.defaults },
        level: _normalizeLogLevel(options.level, types),
        reporters: [...(options.reporters || [])],
      },
      <ConsolaOptions>{
        types: LogTypes,
        throttle: 1000,
        throttleMin: 5,
        formatOptions: {
          date: true,
          colors: false,
          compact: true,
        },
      }
    );

    // Create logger functions for current instance
    for (const type in types) {
      const defaults: InputLogObject = {
        type: type as LogType,
        ...this.options.defaults,
        ...types[type as LogType],
      };
      (this as any)[type] = this._wrapLogFn(defaults);
      (this as any)[type].raw = this._wrapLogFn(defaults, true);
    }

    // Use _mockFn if is set
    if (this.options.mockFn) {
      this.mockTypes();
    }

    // Track of last log
    this._lastLog = {};
  }

  get level() {
    return this.options.level;
  }

  set level(level) {
    this.options.level = _normalizeLogLevel(
      level,
      this.options.types,
      this.options.level
    );
  }

  get stdout() {
    // @ts-ignore
    return this._stdout || console._stdout; // eslint-disable-line no-console
  }

  get stderr() {
    // @ts-ignore
    return this._stderr || console._stderr; // eslint-disable-line no-console
  }

  prompt<T extends PromptOptions>(message: string, opts?: T) {
    if (!this.options.prompt) {
      throw new Error("prompt is not supported!");
    }
    return this.options.prompt<any, any, T>(message, opts);
  }

  create(options: Partial<ConsolaOptions>): ConsolaInstance {
    return new Consola({
      ...this.options,
      ...options,
    }) as ConsolaInstance;
  }

  withDefaults(defaults: InputLogObject): ConsolaInstance {
    return this.create({
      ...this.options,
      defaults: {
        ...this.options.defaults,
        ...defaults,
      },
    });
  }

  withTag(tag: string): ConsolaInstance {
    return this.withDefaults({
      tag: this.options.defaults.tag
        ? this.options.defaults.tag + ":" + tag
        : tag,
    });
  }

  addReporter(reporter: ConsolaReporter) {
    this.options.reporters.push(reporter);
    return this;
  }

  removeReporter(reporter: ConsolaReporter) {
    if (reporter) {
      const i = this.options.reporters.indexOf(reporter);
      if (i >= 0) {
        return this.options.reporters.splice(i, 1);
      }
    } else {
      this.options.reporters.splice(0);
    }
    return this;
  }

  setReporters(reporters: ConsolaReporter[]) {
    this.options.reporters = Array.isArray(reporters) ? reporters : [reporters];
    return this;
  }

  wrapAll() {
    this.wrapConsole();
    this.wrapStd();
  }

  restoreAll() {
    this.restoreConsole();
    this.restoreStd();
  }

  wrapConsole() {
    for (const type in this.options.types) {
      // Backup original value
      if (!(console as any)["__" + type]) {
        // eslint-disable-line no-console
        (console as any)["__" + type] = (console as any)[type]; // eslint-disable-line no-console
      }
      // Override
      (console as any)[type] = (this as any)[type].raw; // eslint-disable-line no-console
    }
  }

  restoreConsole() {
    for (const type in this.options.types) {
      // Restore if backup is available
      if ((console as any)["__" + type]) {
        // eslint-disable-line no-console
        (console as any)[type] = (console as any)["__" + type]; // eslint-disable-line no-console
        delete (console as any)["__" + type]; // eslint-disable-line no-console
      }
    }
  }

  wrapStd() {
    this._wrapStream(this.stdout, "log");
    this._wrapStream(this.stderr, "log");
  }

  _wrapStream(stream: NodeJS.WritableStream, type: string) {
    if (!stream) {
      return;
    }

    // Backup original value
    if (!(stream as any).__write) {
      (stream as any).__write = stream.write;
    }

    // Override
    (stream as any).write = (data: any) => {
      (this as any)[type].raw(String(data).trim());
    };
  }

  restoreStd() {
    this._restoreStream(this.stdout);
    this._restoreStream(this.stderr);
  }

  _restoreStream(stream: NodeJS.WritableStream) {
    if (!stream) {
      return;
    }

    if ((stream as any).__write) {
      stream.write = (stream as any).__write;
      delete (stream as any).__write;
    }
  }

  pauseLogs() {
    paused = true;
  }

  resumeLogs() {
    paused = false;

    // Process queue
    const _queue = queue.splice(0);
    for (const item of _queue) {
      item[0]._logFn(item[1], item[2]);
    }
  }

  mockTypes(mockFn?: (type: string, currentType: any) => any) {
    const _mockFn = mockFn || this.options.mockFn;

    if (typeof _mockFn !== "function") {
      return;
    }

    for (const type in this.options.types) {
      (this as any)[type] =
        _mockFn(type as LogType, (this as any)._types[type]) ||
        (this as any)[type];
      (this as any)[type].raw = (this as any)[type];
    }
  }

  _wrapLogFn(defaults: InputLogObject, isRaw?: boolean) {
    return (...args: any[]) => {
      if (paused) {
        queue.push([this, defaults, args, isRaw]);
        return;
      }
      return this._logFn(defaults, args, isRaw);
    };
  }

  _logFn(defaults: InputLogObject, args: any[], isRaw?: boolean) {
    if (((defaults.level as number) || 0) > this.level) {
      return false;
    }

    // Construct a new log object
    const logObj: Partial<LogObject> = {
      date: new Date(),
      args: [],
      ...defaults,
      level: _normalizeLogLevel(defaults.level, this.options.types),
    };

    // Consume arguments
    if (!isRaw && args.length === 1 && isLogObj(args[0])) {
      Object.assign(logObj, args[0]);
    } else {
      logObj.args = [...args];
    }

    // Aliases
    if (logObj.message) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      logObj.args!.unshift(logObj.message);
      delete logObj.message;
    }
    if (logObj.additional) {
      if (!Array.isArray(logObj.additional)) {
        logObj.additional = logObj.additional.split("\n");
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      logObj.args!.push("\n" + logObj.additional.join("\n"));
      delete logObj.additional;
    }

    // Normalize type and tag to lowercase
    logObj.type = (
      typeof logObj.type === "string" ? logObj.type.toLowerCase() : "log"
    ) as LogType;
    logObj.tag = typeof logObj.tag === "string" ? logObj.tag.toLowerCase() : "";

    // Resolve log
    /**
     * @param newLog false if the throttle expired and
     *  we don't want to log a duplicate
     */
    const resolveLog = (newLog = false) => {
      const repeated = (this._lastLog.count || 0) - this.options.throttleMin;
      if (this._lastLog.object && repeated > 0) {
        const args = [...this._lastLog.object.args];
        if (repeated > 1) {
          args.push(`(repeated ${repeated} times)`);
        }
        this._log({ ...this._lastLog.object, args });
        this._lastLog.count = 1;
      }

      // Log
      if (newLog) {
        this._lastLog.object = logObj as LogObject;
        this._log(logObj as LogObject);
      }
    };

    // Throttle
    clearTimeout(this._lastLog.timeout);
    const diffTime =
      this._lastLog.time && logObj.date
        ? logObj.date.getTime() - this._lastLog.time.getTime()
        : 0;
    this._lastLog.time = logObj.date;
    if (diffTime < this.options.throttle) {
      try {
        const serializedLog = JSON.stringify([
          logObj.type,
          logObj.tag,
          logObj.args,
        ]);
        const isSameLog = this._lastLog.serialized === serializedLog;
        this._lastLog.serialized = serializedLog;
        if (isSameLog) {
          this._lastLog.count = (this._lastLog.count || 0) + 1;
          if (this._lastLog.count > this.options.throttleMin) {
            // Auto-resolve when throttle is timed out
            this._lastLog.timeout = setTimeout(
              resolveLog,
              this.options.throttle
            );
            return; // SPAM!
          }
        }
      } catch {
        // Circular References
      }
    }

    resolveLog(true);
  }

  _log(logObj: LogObject) {
    for (const reporter of this.options.reporters) {
      reporter.log(logObj, {
        options: this.options,
      });
    }
  }
}

function _normalizeLogLevel(
  input: LogLevel | LogType | undefined,
  types: any = {},
  defaultLevel = 3
) {
  if (input === undefined) {
    return defaultLevel;
  }
  if (typeof input === "number") {
    return input;
  }
  if (types[input] && types[input].level !== undefined) {
    return types[input].level;
  }
  return defaultLevel;
}

export type ConsolaInstance = Consola &
  Record<LogType, (message: InputLogObject | any, ...args: any[]) => void>;

// Legacy support
// @ts-expect-error
Consola.prototype.add = Consola.prototype.addReporter;
// @ts-expect-error
Consola.prototype.remove = Consola.prototype.removeReporter;
// @ts-expect-error
Consola.prototype.clear = Consola.prototype.removeReporter;
// @ts-expect-error
Consola.prototype.withScope = Consola.prototype.withTag;
// @ts-expect-error
Consola.prototype.mock = Consola.prototype.mockTypes;
// @ts-expect-error
Consola.prototype.pause = Consola.prototype.pauseLogs;
// @ts-expect-error
Consola.prototype.resume = Consola.prototype.resumeLogs;

export function createConsola(
  options: Partial<ConsolaOptions>
): ConsolaInstance {
  return new Consola(options) as ConsolaInstance;
}
