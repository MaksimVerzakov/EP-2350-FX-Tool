export interface LockLike {
  request<T>(
    name: string,
    optionsOrCallback:
      | { ifAvailable?: boolean; mode?: 'exclusive' | 'shared'; signal?: AbortSignal }
      | ((lock: unknown) => Promise<T> | T),
    callback?: (lock: unknown) => Promise<T> | T
  ): Promise<T>;
}

export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface WindowLifecycleLike {
  addEventListener?: (type: string, listener: (event?: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event?: unknown) => void) => void;
}

export interface MultiTabGuardOptions {
  lockName?: string;
  channelName?: string;
  locks?: LockLike | null;
  createBroadcastChannel?: ((name: string) => BroadcastChannelLike) | null;
  win?: WindowLifecycleLike | null;
  probeDelayMs?: number;
  onBlockedChange: (blocked: boolean) => void;
}

export interface MultiTabGuardHandle {
  cleanup: () => void;
  ready: Promise<void>;
}

const DEFAULT_LOCK_NAME = 'ep2350-fx-tool-tab-lock';
const DEFAULT_CHANNEL_NAME = 'ep2350-fx-tool-tab-channel';
const DEFAULT_PROBE_DELAY_MS = 25;

// Track cleanup promises ONLY for already-disposed guards on a given LockManager so
// React StrictMode unmount -> immediate remount waits for the same-realm release
// without serializing separate active tabs.
const disposedLockReleases = new WeakMap<object, Promise<void>>();

