//! Server-side line/word diff for the text viewer.
//!
//! The frontend renders diffs with `@codemirror/merge`, which by default
//! recomputes the diff itself with a `scanLimit` of 500. On large, densely
//! changed files that scan limit makes its algorithm bail out and report the
//! whole region as one giant change — so a 27%-changed file lights up ~90%
//! changed. We sidestep that by computing an authoritative diff here and
//! injecting it via the editor's `diffConfig.override` hook, so CodeMirror
//! renders our result verbatim (it still applies its own word-boundary /
//! short-gap cleanup on top).
//!
//! Two invariants make the injection correct:
//!   * Offsets are measured in **UTF-16 code units**, matching CodeMirror's
//!     document coordinate system (a JS string index), not Rust bytes/chars.
//!   * Line endings are normalized to `\n` here, and callers return the same
//!     normalized text as the editor document — so `\r\n` vs `\n` (the Windows
//!     autocrlf worktree case) never registers as a change, and our offsets
//!     line up with what the editor actually holds.

use serde::{Deserialize, Serialize};
use similar::{DiffTag, TextDiff};

/// A changed range in UTF-16 offsets, mirroring `@codemirror/merge`'s `Change`
/// (`fromA`/`toA` in the old doc, `fromB`/`toB` in the new). Serialized in
/// snake_case to match the rest of `FileDiff`; the frontend maps it onto the
/// CodeMirror `Change` class before injecting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Change {
    pub from_a: u32,
    pub to_a: u32,
    pub from_b: u32,
    pub to_b: u32,
}

/// Replace blocks larger than this (UTF-16 units, max of the two sides) are
/// emitted as a single line-level change rather than refined into word-level
/// ranges. Word-level highlighting only helps on small edits; refining a huge
/// rewritten block would reintroduce the very slowness we're avoiding.
const REFINE_MAX_UTF16: u32 = 2_000;

/// Normalize CRLF and lone-CR line endings to LF. Callers must return the
/// normalized string as the editor document so offsets stay consistent.
pub fn normalize_eol(s: &str) -> String {
    if s.as_bytes().contains(&b'\r') {
        s.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        s.to_string()
    }
}

/// Compute the diff between two texts as CodeMirror-ready `Change`s. Input is
/// normalized internally, so offsets are relative to the *normalized* text —
/// callers must hand the editor `normalize_eol(...)` of the same input.
pub fn compute_changes(old: &str, new: &str) -> Vec<Change> {
    let old = normalize_eol(old);
    let new = normalize_eol(new);

    let off_a = line_offsets(&old);
    let off_b = line_offsets(&new);
    let lines_a: Vec<&str> = old.split_inclusive('\n').collect();
    let lines_b: Vec<&str> = new.split_inclusive('\n').collect();

    let diff = TextDiff::from_lines(&old, &new);
    let mut out = Vec::new();
    for op in diff.ops() {
        let ar = op.old_range();
        let br = op.new_range();
        match op.tag() {
            DiffTag::Equal => {}
            DiffTag::Delete => out.push(Change {
                from_a: off_a[ar.start],
                to_a: off_a[ar.end],
                from_b: off_b[br.start],
                to_b: off_b[br.start],
            }),
            DiffTag::Insert => out.push(Change {
                from_a: off_a[ar.start],
                to_a: off_a[ar.start],
                from_b: off_b[br.start],
                to_b: off_b[br.end],
            }),
            DiffTag::Replace => {
                let base_a = off_a[ar.start];
                let base_b = off_b[br.start];
                let a_len = off_a[ar.end] - base_a;
                let b_len = off_b[br.end] - base_b;
                if a_len.max(b_len) > REFINE_MAX_UTF16 {
                    // Too big to refine cheaply — one line-level change.
                    out.push(Change {
                        from_a: base_a,
                        to_a: off_a[ar.end],
                        from_b: base_b,
                        to_b: off_b[br.end],
                    });
                } else {
                    let a_text: String = lines_a[ar.clone()].concat();
                    let b_text: String = lines_b[br.clone()].concat();
                    refine_into(&a_text, &b_text, base_a, base_b, &mut out);
                }
            }
        }
    }
    out
}

