//! Pure game-loop helpers. No tokio, no channels.
//!
//! The room actor owns the timing and IO; this module holds the rules:
//! mask construction, hint reveal, score formula, and round / game tally.

use ahash::AHashMap;
use pastel_proto::PlayerId;
use rand::seq::SliceRandom;
use std::collections::HashSet;
use std::time::Duration;

pub const PICK_WINDOW: Duration = Duration::from_secs(15);
pub const DRAW_WINDOW: Duration = Duration::from_secs(80);
pub const ROUND_REVEAL: Duration = Duration::from_secs(5);
/// How long the "best drawing" vote stays open after a game ends.
pub const VOTE_WINDOW: Duration = Duration::from_secs(40);
pub const MIN_SCORE_PER_GUESS: u32 = 25;
pub const RANK_MULTIPLIER: f32 = 0.7;
pub const DRAWER_BONUS_FRACTION: f32 = 0.5;

/// Hints reveal at these many seconds remaining in the draw window, in order.
pub const HINT_REMAINING_SECS: [u64; 3] = [60, 30, 10];

/// Build the masked form of `word`: alpha chars become `_`, everything else
/// (spaces, hyphens, digits, punctuation) is rendered as itself.
pub fn build_mask(word: &str) -> String {
    word.chars()
        .map(|c| if c.is_alphabetic() { '_' } else { c })
        .collect()
}

/// Reveal the `index`-th character (in chars, not bytes) of `word` in `mask`.
/// `mask` is mutated in place. Returns true if a change was made.
pub fn reveal_at(mask: &mut String, word: &str, index: usize) -> bool {
    let word_chars: Vec<char> = word.chars().collect();
    let mut mask_chars: Vec<char> = mask.chars().collect();
    if index >= word_chars.len() || index >= mask_chars.len() {
        return false;
    }
    if mask_chars[index] == word_chars[index] {
        return false;
    }
    mask_chars[index] = word_chars[index];
    *mask = mask_chars.into_iter().collect();
    true
}

/// Pick a random un-revealed alpha index in the word. Returns None if all
/// alpha positions are already revealed (or there are none).
pub fn pick_hint_index(word: &str, revealed: &HashSet<usize>) -> Option<usize> {
    let candidates: Vec<usize> = word
        .chars()
        .enumerate()
        .filter(|(i, c)| c.is_alphabetic() && !revealed.contains(i))
        .map(|(i, _)| i)
        .collect();
    if candidates.is_empty() {
        return None;
    }
    let mut rng = rand::thread_rng();
    candidates.choose(&mut rng).copied()
}

/// How many hints are allowed for this word. Caps at `HINT_REMAINING_SECS.len()`
/// and at floor(alpha_chars / 2).
pub fn max_hints(word: &str) -> usize {
    let alpha = word.chars().filter(|c| c.is_alphabetic()).count();
    (alpha / 2).min(HINT_REMAINING_SECS.len())
}

/// Score for a correct guess.
///
/// `remaining_ms` is how much of the draw window is left; `window_ms` is the
/// total draw window; `rank` is 0 for the first guesser this round, 1 for the
/// second, and so on. Subsequent guessers earn `RANK_MULTIPLIER^rank` of the
/// base. Score is clamped at `MIN_SCORE_PER_GUESS` before the multiplier.
pub fn guess_score(remaining_ms: u32, window_ms: u32, rank: usize) -> u32 {
    if window_ms == 0 {
        return MIN_SCORE_PER_GUESS;
    }
    let base = ((100.0_f32 * remaining_ms as f32) / window_ms as f32).round() as u32;
    let base = base.max(MIN_SCORE_PER_GUESS);
    let mult = RANK_MULTIPLIER.powi(rank as i32);
    (base as f32 * mult).round() as u32
}

/// Drawer reward at round end: a fraction of the guessers' total.
pub fn drawer_bonus(total_guesser_points: u32) -> u32 {
    (total_guesser_points as f32 * DRAWER_BONUS_FRACTION).round() as u32
}

