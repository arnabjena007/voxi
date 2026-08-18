use anyhow::Context;
use std::fs;
use std::path::Path;
use voxi_room::WordLists;

/// Load three text files into a `WordLists`. Each file is one word per line;
/// blank lines and lines starting with `#` are skipped.
pub fn load_from_dir(dir: &Path) -> anyhow::Result<WordLists> {
    let easy = read_words(&dir.join("words-easy.txt"))?;
    let medium = read_words(&dir.join("words-medium.txt"))?;
    let hard = read_words(&dir.join("words-hard.txt"))?;
    let mut lists = WordLists::new(easy, medium, hard);
    let bot_easy = read_words(&dir.join("words-bot-easy.txt")).unwrap_or_default();
    let bot_medium = read_words(&dir.join("words-bot-medium.txt")).unwrap_or_default();
    let bot_hard = read_words(&dir.join("words-bot-hard.txt")).unwrap_or_default();
    if !bot_easy.is_empty() || !bot_medium.is_empty() || !bot_hard.is_empty() {
        lists = lists.with_bot_words(bot_easy, bot_medium, bot_hard);
    }
    Ok(lists)
}

fn read_words(path: &Path) -> anyhow::Result<Vec<String>> {
    let text = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(String::from)
        .collect())
}
