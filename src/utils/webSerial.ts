import { isPercentParam } from '../constants/effectsRegistry';

export const EP2350_USB_VID = 0x2367;
export const EP2350_USB_PID = 0x0620;

export interface SerialPortFilter {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface SerialOptions {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd';
  flowControl?: 'none' | 'hardware';
}

export interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  getInfo?(): SerialPortInfo;
  addEventListener?(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener?(type: string, listener: EventListenerOrEventListenerObject): void;
}

export interface SerialLike {
  requestPort(options?: { filters?: SerialPortFilter[] }): Promise<SerialPortLike>;
  getPorts?(): Promise<SerialPortLike[]>;
  addEventListener?(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener?(type: string, listener: EventListenerOrEventListenerObject): void;
}

interface NavigatorWithSerial {
  serial?: SerialLike;
}

const DEFAULT_THROTTLE_MS = 220;
const REPL_PROMPT = '>>> ';
const CFG_START_MARKER = '__CFG_START__';
const CFG_END_MARKER = '__CFG_END__';

/**
 * Web Serial client for the Teenage Engineering EP-2350 (Ting / FX Mic) MicroPython REPL.
 */
export class Ep2350SerialClient {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopPromise: Promise<void> | null = null;
  private connected = false;
  private rxBuffer = '';
  private promptWaiters: Array<{
    resolve: (text: string) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private commandQueue: Promise<unknown> = Promise.resolve();
  private disconnectListeners = new Set<() => void>();
  private paramTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingParams = new Map<
    string,
    { slot: number; row: number; param: string; value: number; effectType?: string }
  >();
  private lastParamSentAt = new Map<string, number>();
  private readonly throttleMs: number;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  private readonly handlePortDisconnect = () => {
    void this.handleUnexpectedDisconnect();
  };

  constructor(throttleMs = DEFAULT_THROTTLE_MS) {
    this.throttleMs = throttleMs;
  }

  static isSupported(): boolean {
    if (typeof navigator === 'undefined') return false;
    const nav = navigator as NavigatorWithSerial;
    return typeof nav.serial !== 'undefined' && nav.serial !== null;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!Ep2350SerialClient.isSupported()) {
      throw new Error('Web Serial API is not supported in this browser.');
    }

    const nav = navigator as NavigatorWithSerial;
    const port = await nav.serial!.requestPort({
      filters: [{ usbVendorId: EP2350_USB_VID, usbProductId: EP2350_USB_PID }],
    });

    await this.openPort(port);
  }

  async tryAutoConnect(): Promise<boolean> {
    if (this.connected) return true;
    if (!Ep2350SerialClient.isSupported()) return false;

    const nav = navigator as NavigatorWithSerial;
    if (typeof nav.serial?.getPorts !== 'function') return false;

    try {
      const ports = await nav.serial.getPorts();
      const matchingPort = ports.find((p) => {
        const info = p.getInfo?.();
        if (!info || info.usbVendorId === undefined) return true;
        return info.usbVendorId === EP2350_USB_VID && info.usbProductId === EP2350_USB_PID;
      });
      if (!matchingPort) return false;
      await this.openPort(matchingPort);
      return true;
    } catch {
      return false;
    }
  }

  private async openPort(port: SerialPortLike): Promise<void> {
    await port.open({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });

    if (!port.readable || !port.writable) {
      await port.close().catch(() => undefined);
      throw new Error('Serial port streams are unavailable.');
    }

    this.port = port;
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this.connected = true;
    this.rxBuffer = '';

    port.addEventListener?.('disconnect', this.handlePortDisconnect);
    this.readLoopPromise = this.startReadLoop();

    try {
      await this.interruptToRepl();
    } catch (err) {
      await this.disconnect();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.clearPendingParams();
    const wasConnected = this.connected || this.port !== null;
    this.connected = false;

    const port = this.port;
    const reader = this.reader;
    const writer = this.writer;
    this.port = null;
    this.reader = null;
    this.writer = null;

    port?.removeEventListener?.('disconnect', this.handlePortDisconnect);
    this.rejectAllWaiters(new Error('Serial device disconnected.'));

    if (reader) {
      await reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        // Ignore if already released
      }
    }

    if (this.readLoopPromise) {
      await this.readLoopPromise.catch(() => undefined);
      this.readLoopPromise = null;
    }

    if (writer) {
      await writer.close().catch(() => undefined);
      try {
        writer.releaseLock();
      } catch {
        // Ignore if already released
      }
    }

    if (port) {
      await port.close().catch(() => undefined);
    }

    if (wasConnected) {
      this.notifyDisconnect();
    }
  }

  async readConfigJson(): Promise<string> {
    const cmd = `print("${CFG_START_MARKER}" + open('/fat/config.json','r').read() + "${CFG_END_MARKER}")`;
    const output = await this.evalRepl(cmd, 6000);
    const startIdx = output.indexOf(CFG_START_MARKER);
    const endIdx = output.indexOf(CFG_END_MARKER, startIdx + CFG_START_MARKER.length);
    if (startIdx === -1 || endIdx === -1) {
      throw new Error('Failed to read /fat/config.json from EP-2350.');
    }
    return output.slice(startIdx + CFG_START_MARKER.length, endIdx).trim();
  }

  async loadPreset(slot: number): Promise<void> {
    if (!Number.isInteger(slot) || slot < 0 || slot > 3) {
      throw new Error(`Invalid preset slot: ${slot}`);
    }
    await this.evalRepl(`fx.load_preset(${slot})`);
  }

