# Word lists

1555 drawable words for the game loop, bucketed by difficulty. The base
1500 come from skribbl.io's empirical pick-success data; the extra 55 are
hand-curated internet memes (classics + 2024-2026 brainrot).

| File              | Words | Memes | Total | Difficulty tier                                          |
|-------------------|------:|------:|------:|----------------------------------------------------------|
| `words-easy.txt`  | 500   | 20    | 520   | Rounds 1-2. Highly recognizable, drawable in seconds.    |
| `words-medium.txt`| 500   | 20    | 520   | Rounds 3-4. Common but needs more thought to draw.       |
| `words-hard.txt`  | 500   | 15    | 515   | Rounds 5+. Multi-syllable, compound, or absurdist.       |

## Source

Curated from the public skribbl.io English word list (3692 entries), captured
at <https://github.com/skribbliohints/skribbliohints.github.io>. Each entry
in the source includes an empirically measured `successRate` (fraction of
rounds where someone guessed the word correctly), which is a better
difficulty signal than word length.

## Grading

For each word in the source, we kept entries with `picked >= 10` to drop
statistical noise, then bucketed by `successRate`:

| Bucket  | Success-rate window | Sort within bucket |
|---------|---------------------|--------------------|
| Easy    | >= 0.55             | Most-picked first  |
| Medium  | 0.40 to 0.55        | Most-picked first  |
| Hard    | <  0.40             | Most-picked first  |

The top 500 by pick count from each bucket landed in the corresponding file.
This biases toward words that have been chosen often, so the lists skew
toward familiar, recognizable concepts within each difficulty tier.

## Regeneration

```sh
curl -sL "https://raw.githubusercontent.com/skribbliohints/skribbliohints.github.io/master/English.json" -o /tmp/skribbl-en.json

jq -r '[to_entries[] | .value | select(.picked >= 10) | select(.successRate >= 0.55)] | sort_by(-.picked) | .[0:500] | .[] | .word'                                       /tmp/skribbl-en.json > words-easy.txt
jq -r '[to_entries[] | .value | select(.picked >= 10) | select(.successRate >= 0.40 and .successRate < 0.55)] | sort_by(-.picked) | .[0:500] | .[] | .word' /tmp/skribbl-en.json > words-medium.txt
jq -r '[to_entries[] | .value | select(.picked >= 10) | select(.successRate <  0.40)] | sort_by(-.picked) | .[0:500] | .[] | .word'                                       /tmp/skribbl-en.json > words-hard.txt
```

## Memes

The last block of each file is hand-curated internet memes, appended after
the empirical skribbl block. They are *not* graded by pick-success data
(there is none), so the placement reflects rough drawability + cultural
familiarity:

- **Easy memes**: universally known image macros that a 10-year-old internet
  user would recognize from a stick-figure pass (Doge, Pepe, Trollface,
  Rickroll, Distracted Boyfriend, Drake Meme, Among Us, Stonks, Gigachad,
  Wojak, NPC, Sigma Male, Forever Alone, Hide The Pain Harold, ...).
- **Medium memes**: specific scenes or stylistic variants that need either
  a known pose or a known prop to read (Mocking Spongebob, Galaxy Brain,
  Two Buttons, Side Eye Chloe, Soyjak, Yes Chad, Conspiracy Keanu, Salt Bae,
  ...).
- **Hard memes**: 2024-2026 brainrot and recent niche references with
  complex or surreal visuals (Skibidi Toilet, Tralalero Tralala, Tung Tung
  Tung Sahur, Bombardiro Crocodilo, Ballerina Cappuccina, Cappuccino
  Assassino, Brr Brr Patapim, Fanum Tax, Mewing, Looksmaxxing, ...).

Refresh these as the cultural sediment shifts. They are the part of this
file most likely to date.

## Notes

- A handful of entries are multi-word phrases (e.g. "ice cream",
  "Skibidi Toilet"). The game treats them as a single token for guess
  matching (case-insensitive, trimmed).
- Some entries are brand-adjacent ("McDonalds", "Nintendo Switch"). If you
  want a brand-free set, filter them out before shipping.
- The lists are intentionally **static**. Phase 6 of the roadmap also wires
  in a live word API so games never run out and stay fresh; these files
  are the offline fallback.
