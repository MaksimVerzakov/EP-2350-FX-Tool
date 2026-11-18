import { isPercentParam } from '../constants/effectsRegistry';
import type { DeviceDisk } from './samples';

const DSK_START_MARKER = '__DSK_START__';
const DSK_END_MARKER = '__DSK_END__';
const LD_MARKER = '__LD_OK__:';
/** Raw bytes per REPL line when sending a file (base64 makes it 4/3 longer). */
export const SERIAL_FILE_CHUNK_BYTES = 768;

/** Python helper run once per load: spl.load_wav with duck (firmware 1.0.9+), else without; ROM on failure. */
const LIVE_SAMPLE_LOADER = [
  'def _ep_ld(p, f, m, d):',
  '    import spl',
  "    g = open(f, 'rb')",
  '    try:',
  '        try:',
  '            ok = spl.load_wav(p, g, m, d)',
  '        except TypeError:',
  '            ok = spl.load_wav(p, g, m)',
  '    finally:',
  '        g.close()',
  '    if not ok:',
  '        spl.rom(p)',
  '    return bool(ok)'
].join('\n');

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}


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

export interface SerialOutputSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  break?: boolean;
}

export interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  getInfo?(): SerialPortInfo;
  setSignals?(signals: SerialOutputSignals): Promise<void>;
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

interface PromptWaiter {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  requiredMarker?: string;
}

const DEFAULT_THROTTLE_MS = 220;
const DEFAULT_POLL_INTERVAL_MS = 250;
const REPL_PROMPT = '>>> ';
const CFG_START_MARKER = '__CFG_START__';
const CFG_END_MARKER = '__CFG_END__';
const SLOT_MARKER_PREFIX = '__EP_SLOT__:';

/**
 * Web Serial client for the Teenage Engineering EP-2350 (Ting / FX Mic) MicroPython REPL.
 */
export class Ep2350SerialClient {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopPromise: Promise<void> | null = null;
  private connectingPromise: Promise<void> | null = null;
  private connected = false;
  private rxBuffer = '';
  private promptWaiters: PromptWaiter[] = [];
  private commandQueue: Promise<unknown> = Promise.resolve();
  private disconnectListeners = new Set<() => void>();
  private presetSlotListeners = new Set<(slot: number) => void>();
  private sampleSlotListeners = new Set<(slot: number) => void>();
  private paramTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingParams = new Map<
    string,
    { slot: number; row: number; param: string; value: number; effectType?: string }
  >();
  private lastParamSentAt = new Map<string, number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private pollPausedUntil = 0;
  private lastKnownFxSlot: number | null = null;
  private lastKnownSamSlot: number | null = null;
  private readonly throttleMs: number;
  private readonly pollIntervalMs: number;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  private readonly handlePortDisconnect = () => {
    void this.handleUnexpectedDisconnect();
  };

  constructor(throttleMs = DEFAULT_THROTTLE_MS, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
    this.throttleMs = throttleMs;
    this.pollIntervalMs = pollIntervalMs;
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

  onPresetSlotChange(listener: (slot: number) => void): () => void {
    this.presetSlotListeners.add(listener);
    return () => {
      this.presetSlotListeners.delete(listener);
    };
  }

  onSampleSlotChange(listener: (slot: number) => void): () => void {
    this.sampleSlotListeners.add(listener);
    return () => {
      this.sampleSlotListeners.delete(listener);
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectingPromise) return this.connectingPromise;
    if (!Ep2350SerialClient.isSupported()) {
      throw new Error('Web Serial API is not supported in this browser.');
    }

    const nav = navigator as NavigatorWithSerial;
    const port = await nav.serial!.requestPort({
      filters: [{ usbVendorId: EP2350_USB_VID, usbProductId: EP2350_USB_PID }],
    });

    this.connectingPromise = this.openPort(port).finally(() => {
      this.connectingPromise = null;
    });
    return this.connectingPromise;
  }

  async tryAutoConnect(): Promise<boolean> {
    if (this.connected || this.connectingPromise) return false;
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
      this.connectingPromise = this.openPort(matchingPort).finally(() => {
        this.connectingPromise = null;
      });
      await this.connectingPromise;
      return true;
    } catch {
      return false;
    }
  }