/// Char-level diff of a (small) modified block, emitting word-ish sub-ranges so
/// the editor highlights only the changed substrings. Offsets are relative to
/// `base_a`/`base_b` (the block's start in the full document).
fn refine_into(a: &str, b: &str, base_a: u32, base_b: u32, out: &mut Vec<Change>) {
    let pa = char_utf16_prefix(a);
    let pb = char_utf16_prefix(b);
    let diff = TextDiff::from_chars(a, b);
    for op in diff.ops() {
        let ar = op.old_range();
        let br = op.new_range();
        if op.tag() == DiffTag::Equal {
            continue;
        }
        out.push(Change {
            from_a: base_a + pa[ar.start],
            to_a: base_a + pa[ar.end],
            from_b: base_b + pb[br.start],
            to_b: base_b + pb[br.end],
        });
    }
}

/// UTF-16 offset of the start of each line, plus a trailing sentinel equal to
/// the total UTF-16 length. `offsets[i]` is the start of line `i`; the sentinel
/// at `offsets[line_count]` lets a range's `end` line index resolve cleanly.
fn line_offsets(s: &str) -> Vec<u32> {
    let mut offs = Vec::new();
    let mut acc: u32 = 0;
    for line in s.split_inclusive('\n') {
        offs.push(acc);
        acc += utf16_len(line);
    }
    offs.push(acc);
    offs
}

/// Cumulative UTF-16 offset before each char, with a trailing total. Indexed by
/// char position (matching `TextDiff::from_chars`' token indices).
fn char_utf16_prefix(s: &str) -> Vec<u32> {
    let mut v = Vec::with_capacity(s.len() + 1);
    let mut acc: u32 = 0;
    v.push(0);
    for c in s.chars() {
        acc += c.len_utf16() as u32;
        v.push(acc);
    }
    v
}