  setParam(
    slot: number,
    row: number,
    param: string,
    value: number,
    effectType?: string
  ): void {
    if (!this.connected) return;
    if (param === 'BUS' || !/^[A-Za-z0-9_-]+$/.test(param)) return;
    if (!Number.isFinite(value)) return;

    const key = `${slot}:${row}:${param}`;
    this.pendingParams.set(key, { slot, row, param, value, effectType });

    const now = Date.now();
    const lastSent = this.lastParamSentAt.get(key) ?? 0;
    const elapsed = now - lastSent;

    if (elapsed >= this.throttleMs && !this.paramTimers.has(key)) {
      this.flushParamKey(key);
      return;
    }

    if (!this.paramTimers.has(key)) {
      const delay = Math.max(0, this.throttleMs - elapsed);
      const timer = setTimeout(() => {
        this.paramTimers.delete(key);
        this.flushParamKey(key);
      }, delay);
      this.paramTimers.set(key, timer);
    }
  }

  async saveConfigJson(jsonStr: string, activeSlot?: number): Promise<void> {
    this.clearPendingParams();
    await this.evalRepl('_f = open("/fat/config.json", "w")');
    const lines = jsonStr.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lineWithNewline = i < lines.length - 1 ? `${lines[i]}\n` : lines[i];
      const escaped = JSON.stringify(lineWithNewline);
      await this.evalRepl(`_f.write(${escaped})`);
    }
    await this.evalRepl('_f.close()');
    await this.evalRepl('import os; os.sync()');
    await this.evalRepl('import teenage; teenage.examine_drive(False)');
    if (activeSlot !== undefined && Number.isInteger(activeSlot) && activeSlot >= 0 && activeSlot <= 3) {
      await this.evalRepl(`fx.load_preset(${activeSlot})`);
    }
  }

  private flushParamKey(key: string): void {
    const entry = this.pendingParams.get(key);
    if (!entry || !this.connected) return;
    this.pendingParams.delete(key);
    this.lastParamSentAt.set(key, Date.now());

    const scaled =
      entry.effectType && isPercentParam(entry.effectType, entry.param)
        ? Math.round((entry.value / 100) * 10000) / 10000
        : entry.value;

    const cmd = `fx.param(${entry.slot}, ${entry.row}, ${JSON.stringify(entry.param)}, ${scaled})`;
    void this.evalRepl(cmd).catch(() => undefined);
  }

  private clearPendingParams(): void {
    for (const timer of this.paramTimers.values()) {
      clearTimeout(timer);
    }
    this.paramTimers.clear();
    this.pendingParams.clear();
  }

  private async interruptToRepl(): Promise<void> {
    return this.enqueueCommand(async () => {
      if (!this.writer) throw new Error('Serial writer unavailable.');
      this.rxBuffer = '';
      const waitPromise = this.waitForPrompt(4000);
      await this.writer.write(this.encoder.encode('\x03\x03\r\n'));
      await waitPromise;
    });
  }

  private evalRepl(cmd: string, timeoutMs = 4000): Promise<string> {
    return this.enqueueCommand(async () => {
      if (!this.connected || !this.writer) {
        throw new Error('Serial device is not connected.');
      }
      this.rxBuffer = '';
      const waitPromise = this.waitForPrompt(timeoutMs);
      await this.writer.write(this.encoder.encode(`${cmd}\r\n`));
      const raw = await waitPromise;
      const promptIdx = raw.lastIndexOf(REPL_PROMPT);
      const body = promptIdx >= 0 ? raw.slice(0, promptIdx) : raw;
      const firstNewline = body.indexOf('\n');
      if (firstNewline >= 0) {
        return body.slice(firstNewline + 1).replace(/\r/g, '').trim();
      }
      return body.replace(/\r/g, '').trim();
    });
  }

  private enqueueCommand<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.commandQueue.then(fn, fn);
    this.commandQueue = next.catch(() => undefined);
    return next;
  }

  private waitForPrompt(timeoutMs: number): Promise<string> {
    if (this.rxBuffer.includes(REPL_PROMPT)) {
      const text = this.rxBuffer;
      this.rxBuffer = '';
      return Promise.resolve(text);
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.promptWaiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.promptWaiters.splice(idx, 1);
        reject(new Error('Timed out waiting for EP-2350 REPL prompt.'));
      }, timeoutMs);

      this.promptWaiters.push({ resolve, reject, timer });
    });
  }

  private async startReadLoop(): Promise<void> {
    try {
      while (this.reader && this.connected) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          this.rxBuffer += this.decoder.decode(value, { stream: true });
          this.resolvePromptWaitersIfReady();
        }
      }
    } catch {
      // Stream closed or errored; disconnect handler cleans up
    } finally {
      if (this.connected) {
        await this.handleUnexpectedDisconnect();
      }
    }
  }

  private resolvePromptWaitersIfReady(): void {
    if (!this.rxBuffer.includes(REPL_PROMPT) || this.promptWaiters.length === 0) {
      return;
    }
    const text = this.rxBuffer;
    this.rxBuffer = '';
    const waiter = this.promptWaiters.shift()!;
    clearTimeout(waiter.timer);
    waiter.resolve(text);
  }

  private rejectAllWaiters(err: Error): void {
    while (this.promptWaiters.length > 0) {
      const waiter = this.promptWaiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  private async handleUnexpectedDisconnect(): Promise<void> {
    if (!this.connected && this.port === null) return;
    await this.disconnect();
  }

  private notifyDisconnect(): void {
    for (const listener of this.disconnectListeners) {
      try {
        listener();
      } catch {
        // Ignore listener errors
      }
    }
  }
}

export const ep2350Serial = new Ep2350SerialClient();
