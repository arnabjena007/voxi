//! Word lists used by the game loop.
//!
//! The server-side binary loads three text files (easy / medium / hard) at
//! startup and shares one `Arc<WordLists>` across all rooms. The room actor
//! samples N words from the band that matches the current round index.

use rand::seq::SliceRandom;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Difficulty {
    Easy,
    Medium,
    Hard,
}

impl Difficulty {
    /// Map a 0-based round index to the difficulty tier.
    pub fn for_round(round_index: u8) -> Self {
        match round_index {
            0 | 1 => Difficulty::Easy,
            2 | 3 => Difficulty::Medium,
            _ => Difficulty::Hard,
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct WordLists {
    easy: Vec<String>,
    medium: Vec<String>,
    hard: Vec<String>,
    bot_easy: Vec<String>,
    bot_medium: Vec<String>,
    bot_hard: Vec<String>,
}

impl WordLists {
    pub fn new(easy: Vec<String>, medium: Vec<String>, hard: Vec<String>) -> Self {
        Self {
            easy,
            medium,
            hard,
            bot_easy: Vec::new(),
            bot_medium: Vec::new(),
            bot_hard: Vec::new(),
        }
    }

    pub fn with_bot_words(
        mut self,
        bot_easy: Vec<String>,
        bot_medium: Vec<String>,
        bot_hard: Vec<String>,
    ) -> Self {
        self.bot_easy = bot_easy;
        self.bot_medium = bot_medium;
        self.bot_hard = bot_hard;
        self
    }

    /// Build a tiny test pool so tests can exercise the round logic without
    /// loading any data files. Each tier has a handful of obviously
    /// drawable words.
    pub fn test_fixture() -> Self {
        Self::new(
            vec!["cat", "dog", "fish", "tree", "moon"]
                .into_iter()
                .map(String::from)
                .collect(),
            vec!["guitar", "banana", "rocket", "ladder", "castle"]
                .into_iter()
                .map(String::from)
                .collect(),
            vec![
                "satellite",
                "lighthouse",
                "skateboard",
                "umbrella",
                "telescope",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
        )
    }

    fn pool(&self, diff: Difficulty) -> &[String] {
        match diff {
            Difficulty::Easy => &self.easy,
            Difficulty::Medium => &self.medium,
            Difficulty::Hard => &self.hard,
        }
    }

    /// Sample up to `count` distinct words from the band for `diff`. If the
    /// pool is empty, returns an empty Vec. If `count` exceeds the pool
    /// size, returns the whole pool shuffled.
    pub fn sample(&self, diff: Difficulty, count: usize) -> Vec<String> {
        let pool = self.pool(diff);
        if pool.is_empty() || count == 0 {
            return Vec::new();
        }
        let take = count.min(pool.len());
        let mut rng = rand::thread_rng();
        pool.choose_multiple(&mut rng, take).cloned().collect()
    }

    fn bot_pool(&self, diff: Difficulty) -> &[String] {
        match diff {
            Difficulty::Easy => &self.bot_easy,
            Difficulty::Medium => &self.bot_medium,
            Difficulty::Hard => &self.bot_hard,
        }
    }

    pub fn sample_bot(&self, diff: Difficulty, count: usize) -> Vec<String> {
        let pool = self.bot_pool(diff);
        if pool.is_empty() {
            return self.sample(diff, count);
        }
        let take = count.min(pool.len());
        let mut rng = rand::thread_rng();
        pool.choose_multiple(&mut rng, take).cloned().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.easy.is_empty() && self.medium.is_empty() && self.hard.is_empty()
    }
}

pub type SharedWords = Arc<WordLists>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn difficulty_for_round() {
        assert_eq!(Difficulty::for_round(0), Difficulty::Easy);
        assert_eq!(Difficulty::for_round(1), Difficulty::Easy);
        assert_eq!(Difficulty::for_round(2), Difficulty::Medium);
        assert_eq!(Difficulty::for_round(3), Difficulty::Medium);
        assert_eq!(Difficulty::for_round(4), Difficulty::Hard);
        assert_eq!(Difficulty::for_round(99), Difficulty::Hard);
    }

    #[test]
    fn sample_returns_requested_count_when_pool_large_enough() {
        let lists = WordLists::test_fixture();
        let sample = lists.sample(Difficulty::Easy, 3);
        assert_eq!(sample.len(), 3);
        for w in &sample {
            assert!(lists.easy.contains(w));
        }
    }

    #[test]
    fn sample_clamps_to_pool_size() {
        let lists = WordLists::test_fixture();
        let sample = lists.sample(Difficulty::Easy, 100);
        assert_eq!(sample.len(), lists.easy.len());
    }

    #[test]
    fn sample_from_empty_pool_is_empty() {
        let lists = WordLists::new(vec![], vec![], vec![]);
        assert!(lists.sample(Difficulty::Easy, 5).is_empty());
    }
}
