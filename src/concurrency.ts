interface Waiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly priority: number;
  readonly sequence: number;
}

export class AsyncSemaphore {
  readonly #limit: number;
  readonly #waiters: Waiter[] = [];
  #active = 0;
  #sequence = 0;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be a positive integer");
    this.#limit = limit;
  }

  acquire(signal: AbortSignal, priority = 0): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error("Semaphore wait aborted"));
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve(() => this.#release());
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => reject(new Error("Semaphore wait aborted"));
      const waiter: Waiter = { resolve, reject, signal, onAbort, priority, sequence: this.#sequence };
      this.#sequence += 1;
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
      this.#waiters.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
    });
  }

  #release(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) continue;
      waiter.resolve(() => this.#release());
      return;
    }
    this.#active -= 1;
  }
}

export class KeyedSemaphore {
  readonly #semaphores = new Map<string, AsyncSemaphore>();
  readonly #limit: number;

  constructor(limit = 1) {
    this.#limit = limit;
  }

  async acquire(key: string, signal: AbortSignal): Promise<() => void> {
    let semaphore = this.#semaphores.get(key);
    if (semaphore === undefined) {
      semaphore = new AsyncSemaphore(this.#limit);
      this.#semaphores.set(key, semaphore);
    }
    return semaphore.acquire(signal);
  }
}