fn utf16_len(s: &str) -> u32 {
    s.chars().map(|c| c.len_utf16() as u32).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sum of changed span on the new (B) side, in UTF-16 units.
    fn b_span(changes: &[Change]) -> u32 {
        changes.iter().map(|c| c.to_b - c.from_b).sum()
    }

    #[test]
    fn identical_yields_no_changes() {
        assert!(compute_changes("a\nb\nc\n", "a\nb\nc\n").is_empty());
    }

    #[test]
    fn midfile_insert_only_flags_inserted_line() {
        // The reported symptom: inserting one line must NOT flag the lines below.
        let ch = compute_changes("a\nb\nc\n", "a\nb\nX\nc\n");
        assert_eq!(ch.len(), 1, "exactly one inserted-line change");
        let c = &ch[0];
        assert_eq!(c.from_a, c.to_a, "insertion: zero width on the old side");
        // Inserted "X\n" sits after "a\nb\n" (offset 4) and spans 2 units.
        assert_eq!((c.from_b, c.to_b), (4, 6));
    }

    #[test]
    fn pure_deletion_flags_only_removed() {
        let ch = compute_changes("a\nb\nc\n", "a\nc\n");
        assert_eq!(ch.len(), 1);
        let c = &ch[0];
        assert_eq!(c.from_b, c.to_b, "deletion: zero width on the new side");
        assert_eq!((c.from_a, c.to_a), (2, 4)); // "b\n"
    }

    #[test]
    fn modified_line_is_word_level() {
        // Only "bar"->"qux" should be flagged, not the whole line.
        let ch = compute_changes("foo bar baz\n", "foo qux baz\n");
        assert!(!ch.is_empty());
        let line_len = utf16_len("foo bar baz\n");
        for c in &ch {
            assert!(c.to_b - c.from_b < line_len, "sub-line, not whole line");
            assert!(c.from_b >= 4 && c.to_b <= 7, "within the 'qux' region");
        }
    }

    #[test]
    fn crlf_vs_lf_same_content_no_changes() {
        // Windows autocrlf worktree case: old (HEAD, LF) vs new (disk, CRLF).
        assert!(compute_changes("a\nb\nc\n", "a\r\nb\r\nc\r\n").is_empty());
    }

    #[test]
    fn lone_cr_normalized() {
        assert!(compute_changes("a\rb\r", "a\nb\n").is_empty());
    }

    #[test]
    fn added_and_deleted_file() {
        let added = compute_changes("", "x\ny\n");
        assert_eq!(added.len(), 1);
        assert_eq!((added[0].from_a, added[0].to_a), (0, 0));
        assert_eq!((added[0].from_b, added[0].to_b), (0, 4));

        let deleted = compute_changes("x\ny\n", "");
        assert_eq!(deleted.len(), 1);
        assert_eq!((deleted[0].from_b, deleted[0].to_b), (0, 0));
        assert_eq!((deleted[0].from_a, deleted[0].to_a), (0, 4));
    }

    #[test]
    fn no_trailing_newline() {
        let ch = compute_changes("a\nb", "a\nb\nc");
        // "b" (no newline) becomes "b\n" + "c": the change touches the tail,
        // but line "a" stays untouched.
        assert!(!ch.is_empty());
        assert!(ch.iter().all(|c| c.from_b >= 2), "line 'a' (0..2) untouched");
    }

    #[test]
    fn offsets_are_valid_invariant() {
        let old = "alpha\nbeta\ngamma\ndelta\n";
        let new = "alpha\nBETA\ngamma\ndelta\nepsilon\n";
        let ch = compute_changes(old, new);
        let max_a = utf16_len(&normalize_eol(old));
        let max_b = utf16_len(&normalize_eol(new));
        for c in &ch {
            assert!(c.from_a <= c.to_a && c.from_b <= c.to_b);
            assert!(c.to_a <= max_a && c.to_b <= max_b);
        }
    }

    #[test]
    fn offsets_in_utf16_units() {
        // 𝄞 (U+1D11E) is one Rust char but two UTF-16 code units. A change
        // after it must account for both units.
        let old = "𝄞 a\nx\n";
        let new = "𝄞 a\ny\n";
        let ch = compute_changes(old, new);
        assert_eq!(ch.len(), 1);
        // "𝄞 a\n" = 2 + 1 + 1 + 1 = 5 UTF-16 units; change starts there.
        assert!(ch[0].from_b >= 5, "offset counts the surrogate pair as 2");
    }

    #[test]
    fn large_dense_does_not_bail() {
        // Regression for the scanLimit bug: CodeMirror at scanLimit=500 collapses
        // a large, densely-changed file into ONE change spanning most of it (the
        // reason we diff in the backend). Our diff must stay granular instead —
        // many small changes, none spanning half the file. Synthetic input so no
        // external source is vendored in.
        let mut old = String::new();
        let mut new = String::new();
        for i in 0..3000 {
            old.push_str(&format!("fn item_{i}() {{ return {i}; }}\n"));
            if i % 4 == 0 {
                // ~25% of lines changed, scattered throughout.
                new.push_str(&format!("fn item_{i}() {{ return {i} + 1; }} // edit\n"));
            } else {
                new.push_str(&format!("fn item_{i}() {{ return {i}; }}\n"));
            }
        }
        let ch = compute_changes(&old, &new);
        assert!(ch.len() > 100, "expected many changes, got {}", ch.len());
        let total_b = utf16_len(&new);
        let biggest = ch.iter().map(|c| c.to_b - c.from_b).max().unwrap_or(0);
        assert!(
            biggest < total_b / 2,
            "no single change may span half the file (got {biggest}/{total_b})"
        );
        assert!(b_span(&ch) < total_b / 2, "overall change well under whole-file");
    }
}