  private async openPort(port: SerialPortLike): Promise<void> {
    try {
      await port.open({
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const msg = err instanceof Error ? err.message : String(err);
      if (
        name === 'InvalidStateError' ||
        name === 'NetworkError' ||
        /already open|failed to open|busy|in use|access denied/i.test(msg)
      ) {
        throw new Error(
          'EP-2350 USB serial port is already open in another tab, browser, or application. Close the other connection and try again.'
        );
      }
      throw err;
    }

    await port
      .setSignals?.({ dataTerminalReady: true, requestToSend: true })
      .catch(() => undefined);

    if (!port.readable || !port.writable) {
      await port.close().catch(() => undefined);
      throw new Error('Serial port streams are unavailable.');
    }

    this.port = port;
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this.connected = true;
    this.rxBuffer = '';
    this.commandQueue = Promise.resolve();
    this.lastKnownFxSlot = null;
    this.lastKnownSamSlot = null;

    port.addEventListener?.('disconnect', this.handlePortDisconnect);
    this.readLoopPromise = this.startReadLoop();

    try {
      await this.interruptToRepl();
      this.startSlotPolling();
    } catch (err) {
      await this.disconnect();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.stopSlotPolling();
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
    this.pausePolling(1000);
    // Split marker literals in Python so the echoed REPL command never contains the contiguous markers
    const cmd = 'print("__CFG_" + "START__" + open("/fat/config.json", "r").read() + "__CFG_" + "END__")';
    const raw = await this.evalReplRaw(cmd, 8000, CFG_END_MARKER);
    const startIdx = raw.indexOf(CFG_START_MARKER);
    const endIdx = raw.indexOf(CFG_END_MARKER, startIdx + CFG_START_MARKER.length);
    if (startIdx === -1 || endIdx === -1) {
      throw new Error('Failed to read /fat/config.json from EP-2350.');
    }
    return raw.slice(startIdx + CFG_START_MARKER.length, endIdx).trim();
  }

  async loadPreset(slot: number): Promise<void> {
    if (!Number.isInteger(slot) || slot < -1 || slot > 3) {
      throw new Error(`Invalid preset slot: ${slot}`);
    }
    this.lastKnownFxSlot = slot;
    this.pausePolling(600);
    await this.evalRepl(
      `fx_pos = ${slot}; (setattr(teenage, 'fx_pos', ${slot}) if 'teenage' in globals() else None); fx.load_preset(${slot}); import ui; ui.leds(${slot}, teenage.sam_pos if 'teenage' in globals() else globals().get('sam_pos', 0))`
    );
  }

  async selectSampleSlot(slot: number): Promise<void> {
    if (!Number.isInteger(slot) || slot < 0 || slot > 3) {
      throw new Error(`Invalid sample slot: ${slot}`);
    }
    this.lastKnownSamSlot = slot;
    this.pausePolling(600);
    await this.evalRepl(
      `sam_pos = ${slot}; (setattr(teenage, 'sam_pos', ${slot}) if 'teenage' in globals() else None); import ui; ui.leds(teenage.fx_pos if 'teenage' in globals() else globals().get('fx_pos', -1), ${slot})`
    );
  }

  async pollHardwareSlot(): Promise<{ fxSlot: number; samSlot: number } | null> {
    if (!this.connected) return null;
    const cmd =
      '(ui.callback(python_callback) if "python_callback" in globals() and "ui" in globals() else None); print("__EP_" + "SLOT__:" + str(globals().get("fx_pos", -1)) + ":" + str(globals().get("sam_pos", 0)))';
    const raw = await this.evalReplRaw(cmd, 1500, SLOT_MARKER_PREFIX);
    const idx = raw.indexOf(SLOT_MARKER_PREFIX);
    if (idx === -1) return null;
    const after = raw.slice(idx + SLOT_MARKER_PREFIX.length);
    const match = after.match(/^(-?\d+):(-?\d+)/);
    if (!match) return null;
    const fxSlot = Number.parseInt(match[1], 10);
    const samSlot = Number.parseInt(match[2], 10);

    if (Number.isInteger(fxSlot) && fxSlot >= -1 && fxSlot <= 3) {
      const prevFx = this.lastKnownFxSlot;
      this.lastKnownFxSlot = fxSlot;
      if (fxSlot !== prevFx) {
        this.notifyPresetSlotChange(fxSlot);
      }
    }

    if (Number.isInteger(samSlot) && samSlot >= 0 && samSlot <= 3) {
      const prevSam = this.lastKnownSamSlot;
      this.lastKnownSamSlot = samSlot;
      if (samSlot !== prevSam) {
        this.notifySampleSlotChange(samSlot);
      }
    }

    return { fxSlot, samSlot };
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

    this.pausePolling(600);
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
    this.pausePolling(15000);
    this.clearPendingParams();
    await this.evalRepl('_f = open("/fat/config.json", "w")');
    try {
      const CHUNK_SIZE = 512;
      for (let i = 0; i < jsonStr.length; i += CHUNK_SIZE) {
        const chunk = jsonStr.slice(i, i + CHUNK_SIZE);
        const escaped = JSON.stringify(chunk);
        await this.evalRepl(`_f.write(${escaped})`);
      }
    } finally {
      await this.evalRepl('_f.close()').catch(() => undefined);
    }
    await this.evalRepl('import os; os.sync()');
    if (activeSlot !== undefined && Number.isInteger(activeSlot) && activeSlot >= -1 && activeSlot <= 3) {
      await this.loadPreset(activeSlot);
    }
  }

  /** Free space and files on the mic's disk (`os.statvfs` / `os.listdir` of /fat). */
  async readDiskInfo(): Promise<DeviceDisk> {
    this.pausePolling(3000);
    // Split marker literals so the echoed command never contains the contiguous markers
    const cmd =
      'import os, json; _s = os.statvfs("/fat"); print("__DSK_" + "START__" + json.dumps({"b": _s[0], "t": _s[2], "f": _s[3], "files": [[_n, os.stat("/fat/" + _n)[6]] for _n in os.listdir("/fat")]}) + "__DSK_" + "END__")';
    const raw = await this.evalReplRaw(cmd, 6000, DSK_END_MARKER);
    const start = raw.indexOf(DSK_START_MARKER);
    const end = raw.indexOf(DSK_END_MARKER, start + DSK_START_MARKER.length);
    if (start === -1 || end === -1) throw new Error("Could not read the mic's disk.");
    const data = JSON.parse(raw.slice(start + DSK_START_MARKER.length, end)) as {
      b: number;
      t: number;
      f: number;
      files: Array<[string, number]>;
    };
    return {
      blockSize: data.b,
      totalBlocks: data.t,
      freeBlocks: data.f,
      files: data.files.map(([name, size]) => ({ name, size }))
    };
  }

  /**
   * Write `bytes` to /fat/<name> over the REPL, as base64 chunks into a temporary file that is
   * renamed when complete, so an interrupted transfer never leaves a half-written file under the
   * real name. The old file is removed first, so no extra room is needed.
   */
  async writeFile(name: string, bytes: Uint8Array, onProgress?: (sent: number, total: number) => void): Promise<void> {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || name.startsWith('.')) {
      throw new Error(`Unsafe file name: ${name}`);
    }
    const path = JSON.stringify(`/fat/${name}`);
    const tmp = JSON.stringify(`/fat/${name}.part`);
    this.pausePolling(60000);
    this.clearPendingParams();
    await this.evalRepl(
      `import os, binascii; _ls = os.listdir("/fat"); (os.remove(${path}) if ${JSON.stringify(name)} in _ls else None); (os.remove(${tmp}) if ${JSON.stringify(`${name}.part`)} in _ls else None); _w = open(${tmp}, "wb")`
    );
    let ok = false;
    try {
      for (let i = 0; i < bytes.length; i += SERIAL_FILE_CHUNK_BYTES) {
        const chunk = bytes.subarray(i, Math.min(bytes.length, i + SERIAL_FILE_CHUNK_BYTES));
        this.pausePolling(60000);
        await this.evalRepl(`_w.write(binascii.a2b_base64("${toBase64(chunk)}"))`, 8000);
        onProgress?.(Math.min(bytes.length, i + SERIAL_FILE_CHUNK_BYTES), bytes.length);
      }
      ok = true;
    } finally {
      await this.evalRepl('_w.close()').catch(() => undefined);
      if (!ok) await this.evalRepl(`import os; os.remove(${tmp})`).catch(() => undefined);
    }
    await this.evalRepl(`import os; os.rename(${tmp}, ${path}); os.sync()`);
  }

  /**
   * Load samples into the mic's slots now, the way the firmware does on start (spl.load_wav with
   * playmode and duck, falling back to the 3-argument form of firmware before 1.0.9; spl.rom for
   * factory slots). It does not remount the disk, so the computer sees no unsafe eject.
   * Returns, per slot given, whether its WAV loaded.
   */
  async loadSamplesLive(
    slots: Array<{ pos: number; file?: string; playmode?: string; duck?: number }>
  ): Promise<boolean[]> {
    this.pausePolling(15000);
    await this.evalRepl(`exec(${JSON.stringify(LIVE_SAMPLE_LOADER)})`);
    const results: boolean[] = [];
    for (const s of slots) {
      if (!Number.isInteger(s.pos) || s.pos < 0 || s.pos > 3) throw new Error(`Invalid sample slot: ${s.pos}`);
      if (!s.file) {
        await this.evalRepl(`import spl; spl.rom(${s.pos})`);
        results.push(true);
        continue;
      }
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(s.file)) throw new Error(`Unsafe file name: ${s.file}`);
      const mode = ['oneshot', 'hold', 'startstop'].includes(s.playmode ?? '') ? s.playmode! : 'oneshot';
      const duck = Number.isFinite(s.duck) ? Math.max(0, Math.min(1, s.duck!)) : 0;
      const out = await this.evalReplRaw(
        `print("__LD_" + "OK__:" + str(_ep_ld(${s.pos}, ${JSON.stringify(`/fat/${s.file}`)}, ${JSON.stringify(mode)}, ${duck})))`,
        8000,
        LD_MARKER
      );
      results.push(out.includes(`${LD_MARKER}True`));
    }
    return results;
  }

  private startSlotPolling(): void {
    this.stopSlotPolling();
    if (this.pollIntervalMs <= 0) return;
    this.pollTimer = setInterval(() => {
      if (
        !this.connected ||
        this.isPolling ||
        this.promptWaiters.length > 0 ||
        this.pendingParams.size > 0 ||
        Date.now() < this.pollPausedUntil
      ) {
        return;
      }
      this.isPolling = true;
      void this.pollHardwareSlot()
        .catch(() => undefined)
        .finally(() => {
          this.isPolling = false;
        });
    }, this.pollIntervalMs);
  }

  private stopSlotPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isPolling = false;
  }

