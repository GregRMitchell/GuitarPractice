type Callback = ((event: Event) => void) | null;
interface RequestFake {
  result: unknown;
  error: DOMException | null;
  onsuccess: Callback;
  onerror: Callback;
}

function request(): RequestFake {
  return { result: undefined, error: null, onsuccess: null, onerror: null };
}

/** Small asynchronous IndexedDB boundary fake with serialized atomic transactions. */
export class HistoryIDBFake {
  records = new Map<string, unknown>();
  version = 0;
  keyPath: string | null = 'id';
  uniqueStore = true;
  blocked = false;
  openError: DOMException | null = null;
  failWriteAt: number | null = null;
  failTransaction = false;
  writes = 0;
  openedName: string | undefined;
  openedVersion: number | undefined;
  private queue: (() => void)[] = [];
  private busy = false;

  readonly factory = {
    open: (name: string, version: number): IDBOpenDBRequest => {
      this.openedName = name;
      this.openedVersion = version;
      const req = Object.assign(request(), {
        onupgradeneeded: null as Callback,
        onblocked: null as Callback,
        transaction: null as unknown,
      });
      setTimeout(() => {
        if (this.blocked) {
          req.onblocked?.(new Event('blocked'));
          return;
        }
        if (this.openError) {
          req.error = this.openError;
          req.onerror?.(new Event('error'));
          return;
        }
        let upgraded = false;
        let aborted = false;
        const database = this.database();
        req.result = database;
        if (this.version === 0) {
          req.transaction = { abort: (): void => { aborted = true; } };
          req.onupgradeneeded?.(Object.assign(new Event('upgradeneeded'), { oldVersion: 0 }));
          upgraded = true;
        }
        if (aborted) {
          req.error = new DOMException('Aborted', 'AbortError');
          req.onerror?.(new Event('error'));
        } else {
          if (upgraded) this.version = 1;
          req.onsuccess?.(new Event('success'));
        }
      }, 0);
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;

  private enqueue(begin: () => void): void {
    this.queue.push(begin);
    this.next();
  }

  private next(): void {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    setTimeout(this.queue.shift()!, 0);
  }

  private database(): object {
    let closed = false;
    return {
      objectStoreNames: { contains: (name: string): boolean => this.uniqueStore && name === 'sessions' },
      close: (): void => { closed = true; },
      onversionchange: null,
      createObjectStore: (): void => { this.uniqueStore = true; },
      transaction: (_name: string, mode: IDBTransactionMode = 'readonly'): object => {
        if (closed) throw new DOMException('Closed', 'InvalidStateError');
        if (this.failTransaction) throw new DOMException('Unavailable', 'UnknownError');
        return this.transaction(mode);
      },
    };
  }

  private transaction(mode: IDBTransactionMode): object {
    let active = false;
    let finished = false;
    let snapshot = new Map<string, unknown>();
    const operations: (() => void)[] = [];
    const tx = {
      error: null as DOMException | null,
      oncomplete: null as Callback,
      onabort: null as Callback,
      onerror: null as Callback,
      abort: (): void => {
        if (finished) throw new DOMException('Inactive', 'InvalidStateError');
        finish(false);
      },
      objectStore: (): object => store,
    };
    const finish = (commit: boolean): void => {
      if (finished) return;
      finished = true;
      if (commit && mode === 'readwrite') this.records = snapshot;
      if (commit) tx.oncomplete?.(new Event('complete'));
      else tx.onabort?.(new Event('abort'));
      this.busy = false;
      this.next();
    };
    const pump = (): void => {
      if (!active || finished) return;
      const operation = operations.shift();
      if (!operation) {
        finish(true);
        return;
      }
      operation();
      setTimeout(pump, 0);
    };
    const store = {
      keyPath: this.keyPath,
      autoIncrement: false,
      getAll: (): IDBRequest => {
        const req = request();
        operations.push(() => {
          req.result = structuredClone([...snapshot.values()]);
          req.onsuccess?.(new Event('success'));
        });
        return req as unknown as IDBRequest;
      },
      add: (value: { id: string }): IDBRequest => {
        const req = request();
        operations.push(() => {
          this.writes++;
          if (this.failWriteAt === this.writes || snapshot.has(value.id)) {
            const name = this.failWriteAt === this.writes ? 'QuotaExceededError' : 'ConstraintError';
            req.error = new DOMException('Write failed', name);
            const event = new Event('error');
            Object.defineProperty(event, 'target', { value: req });
            req.onerror?.(event);
            tx.onerror?.(event);
            tx.error = req.error;
            finish(false);
          } else {
            snapshot.set(value.id, structuredClone(value));
            req.result = value.id;
            req.onsuccess?.(new Event('success'));
          }
        });
        return req as unknown as IDBRequest;
      },
    };
    this.enqueue(() => {
      active = true;
      snapshot = structuredClone(this.records);
      pump();
    });
    return tx;
  }
}
