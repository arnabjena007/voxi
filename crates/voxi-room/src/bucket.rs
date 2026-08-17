use tokio::time::Instant;

#[derive(Debug)]
pub struct TokenBucket {
    tokens: f32,
    capacity: f32,
    refill_per_sec: f32,
    last: Instant,
}

impl TokenBucket {
    pub fn new(capacity: f32, refill_per_sec: f32) -> Self {
        Self {
            tokens: capacity,
            capacity,
            refill_per_sec,
            last: Instant::now(),
        }
    }

    pub fn try_take(&mut self) -> bool {
        let now = Instant::now();
        let elapsed = now.saturating_duration_since(self.last).as_secs_f32();
        self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn bucket_grants_up_to_capacity_then_refuses() {
        let mut b = TokenBucket::new(5.0, 1.0);
        for _ in 0..5 {
            assert!(b.try_take());
        }
        assert!(!b.try_take());
    }

    #[tokio::test(start_paused = true)]
    async fn bucket_refills_over_time() {
        let mut b = TokenBucket::new(5.0, 2.0);
        for _ in 0..5 {
            assert!(b.try_take());
        }
        assert!(!b.try_take());

        tokio::time::advance(std::time::Duration::from_secs(1)).await;
        assert!(b.try_take());
        assert!(b.try_take());
        assert!(!b.try_take());
    }

    #[tokio::test(start_paused = true)]
    async fn bucket_caps_at_capacity() {
        let mut b = TokenBucket::new(3.0, 100.0);
        b.try_take();
        b.try_take();
        b.try_take();
        tokio::time::advance(std::time::Duration::from_secs(60)).await;
        for _ in 0..3 {
            assert!(b.try_take());
        }
        assert!(!b.try_take());
    }
}
