export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  /** Pushes a value to the async queue. */
  push(value: T): void {
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  /** Closes the queue for future consumers. */
  close(): void {
    this.closed = true;
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ done: true, value: undefined });
    }
  }

  /** Returns an async iterator over queued values. */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) {
          return Promise.resolve({ done: false, value });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      }
    };
  }
}