  private pausePolling(durationMs: number): void {
    const until = Date.now() + durationMs;
    if (until > this.pollPausedUntil) {
      this.pollPausedUntil = until;
    }
  }

  private flushParamKey(key: string): void {
    const entry = this.pendingParams.get(key);
    if (!entry || !this.connected) return;
    this.pendingParams.delete(key);
    this.lastParamSentAt.set(key, Date.now());
    this.pausePolling(600);

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

      // Step 1: First Ctrl+C to interrupt any running program
      this.rxBuffer = '';
      const p1 = this.waitForPrompt(250).catch(() => '');
      await this.writer.write(this.encoder.encode('\x03'));
      await p1;

      // Step 2: Second Ctrl+C to exit any nested input/continuation prompt
      this.rxBuffer = '';
      const p2 = this.waitForPrompt(200).catch(() => '');
      await this.writer.write(this.encoder.encode('\x03'));
      await p2;

      // Step 3: Send CRLF and wait for a clean fresh REPL prompt
      this.rxBuffer = '';
      const p3 = this.waitForPrompt(4000);
      await this.writer.write(this.encoder.encode('\r\n'));
      await p3;

      // Clear any trailing prompt bytes before normal commands run
      this.rxBuffer = '';
    });
  }

  private evalRepl(cmd: string, timeoutMs = 4000): Promise<string> {
    return this.evalReplRaw(cmd, timeoutMs).then((raw) => {
      const promptIdx = raw.lastIndexOf(REPL_PROMPT);
      const body = promptIdx >= 0 ? raw.slice(0, promptIdx) : raw;
      const firstNewline = body.indexOf('\n');
      const output = (firstNewline >= 0 ? body.slice(firstNewline + 1) : body).replace(/\r/g, '').trim();
      if (
        output.includes('Traceback (most recent call last):') ||
        /^(SyntaxError|OSError|NameError|ValueError|TypeError|MemoryError):/m.test(output)
      ) {
        throw new Error(`EP-2350 REPL error: ${output}`);
      }
      return output;
    });
  }

  private evalReplRaw(
    cmd: string,
    timeoutMs = 4000,
    requiredMarker?: string
  ): Promise<string> {
    return this.enqueueCommand(async () => {
      if (!this.connected || !this.writer) {
        throw new Error('Serial device is not connected.');
      }
      this.rxBuffer = '';
      const waitPromise = this.waitForPrompt(timeoutMs, requiredMarker);
      await this.writer.write(this.encoder.encode(`${cmd}\r\n`));
      return waitPromise;
    });
  }

  private enqueueCommand<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.commandQueue.then(fn, fn);
    this.commandQueue = next.catch(() => undefined);
    return next;
  }

  private isBufferReadyForWaiter(requiredMarker?: string): boolean {
    if (!this.rxBuffer.includes(REPL_PROMPT)) {
      return false;
    }
    if (!requiredMarker) {
      return true;
    }
    if (this.rxBuffer.includes('Traceback (most recent call last):')) {
      const tbIdx = this.rxBuffer.indexOf('Traceback (most recent call last):');
      return this.rxBuffer.indexOf(REPL_PROMPT, tbIdx) !== -1;
    }
    const markerIdx = this.rxBuffer.indexOf(requiredMarker);
    if (markerIdx === -1) {
      return false;
    }
    return this.rxBuffer.indexOf(REPL_PROMPT, markerIdx + requiredMarker.length) !== -1;
  }

  private waitForPrompt(timeoutMs: number, requiredMarker?: string): Promise<string> {
    if (this.isBufferReadyForWaiter(requiredMarker)) {
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

      this.promptWaiters.push({ resolve, reject, timer, requiredMarker });
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
    if (this.promptWaiters.length === 0) {
      return;
    }
    const head = this.promptWaiters[0];
    if (!this.isBufferReadyForWaiter(head.requiredMarker)) {
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

  private notifyPresetSlotChange(slot: number): void {
    for (const listener of this.presetSlotListeners) {
      try {
        listener(slot);
      } catch {
        // Ignore listener errors
      }
    }
  }

  private notifySampleSlotChange(slot: number): void {
    for (const listener of this.sampleSlotListeners) {
      try {
        listener(slot);
      } catch {
        // Ignore listener errors
      }
    }
  }
}

export const ep2350Serial = new Ep2350SerialClient();