let tabSeq = 0;
function makeTabId(): string {
  tabSeq += 1;
  return `tab-${Date.now()}-${tabSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Acquires a single-active-tab guard across browser tabs of the same origin.
 * Uses Web Locks (`navigator.locks`) when available for crash-safe exclusivity,
 * and falls back to `BroadcastChannel` election in environments without Web Locks.
 */
export function createMultiTabGuard(options: MultiTabGuardOptions): MultiTabGuardHandle {
  const lockName = options.lockName ?? DEFAULT_LOCK_NAME;
  const channelName = options.channelName ?? DEFAULT_CHANNEL_NAME;
  const probeDelayMs = options.probeDelayMs ?? DEFAULT_PROBE_DELAY_MS;

  const resolvedLocks: LockLike | null =
    options.locks !== undefined
      ? options.locks
      : typeof navigator !== 'undefined' && navigator.locks
      ? (navigator.locks as unknown as LockLike)
      : null;

  const resolvedCreateChannel: ((name: string) => BroadcastChannelLike) | null =
    options.createBroadcastChannel !== undefined
      ? options.createBroadcastChannel
      : typeof BroadcastChannel !== 'undefined'
      ? (name: string) => new BroadcastChannel(name) as unknown as BroadcastChannelLike
      : null;

  const resolvedWin: WindowLifecycleLike | null =
    options.win !== undefined
      ? options.win
      : typeof window !== 'undefined'
      ? (window as unknown as WindowLifecycleLike)
      : null;

  let disposed = false;
  let lastBlocked: boolean | null = null;
  let readyResolved = false;
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const finishReady = () => {
    if (!readyResolved) {
      readyResolved = true;
      resolveReady?.();
    }
  };

  const notifyBlocked = (blocked: boolean) => {
    if (disposed) return;
    if (lastBlocked !== blocked) {
      lastBlocked = blocked;
      options.onBlockedChange(blocked);
    }
    finishReady();
  };

  let stopActiveImpl: () => void = () => {};

  const startBroadcastImpl = (createChannel: (name: string) => BroadcastChannelLike) => {
    const tabId = makeTabId();
    const createdAt = Date.now();
    const channel = createChannel(channelName);
    let isLeader = false;
    let probeTimer: ReturnType<typeof setTimeout> | null = null;
    const waitingPeers = new Map<string, number>();

    const clearProbe = () => {
      if (probeTimer !== null) {
        clearTimeout(probeTimer);
        probeTimer = null;
      }
    };

    const promoteToLeader = () => {
      if (disposed) return;
      clearProbe();
      isLeader = true;
      try {
        channel.postMessage({ type: 'LEADER_ACTIVE', tabId });
      } catch {
        // Ignore closed channel
      }
      notifyBlocked(false);
    };

    const runProbe = () => {
      clearProbe();
      waitingPeers.clear();
      try {
        channel.postMessage({ type: 'HELLO', tabId, createdAt });
      } catch {
        promoteToLeader();
        return;
      }
      probeTimer = setTimeout(() => {
        if (disposed || isLeader) return;
        // Elect earliest waiting peer if multiple tabs are racing
        let earliestId = tabId;
        let earliestTs = createdAt;
        for (const [peerId, peerTs] of waitingPeers.entries()) {
          if (peerTs < earliestTs || (peerTs === earliestTs && peerId < earliestId)) {
            earliestId = peerId;
            earliestTs = peerTs;
          }
        }
        if (earliestId === tabId) {
          promoteToLeader();
        }
      }, probeDelayMs);
    };

    channel.onmessage = (event) => {
      if (disposed) return;
      const msg = event?.data as { type?: string; tabId?: string; createdAt?: number } | undefined;
      if (!msg || !msg.tabId || msg.tabId === tabId) return;

      if (msg.type === 'HELLO') {
        if (isLeader) {
          try {
            channel.postMessage({ type: 'LEADER_ACTIVE', tabId });
          } catch {
            // Ignore
          }
        } else if (typeof msg.createdAt === 'number') {
          waitingPeers.set(msg.tabId, msg.createdAt);
        }
      } else if (msg.type === 'LEADER_ACTIVE') {
        clearProbe();
        isLeader = false;
        notifyBlocked(true);
      } else if (msg.type === 'BYE') {
        waitingPeers.delete(msg.tabId);
        if (!isLeader) {
          runProbe();
        }
      }
    };

    runProbe();

    return () => {
      clearProbe();
      try {
        channel.postMessage({ type: 'BYE', tabId });
      } catch {
        // Ignore already-closed channel
      }
      try {
        channel.close();
      } catch {
        // Ignore
      }
    };
  };

  if (resolvedLocks) {
    // Hold-check via Promise wrapper so `notifyBlocked` happens cleanly without waiting
    // an arbitrary timer when locks.request resolves in a microtask.
    stopActiveImpl = startLocksWithImmediateCheck(
      resolvedLocks,
      lockName,
      () => disposed,
      notifyBlocked,
      finishReady
    );
  } else if (resolvedCreateChannel) {
    stopActiveImpl = startBroadcastImpl(resolvedCreateChannel);
  } else {
    notifyBlocked(false);
  }

  const handlePageHide = () => {
    cleanup();
  };

  const handlePageShow = (event?: unknown) => {
    const persisted = Boolean((event as { persisted?: boolean } | undefined)?.persisted);
    if (persisted && disposed) {
      disposed = false;
      lastBlocked = null;
      if (resolvedLocks) {
        stopActiveImpl = startLocksWithImmediateCheck(
          resolvedLocks,
          lockName,
          () => disposed,
          notifyBlocked,
          finishReady
        );
      } else if (resolvedCreateChannel) {
        stopActiveImpl = startBroadcastImpl(resolvedCreateChannel);
      }
    }
  };

  resolvedWin?.addEventListener?.('pagehide', handlePageHide);
  resolvedWin?.addEventListener?.('pageshow', handlePageShow);

  function cleanup() {
    if (disposed) return;
    disposed = true;
    resolvedWin?.removeEventListener?.('pagehide', handlePageHide);
    resolvedWin?.removeEventListener?.('pageshow', handlePageShow);
    stopActiveImpl();
    finishReady();
  }

  return { cleanup, ready };
}

function startLocksWithImmediateCheck(
  locks: LockLike,
  lockName: string,
  isDisposed: () => boolean,
  notifyBlocked: (blocked: boolean) => void,
  finishReady: () => void
): () => void {
  let releaseHold: (() => void) | null = null;
  let holdAbortController: AbortController | null =
    typeof AbortController !== 'undefined' ? new AbortController() : null;
  let currentLockPromise: Promise<void> = Promise.resolve();

  const holdForever = () =>
    new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

  const acquireQueued = () => {
    if (isDisposed()) return;
    holdAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const reqOpts = holdAbortController
      ? { mode: 'exclusive' as const, signal: holdAbortController.signal }
      : { mode: 'exclusive' as const };

    currentLockPromise = locks
      .request(lockName, reqOpts, async (lock) => {
        if (isDisposed() || !lock) return;
        notifyBlocked(false);
        await holdForever();
      })
      .catch(() => undefined);
  };

  const run = async () => {
    const prevRelease = disposedLockReleases.get(locks);
    if (prevRelease) {
      await prevRelease.catch(() => undefined);
    }
    if (isDisposed()) {
      finishReady();
      return;
    }

    let checkDoneResolve: (() => void) | null = null;
    const checkDone = new Promise<void>((resolve) => {
      checkDoneResolve = resolve;
    });
    let granted = false;

    try {
      currentLockPromise = locks
        .request(lockName, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
          granted = Boolean(lock);
          checkDoneResolve?.();
          if (!lock || isDisposed()) {
            return;
          }
          notifyBlocked(false);
          await holdForever();
        })
        .catch(() => {
          checkDoneResolve?.();
        });

      await checkDone;
      if (isDisposed()) {
        finishReady();
        return;
      }
      if (!granted) {
        notifyBlocked(true);
        acquireQueued();
      }
    } catch {
      notifyBlocked(false);
    }
  };

  void run();

  return () => {
    releaseHold?.();
    releaseHold = null;
    try {
      holdAbortController?.abort();
    } catch {
      // Ignore abort errors on teardown
    }
    const prev = disposedLockReleases.get(locks) ?? Promise.resolve();
    const tail = prev
      .catch(() => undefined)
      .then(() => currentLockPromise.catch(() => undefined));
    disposedLockReleases.set(locks, tail);
  };
}
