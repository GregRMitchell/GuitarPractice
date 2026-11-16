import { vi } from 'vitest';

export class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly sent: unknown[] = [];
  readonly transfers: Transferable[][] = [];
  closed = false;
  postMessage(value: unknown, transfer: Transferable[] = []): void {
    this.sent.push(value);
    this.transfers.push(transfer);
  }
  close(): void { this.closed = true; }
  emit(data: unknown): void { this.onmessage?.({ data } as MessageEvent); }
}

class FakeNode {
  readonly connections: FakeNode[] = [];
  disconnected = false;
  connect(node: FakeNode): FakeNode { this.connections.push(node); return node; }
  disconnect(): void { this.disconnected = true; }
}

export class FakeTrack extends EventTarget {
  stopped = false;
  stop(): void { this.stopped = true; }
  getSettings(): MediaTrackSettings { return { sampleRate: 48000, echoCancellation: true }; }
}

export class FakeDocument extends EventTarget {
  hidden = false;
  hide(): void { this.hidden = true; this.dispatchEvent(new Event('visibilitychange')); }
}

export class FakeWorker extends FakePort {
  static instances: FakeWorker[] = [];
  static failure = false;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor(readonly url: string) {
    super();
    if (FakeWorker.failure) throw new Error('worker setup failed');
    FakeWorker.instances.push(this);
    queueMicrotask(() => this.emit({ type: 'ready' }));
  }
  terminate(): void { this.terminated = true; }
}

export class FakeWorklet extends FakeNode {
  static instances: FakeWorklet[] = [];
  readonly port = new FakePort();
  onprocessorerror: (() => void) | null = null;
  constructor(_context: unknown, _name: string, readonly options: AudioWorkletNodeOptions) {
    super();
    FakeWorklet.instances.push(this);
  }
}

export class FakeContext extends EventTarget {
  static instances: FakeContext[] = [];
  static moduleFailure = false;
  static resumeFailure = false;
  static moduleGate: Promise<void> | undefined;
  currentTime = 10;
  sampleRate = 48000;
  state: AudioContextState = 'running';
  closed = false;
  readonly source = new FakeNode();
  readonly destination = new FakeNode();
  readonly sink = Object.assign(new FakeNode(), { gain: { value: 1 } });
  readonly audioWorklet = {
    addModule: async (_url: string): Promise<void> => {
      if (FakeContext.moduleFailure) throw new Error('worklet setup failed');
      await FakeContext.moduleGate;
    },
  };
  constructor() { super(); FakeContext.instances.push(this); }
  async resume(): Promise<void> {
    if (FakeContext.resumeFailure) throw new Error('resume failed');
  }
  createMediaStreamSource(): FakeNode { return this.source; }
  createGain(): typeof this.sink { return this.sink; }
  async close(): Promise<void> { this.closed = true; this.state = 'closed'; }
}

export function browser(): {
  document: FakeDocument;
  tracks: FakeTrack[];
  getUserMedia: ReturnType<typeof vi.fn>;
  activation: { isActive: boolean };
} {
  FakeContext.instances = [];
  FakeContext.moduleFailure = false;
  FakeContext.resumeFailure = false;
  FakeContext.moduleGate = undefined;
  FakeWorker.instances = [];
  FakeWorker.failure = false;
  FakeWorklet.instances = [];
  const document = new FakeDocument();
  const tracks = [new FakeTrack(), new FakeTrack()];
  const getUserMedia = vi.fn(async () => ({
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  }));
  const activation = { isActive: true };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia }, userActivation: activation });
  vi.stubGlobal('document', document);
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorklet);
  vi.stubGlobal('Worker', FakeWorker);
  return { document, tracks, getUserMedia, activation };
}
