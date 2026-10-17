/**
 * Fixed-capacity FIFO buffer. Once full, each push overwrites the oldest item.
 */
export class CircularBuffer<T> {
  private readonly items: Array<T | undefined>;
  private start = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.items = new Array<T | undefined>(Math.max(0, capacity));
  }

  push(item: T): void {
    if (this.capacity === 0) return;
    const index = (this.start + this.count) % this.capacity;
    this.items[index] = item;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.start = (this.start + 1) % this.capacity;
    }
  }

  /** Items from oldest to newest. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const item = this.items[(this.start + i) % this.capacity];
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    for (let i = 0; i < this.items.length; i++) this.items[i] = undefined;
    this.start = 0;
    this.count = 0;
  }
}