/// The rotation of drawer order for a game. Stable across rounds. We cycle
/// `players` round-robin starting from `players[0]`.
pub fn drawer_for_round(rotation: &[PlayerId], round_index: u8) -> Option<PlayerId> {
    if rotation.is_empty() {
        return None;
    }
    Some(rotation[(round_index as usize) % rotation.len()])
}

/// Returns a sorted (player, score) list, highest first.
pub fn ranked_scores(scores: &AHashMap<PlayerId, u32>) -> Vec<(PlayerId, u32)> {
    let mut v: Vec<_> = scores.iter().map(|(k, v)| (*k, *v)).collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v
}

/// Iterative Levenshtein with one allocation, ASCII-only fast path.
pub fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr: Vec<usize> = vec![0; b.len() + 1];
    for (i, ac) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, bc) in b.iter().enumerate() {
            let cost = if ac == bc { 0 } else { 1 };
            curr[j + 1] = (curr[j] + 1).min(prev[j + 1] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}

/// Does `text` leak the secret `word`? Used to block spoilers from players
/// who already know the answer (drawer + correct guessers) when they chat.
///
/// Single-word secrets: a token leaks if it matches the word exactly or via
/// the tight close-guess threshold, so "i think it's rock!" and a near
/// misspelling both count, while "category" does not leak "cat".
///
/// Multi-word secrets ("ice cream", "3d printer"): the whole phrase must
/// appear as a run of adjacent tokens. Saying the full answer is blocked, but
/// an unrelated single word ("i love cream") is not.
pub fn message_leaks_word(text: &str, word: &str) -> bool {
    let target = tokenize(word);
    if target.is_empty() {
        return false;
    }
    let tokens = tokenize(text);
    if target.len() == 1 {
        let t = &target[0];
        return tokens.iter().any(|tok| tok == t || is_close_guess(tok, t));
    }
    if tokens.len() < target.len() {
        return false;
    }
    tokens.windows(target.len()).any(|w| w == target.as_slice())
}

/// Lowercase alphanumeric tokens, splitting on every other character.
fn tokenize(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// Is `guess` close (but not exact) to `word`? Threshold scales with length:
/// short words must be off by exactly 1, longer words tolerate 2.
/// Case-insensitive, whitespace-trimmed.
pub fn is_close_guess(guess: &str, word: &str) -> bool {
    let g = guess.trim().to_lowercase();
    let w = word.trim().to_lowercase();
    if g.is_empty() || w.is_empty() {
        return false;
    }
    let d = edit_distance(&g, &w);
    if d == 0 {
        return false; // exact match is "correct", not "close"
    }
    if w.chars().count() < 4 {
        d == 1
    } else {
        d <= 2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_replaces_alpha_only() {
        assert_eq!(build_mask("cat"), "___");
        assert_eq!(build_mask("ice cream"), "___ _____");
        assert_eq!(build_mask("3D printer"), "3_ _______");
        assert_eq!(build_mask("Drake Meme"), "_____ ____");
    }

    #[test]
    fn reveal_swaps_in_one_char() {
        let mut mask = build_mask("cat");
        assert!(reveal_at(&mut mask, "cat", 1));
        assert_eq!(mask, "_a_");
    }

    #[test]
    fn reveal_returns_false_when_already_revealed() {
        let mut mask = "_a_".to_string();
        assert!(!reveal_at(&mut mask, "cat", 1));
    }

    #[test]
    fn max_hints_caps_at_half_alpha_and_at_3() {
        assert_eq!(max_hints("a"), 0); // 1 alpha → 0
        assert_eq!(max_hints("ab"), 1); // 2 alpha → 1
        assert_eq!(max_hints("abc"), 1); // 3 → 1
        assert_eq!(max_hints("abcd"), 2); // 4 → 2
        assert_eq!(max_hints("abcdef"), 3); // 6 → 3
        assert_eq!(max_hints("abcdefghij"), 3); // 10 → capped at 3
    }

    #[test]
    fn guess_score_full_time_is_around_100() {
        let s = guess_score(80_000, 80_000, 0);
        assert_eq!(s, 100);
    }

    #[test]
    fn guess_score_clamps_to_min() {
        let s = guess_score(0, 80_000, 0);
        assert_eq!(s, MIN_SCORE_PER_GUESS);
    }

    #[test]
    fn guess_score_decays_by_rank() {
        let base = guess_score(80_000, 80_000, 0);
        let rank1 = guess_score(80_000, 80_000, 1);
        let rank2 = guess_score(80_000, 80_000, 2);
        assert!(rank1 < base);
        assert!(rank2 < rank1);
        // 100 * 0.49 = 49
        assert_eq!(rank2, 49);
    }

    #[test]
    fn drawer_bonus_is_half_total() {
        assert_eq!(drawer_bonus(100), 50);
        assert_eq!(drawer_bonus(7), 4);
    }

    #[test]
    fn rotation_wraps_round_robin() {
        let players = vec![10, 20, 30];
        assert_eq!(drawer_for_round(&players, 0), Some(10));
        assert_eq!(drawer_for_round(&players, 1), Some(20));
        assert_eq!(drawer_for_round(&players, 2), Some(30));
        assert_eq!(drawer_for_round(&players, 3), Some(10));
        assert_eq!(drawer_for_round(&players, 99), Some(10));
    }

    #[test]
    fn rotation_empty_returns_none() {
        assert_eq!(drawer_for_round(&[], 0), None);
    }

    #[test]
    fn edit_distance_basics() {
        assert_eq!(edit_distance("", ""), 0);
        assert_eq!(edit_distance("cat", "cat"), 0);
        assert_eq!(edit_distance("cat", "bat"), 1);
        assert_eq!(edit_distance("cat", "cats"), 1);
        assert_eq!(edit_distance("kitten", "sitting"), 3);
    }

    #[test]
    fn close_guess_threshold_by_length() {
        // Short words: exactly 1 edit
        assert!(is_close_guess("cat", "bat"));
        assert!(!is_close_guess("cat", "dog"));
        // Longer words: up to 2 edits
        assert!(is_close_guess("apple", "appls"));
        assert!(is_close_guess("apple", "appls!"));
        assert!(!is_close_guess("apple", "orange"));
        // Exact match is NOT close
        assert!(!is_close_guess("apple", "apple"));
        // Case-insensitive and trim
        assert!(is_close_guess("  APPLE  ", "appls"));
        // Empty inputs are never close
        assert!(!is_close_guess("", "cat"));
        assert!(!is_close_guess("cat", ""));
    }

    #[test]
    fn ranked_scores_sorts_high_to_low() {
        let mut m = AHashMap::new();
        m.insert(1, 50);
        m.insert(2, 100);
        m.insert(3, 75);
        let v = ranked_scores(&m);
        assert_eq!(v, vec![(2, 100), (3, 75), (1, 50)]);
    }

    #[test]
    fn leak_single_word_exact_and_embedded() {
        assert!(message_leaks_word("rock", "rock"));
        assert!(message_leaks_word("i think it's ROCK!", "rock"));
        // unrelated chatter doesn't leak
        assert!(!message_leaks_word("nice drawing", "rock"));
        // a longer word that merely contains the target is not a leak
        assert!(!message_leaks_word("category of things", "cat"));
    }

    #[test]
    fn leak_single_word_close_misspelling() {
        // one edit off a short word still gives the answer away
        assert!(message_leaks_word("kat", "cat"));
    }

    #[test]
    fn leak_multi_word_requires_full_phrase() {
        assert!(message_leaks_word("i bet it's ice cream!", "ice cream"));
        assert!(message_leaks_word("ICE CREAM", "ice cream"));
        // a single component is not the whole answer
        assert!(!message_leaks_word("i love cream", "ice cream"));
        assert!(!message_leaks_word("ice age", "ice cream"));
        // digits are kept as tokens, so the alphanumeric phrase still matches
        assert!(message_leaks_word("it's a 3d printer", "3D printer"));
    }

    #[test]
    fn leak_empty_target_is_never_a_leak() {
        assert!(!message_leaks_word("anything at all", "   "));
    }
}
