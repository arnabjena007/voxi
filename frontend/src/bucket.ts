// Mirrors the Rust `TokenBucket` in `voxi-room/src/bucket.rs`. The numbers
// here MUST match the server's limits in `voxi-room/src/room.rs` so the
// client's preview of "you'll be rate-limited" lines up with what the server
// actually enforces.

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.last = performance.now();
  }

  tryTake(): boolean {
    const now = performance.now();
    const elapsed = (now - this.last) / 1000;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsed * this.refillPerSec,
    );
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export const CHAT_BUCKET_CAPACITY = 5;
export const CHAT_BUCKET_REFILL_PER_SEC = 5 / 3;
