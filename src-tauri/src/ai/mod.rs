//! Claude Code CLI runs for PR analysis. The run is read-only toward the
//! repo by CLI flags, not by prompt wording: only Bash is available, only
//! read-only git subcommands are pre-approved, `dontAsk` denies everything
//! else, and `--strict-mcp-config` loads agentmemory alone. The allow/deny
//! lists can't stop the CLI's own auto-approval of commands like `cat`, or
//! allow rules in the user's settings, so a PreToolUse hook (riff.exe in
//! `AI_BASH_GUARD_FLAG` mode, `guard_decision`) hard-denies every other Bash
//! command and every tool outside the allowlist; the lists stay as defense
//! in depth.

use serde_json::{json, Value};
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::Duration;
use thiserror::Error;

const CLAUDE_EXE: &str = if cfg!(windows) {
    "claude.exe"
} else {
    "claude"
};

/// Pre-approved; with `dontAsk` anything else is denied, not prompted.
/// `scripts/ai-guard-probe.mjs` mirrors these lists and checks them against
/// the real CLI; change both together.
const ALLOWED_TOOLS: &[&str] = &[
    "Bash(git show:*)",
    "Bash(git grep:*)",
    "Bash(git log:*)",
    "Bash(git ls-tree:*)",
    "Bash(git cat-file:*)",
    "Bash(git merge-base:*)",
    "Bash(git rev-parse:*)",
    "mcp__agentmemory__memory_recall",
    "mcp__agentmemory__memory_smart_search",
    "mcp__agentmemory__memory_save",
];

/// Deny wins over allow, and over the CLI's own auto-approval of commands it
/// deems read-only (which let `git -c core.pager=cat log` through): git
/// options that write files or spawn a command, global git options (`-c` can
/// set `diff.external` etc.), and shell redirection/chaining/substitution.
const DISALLOWED_TOOLS: &[&str] = &[
    "Bash(*--output*)",
    "Bash(*--open-files-in-pager*)",
    "Bash(* -O*)",
    "Bash(*>*)",
    "Bash(*|*)",
    "Bash(*;*)",
    "Bash(*&*)",
    "Bash(*$(*)",
    "Bash(*`*)",
    "Bash(git -*)",
    "Bash(*--ext-diff*)",
];

/// First existing of: `claude` in an absolute PATH directory,
/// `<home>/.local/bin` (the native installer's location).
pub fn resolve_claude(
    path_var: Option<&OsStr>,
    home: Option<&Path>,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let on_path = path_var
        .into_iter()
        .flat_map(std::env::split_paths)
        // Empty (`;;`) or relative entries would resolve against riff's cwd.
        .filter(|d| d.is_absolute())
        .map(|d| d.join(CLAUDE_EXE));
    let local = home.map(|h| h.join(".local").join("bin").join(CLAUDE_EXE));
    on_path.chain(local).find(|p| exists(p))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

/// The `--mcp-config` content: the user's agentmemory entry from
/// `~/.claude.json`, and no other server.
pub fn agentmemory_mcp_config(claude_json: &Value) -> Value {
    match claude_json.pointer("/mcpServers/agentmemory") {
        Some(entry) => json!({ "mcpServers": { "agentmemory": entry } }),
        None => json!({ "mcpServers": {} }),
    }
}

/// `guard_exe` is riff's own executable, run as the Bash PreToolUse hook in
/// `AI_BASH_GUARD_FLAG` mode (see `guard_decision`).
pub fn claude_args(
    schema_json: &str,
    mcp_config_path: &Path,
    guard_exe: &Path,
    model: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--json-schema",
        schema_json,
        "--tools",
        "Bash",
        "--allowedTools",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.extend(ALLOWED_TOOLS.iter().map(|s| s.to_string()));
    args.push("--disallowedTools".into());
    args.extend(DISALLOWED_TOOLS.iter().map(|s| s.to_string()));
    args.extend(
        [
            "--permission-mode",
            "dontAsk",
            "--strict-mcp-config",
            "--mcp-config",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    args.push(mcp_config_path.to_string_lossy().into_owned());
    // `|| exit 2`: any other failure exit (a panic's 101, a missing exe)
    // would be non-blocking, i.e. the call would go through unguarded.
    let guard = format!("\"{}\" {AI_BASH_GUARD_FLAG} || exit 2", guard_exe.display());
    let settings = json!({ "hooks": { "PreToolUse": [{
        "matcher": "*",
        "hooks": [{ "type": "command", "command": guard }]
    }]}});
    args.push("--settings".into());
    args.push(settings.to_string());
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m.into());
    }
    args
}

/// argv[1] that makes riff.exe act as the PreToolUse hook (handled in
/// main.rs before Tauri starts).
pub const AI_BASH_GUARD_FLAG: &str = "--ai-bash-guard";

/// Words of `command` as bash would split them, or None when bash could
/// expand something (unquoted `\ $ { } * ? [`, or `\ $` in double quotes)
/// or a quote is unterminated: expansion could produce words the guard
/// never saw (`${IFS}--output=x`, `\-\-output`, `{--output=x,}`). Words
/// split on space and tab only, as bash does; any other whitespace (NBSP,
/// VT, FF, …) or control character (NUL, ESC, …) is refused because the
/// guard and bash would disagree on it, and so are unquoted `(`/`)`
/// (extglob patterns like `@(a.txt)`).
fn shell_words(command: &str) -> Option<Vec<String>> {
    if command
        .chars()
        .any(|c| (c.is_whitespace() || c.is_control()) && c != ' ' && c != '\t')
    {
        return None;
    }
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut quote: Option<char> = None;
    for c in command.chars() {
        match quote {
            Some('\'') if c == '\'' => quote = None,
            Some('"') if c == '"' => quote = None,
            Some('"') if matches!(c, '\\' | '$') => return None,
            Some(_) => word.get_or_insert_with(String::new).push(c),
            None if c == ' ' || c == '\t' => words.extend(word.take()),
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                word.get_or_insert_with(String::new);
            }
            None if matches!(c, '\\' | '$' | '{' | '}' | '*' | '?' | '[' | '(' | ')') => {
                return None
            }
            None => word.get_or_insert_with(String::new).push(c),
        }
    }
    if quote.is_some() {
        return None;
    }
    words.extend(word);
    Some(words)
}

/// How many words the option `w` takes in `git <sub>` (1, or 2 with a
/// separate value `next`), or None when it isn't on the allowlist. Only
/// exact spellings pass: no abbreviations, no `=value` unless listed.
fn option_words(sub: &str, w: &str, next: Option<&str>) -> Option<usize> {
    let num = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    // `%G…` asks gpg to verify the signature; `%(…)` runs describe and the
    // like; either may carry a `+`/`-`/` ` line flag after the `%`. Signing
    // programs are also disabled in `child_env`.
    let format = |s: &str| {
        !s.match_indices('%').any(|(i, _)| {
            let rest = &s[i + 1..];
            let rest = rest.strip_prefix(['+', '-', ' ']).unwrap_or(rest);
            rest.starts_with(['G', '('])
        })
    };
    let (flags, bundle): (&[&str], &str) = match sub {
        "show" => (
            &[
                "--stat",
                "--name-only",
                "--name-status",
                "-s",
                "--no-patch",
                "--oneline",
                "--no-color",
                "-M",
            ],
            "",
        ),
        "grep" => (
            &["--line-number", "--ignore-case", "--word-regexp"],
            "niwEFlchI",
        ),
        "log" => (
            &[
                "--oneline",
                "--name-only",
                "--name-status",
                "--stat",
                "-p",
                "--follow",
                "--no-merges",
                "--first-parent",
                "--reverse",
            ],
            "",
        ),
        "ls-tree" => (&["--name-only", "--full-tree"], "rltd"),
        "cat-file" => (&["-t", "-s", "-p", "-e"], ""),
        "merge-base" => (&["--is-ancestor", "--all"], ""),
        "rev-parse" => (&["--verify", "--short"], ""),
        _ => return None,
    };
    if flags.contains(&w) {
        return Some(1);
    }
    if let Some(letters) = w.strip_prefix('-') {
        if !bundle.is_empty() && !letters.is_empty() && letters.chars().all(|c| bundle.contains(c))
        {
            return Some(1);
        }
    }
    if let Some((name, value)) = w.split_once('=') {
        let ok = match (sub, name) {
            ("show" | "log", "--format" | "--pretty") => format(value),
            ("show", "--unified") | ("grep" | "log", "--max-count") | ("rev-parse", "--short") => {
                num(value)
            }
            ("log", "--since" | "--until" | "--author" | "--grep") => !value.is_empty(),
            _ => false,
        };
        if ok {
            return Some(1);
        }
    }
    let attached = |prefix: &str| w.strip_prefix(prefix);
    let ok = match sub {
        "show" => attached("-U").is_some_and(num),
        "grep" => ["-A", "-B", "-C"]
            .iter()
            .any(|p| attached(p).is_some_and(num)),
        "log" => {
            attached("-n").is_some_and(num)
                || attached("-").is_some_and(num)
                || attached("-S").is_some_and(|v| !v.is_empty())
                || attached("-G").is_some_and(|v| !v.is_empty())
        }
        _ => false,
    };
    if ok {
        return Some(1);
    }
    match (sub, w) {
        ("log", "-n") if next.is_some_and(num) => Some(2),
        ("grep", "-e") if next.is_some() => Some(2),
        _ => None,
    }
}

/// A rev, path or `rev:path` word: repo-relative only. Absolute, drive
/// (any single character then `:`, which Git for Windows treats as a drive:
/// `C:x`, `1:x`, `ä:x`), UNC (in any slash mix, which Windows git sends to
/// SMB) and `..` paths are refused, as is pathspec magic `:(…)`; a rev range
/// `a..b` is fine because its `..` touches no separator. Refused anywhere:
/// `{`/`}` (git skips colons inside `^{…}`/`@{…}`, so its `rev:path` split
/// would differ from the one checked here), and `=`/`~` (bash expands `~`
/// after `=`, MSYS rewrites `=/c/…` paths, so git would get another word).
fn positional_ok(w: &str) -> bool {
    if w.contains(['{', '}', '=', '~']) {
        return false;
    }
    let path_ok = |p: &str| {
        let mut chars = p.chars();
        let drive = chars.next().is_some() && chars.next() == Some(':');
        !(p.starts_with(['/', '\\'])
            || p.starts_with(":(")
            || drive
            || p == ".."
            || ["//", "\\\\", "/\\", "\\/", "../", "/..", "\\..", "..\\"]
                .iter()
                .any(|s| p.contains(s)))
    };
    path_ok(w) && w.split_once(':').is_none_or(|(_, path)| path_ok(path))
}

/// Whether the AI's Bash call is one read-only git command: `git <sub>` with
/// an allowed subcommand right after `git` (so no `-c`/`-C`/`--git-dir`), no
/// shell operators or expansions, only allowlisted options (`option_words`),
/// and repo-relative positionals (`positional_ok`). grep's pattern (the
/// first positional, or each `-e` value) is free text.
pub fn guard_allows(command: &str) -> bool {
    const SUBCOMMANDS: &[&str] = &[
        "show",
        "grep",
        "log",
        "ls-tree",
        "cat-file",
        "merge-base",
        "rev-parse",
    ];
    const OPERATORS: &[&str] = &[";", "&", "|", ">", "<", "`", "$(", "\n", "\r"];
    if OPERATORS.iter().any(|op| command.contains(op)) {
        return false;
    }
    let Some(words) = shell_words(command) else {
        return false;
    };
    let [git, sub, rest @ ..] = words.as_slice() else {
        return false;
    };
    let sub = sub.as_str();
    if git != "git" || !SUBCOMMANDS.contains(&sub) {
        return false;
    }
    let mut pattern_pending = sub == "grep" && !rest.iter().any(|w| w == "-e");
    let mut after_dashdash = false;
    let mut i = 0;
    while i < rest.len() {
        let w = rest[i].as_str();
        if w == "--" && !after_dashdash && matches!(sub, "show" | "grep" | "log") {
            after_dashdash = true;
            i += 1;
            continue;
        }
        if w.starts_with('-') {
            let next = rest.get(i + 1).map(String::as_str);
            match option_words(sub, w, next) {
                Some(n) if !after_dashdash => i += n,
                _ => return false,
            }
            continue;
        }
        if pattern_pending && !after_dashdash {
            pattern_pending = false;
        } else if !positional_ok(w) {
            return false;
        }
        i += 1;
    }
    true
}

/// The `AI_BASH_GUARD_FLAG` hook on its PreToolUse stdin JSON: Err (exit 2,
/// the reason goes to the model) blocks the call. Only Bash (through
/// `guard_allows`), the schema answer and the agentmemory tools of
/// `ALLOWED_TOOLS` pass; anything else, or input it can't read, is blocked.
pub fn guard_decision(hook_json: &str) -> Result<(), String> {
    const OTHER_TOOLS: &[&str] = &[
        "StructuredOutput",
        "mcp__agentmemory__memory_recall",
        "mcp__agentmemory__memory_smart_search",
        "mcp__agentmemory__memory_save",
    ];
    let v: Value = serde_json::from_str(hook_json)
        .map_err(|e| format!("riff AI guard: unreadable hook input: {e}"))?;
    let tool = v.get("tool_name").and_then(Value::as_str).unwrap_or("");
    if OTHER_TOOLS.contains(&tool) {
        return Ok(());
    }
    if tool != "Bash" {
        return Err(format!(
            "Blocked by riff: the {tool:?} tool is not available here."
        ));
    }
    let command = v
        .pointer("/tool_input/command")
        .and_then(Value::as_str)
        .ok_or("riff AI guard: no Bash command in hook input")?;
    if guard_allows(command) {
        return Ok(());
    }
    Err(format!(
        "Blocked by riff: run exactly one read-only git command per call, using only these \
         options: \
         git show [--stat --name-only --name-status -s --oneline --format=<f> -U<n> -M] <rev>[:<path>]; \
         git grep [-n -i -w -E -F -l -c -h -I -A<n> -B<n> -C<n> --max-count=<n> -e <pattern>] \
         <pattern> <rev> [-- <path>]; \
         git log [--oneline --format=<f> -n <N> --stat --name-only -p --follow --since=<d> \
         --author=<a> --grep=<re> -S<s> -G<re> --no-merges --first-parent --reverse] \
         [<range>] [-- <path>]; \
         git ls-tree [-r -l -t -d --name-only --full-tree] <rev> [<path>]; \
         git cat-file -t|-s|-p|-e <object>; git merge-base [--is-ancestor --all] <a> <b>; \
         git rev-parse [--verify --short] <rev>. \
         Paths are repo-relative (no absolute, drive, ~, .. or // paths); revs are names or \
         SHAs (no ^{{...}}, @{{...}}, ~ or =); formats can't use %G or %(; \
         no pipes, redirects, chaining, unquoted globs or $. Quote patterns with single quotes. \
         Blocked: {command}"
    ))
}

/// Checks the hook before a run relies on it. Claude Code treats any hook
/// exit other than 0/2 as non-blocking, so a guard that can't run would
/// silently allow everything; `|| exit 2` in the hook command covers a
/// crash, this covers a path the hook command can't quote and a guard that
/// doesn't block. `run_guard` feeds `input` to `exe` on stdin and returns
/// its exit code.
fn verify_guard(exe: &Path, run_guard: &dyn Fn(&Path, &str) -> Option<i32>) -> Result<(), AiError> {
    let unavailable = || AiError::Failed("AI guard unavailable".into());
    // Inside the hook's bash double quotes these expand, and a leading `\\`
    // (UNC install) collapses to one backslash.
    let path = exe.to_string_lossy();
    if path.contains(['"', '$', '`']) || path.starts_with("\\\\") {
        return Err(unavailable());
    }
    let probe = json!({
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": { "command": "cat x" }
    });
    match run_guard(exe, &probe.to_string()) {
        Some(2) => Ok(()),
        _ => Err(unavailable()),
    }
}

/// `exe --ai-bash-guard` with `input` on stdin; None if it can't be run or
/// takes over 5 s.
fn run_guard_exe(exe: &Path, input: &str) -> Option<i32> {
    let mut cmd = Command::new(exe);
    cmd.arg(AI_BASH_GUARD_FLAG)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let _ = stdin.write_all(input.as_bytes());
    drop(stdin);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().ok()? {
            return status.code();
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Variables a parent Claude Code session sets for its children; inherited,
/// they would make the run a nested session. Other `CLAUDE_CODE_*` are user
/// configuration (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_GIT_BASH_PATH`, …)
/// and stay.
fn is_nested_session_var(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    matches!(
        key.as_str(),
        "CLAUDECODE" | "CLAUDE_CODE_ENTRYPOINT" | "CLAUDE_CODE_SSE_PORT"
    ) || (key.starts_with("CLAUDE_CODE_") && key.contains("SESSION_ID"))
}

/// Env changes for the claude child, given riff's env: `Some` sets, `None`
/// removes. Command-scope git config (`GIT_CONFIG_COUNT`, above repo and
/// user config) disables what a read could still trigger: gpg (signature
/// placeholders, `log.showSignature`), fsmonitor, and any transport (lazy
/// fetch in a partial clone). Entries go after any the user already set;
/// `GIT_CONFIG_PARAMETERS` (a parent's `git -c`) would override them, so it
/// goes. Attributes come from the empty tree only (no working-tree,
/// system or global `.gitattributes`), so no textconv or filter driver is
/// ever selected.
fn child_env(parent: &[(String, String)]) -> Vec<(String, Option<String>)> {
    const NULL_DEVICE: &str = if cfg!(windows) { "nul" } else { "/dev/null" };
    const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const GIT_CONFIG: &[(&str, &str)] = &[
        ("gpg.program", "riff-gpg-disabled"),
        ("gpg.ssh.program", "riff-gpg-disabled"),
        ("gpg.x509.program", "riff-gpg-disabled"),
        ("core.fsmonitor", "false"),
        ("protocol.allow", "never"),
        // The null device: a relative value resolves against the worktree,
        // where a PR could add the file.
        ("core.attributesFile", NULL_DEVICE),
    ];
    let mut env: Vec<(String, Option<String>)> = parent
        .iter()
        .filter(|(k, _)| is_nested_session_var(k))
        .map(|(k, _)| (k.clone(), None))
        .collect();
    let base: usize = parent
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("GIT_CONFIG_COUNT"))
        .and_then(|(_, v)| v.trim().parse().ok())
        .unwrap_or(0);
    for (i, (key, value)) in GIT_CONFIG.iter().enumerate() {
        env.push((
            format!("GIT_CONFIG_KEY_{}", base + i),
            Some(key.to_string()),
        ));
        env.push((
            format!("GIT_CONFIG_VALUE_{}", base + i),
            Some(value.to_string()),
        ));
    }
    let set = |k: &str, v: String| (k.to_string(), Some(v));
    env.extend([
        set("GIT_CONFIG_COUNT", (base + GIT_CONFIG.len()).to_string()),
        set("GIT_NO_LAZY_FETCH", "1".into()),
        set("GIT_TERMINAL_PROMPT", "0".into()),
        set("GIT_PAGER", "cat".into()),
        set("GIT_ATTR_SOURCE", EMPTY_TREE.into()),
        set("GIT_ATTR_NOSYSTEM", "1".into()),
        ("GIT_EXTERNAL_DIFF".to_string(), None),
        ("GIT_CONFIG_PARAMETERS".to_string(), None),
    ]);
    env
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AiEvent {
    /// A tool call, for the progress line.
    Activity { text: String },
    /// The run's `result` line; `output` is Null unless it succeeded with
    /// structured output.
    Result {
        output: Value,
        cost_usd: Option<f64>,
    },
}

/// One stream-json line. Everything but tool calls and the result is noise.
pub fn parse_stream_line(line: &str) -> Option<AiEvent> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    match v.get("type")?.as_str()? {
        "assistant" => {
            let tool = v
                .pointer("/message/content")?
                .as_array()?
                .iter()
                .find(|c| c.get("type").and_then(Value::as_str) == Some("tool_use"))?;
            let name = tool.get("name").and_then(Value::as_str).unwrap_or("tool");
            let text = match tool.pointer("/input/command").and_then(Value::as_str) {
                Some(cmd) => format!("{name}: {}", cmd.chars().take(80).collect::<String>()),
                None => name.to_string(),
            };
            Some(AiEvent::Activity { text })
        }
        "result" => {
            let success = v.get("subtype").and_then(Value::as_str) == Some("success");
            let output = match v.get("structured_output") {
                Some(o) if success => o.clone(),
                _ => Value::Null,
            };
            let cost_usd = v.get("total_cost_usd").and_then(Value::as_f64);
            Some(AiEvent::Result { output, cost_usd })
        }
        _ => None,
    }
}

#[derive(Debug, Error, PartialEq)]
pub enum AiError {
    #[error("Claude Code CLI is not installed")]
    NotInstalled,
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Failed(String),
}

impl serde::Serialize for AiError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Removes the generated MCP config however `run` returns.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn write_mcp_config() -> Result<TempFile, AiError> {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let claude_json = home_dir()
        .and_then(|h| std::fs::read_to_string(h.join(".claude.json")).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let file = TempFile(std::env::temp_dir().join(format!(
        "riff-ai-mcp-{}-{}.json",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    let body = serde_json::to_vec(&agentmemory_mcp_config(&claude_json))
        .map_err(|e| AiError::Failed(e.to_string()))?;
    std::fs::write(&file.0, body).map_err(|e| AiError::Failed(e.to_string()))?;
    Ok(file)
}

/// One read-only Claude Code run in `cwd`. `on_event` gets tool activity and
/// the result line; `cancelled` is polled while claude runs and true kills it.
/// Returns the structured output matching `schema_json`.
pub fn run(
    cwd: &Path,
    prompt: &str,
    schema_json: &str,
    model: Option<&str>,
    on_event: &mut dyn FnMut(AiEvent),
    cancelled: &dyn Fn() -> bool,
) -> Result<Value, AiError> {
    let path_var = std::env::var_os("PATH");
    let program = resolve_claude(path_var.as_deref(), home_dir().as_deref(), &|p| p.is_file())
        .ok_or(AiError::NotInstalled)?;
    let guard_exe = std::env::current_exe().map_err(|e| AiError::Failed(e.to_string()))?;
    verify_guard(&guard_exe, &run_guard_exe)?;
    let mcp_config = write_mcp_config()?;
    let mut cmd = Command::new(program);
    // `vars()` would panic on a non-Unicode variable; those can't be ours.
    let parent: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect();
    for (key, value) in child_env(&parent) {
        match value {
            Some(v) => cmd.env(key, v),
            None => cmd.env_remove(key),
        };
    }
    cmd.args(claude_args(schema_json, &mcp_config.0, &guard_exe, model))
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // No console window flashing up (see `git_command`).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AiError::NotInstalled,
        _ => AiError::Failed(e.to_string()),
    })?;
    if let Some(mut stdin) = child.stdin.take() {
        let prompt = prompt.to_string();
        // Own thread so a long prompt can't deadlock against claude filling
        // its stdout pipe; dropping stdin ends the prompt.
        std::thread::spawn(move || stdin.write_all(prompt.as_bytes()));
    }
    let (tx, rx) = mpsc::channel::<(bool, String)>();
    let streams: [(bool, Option<Box<dyn Read + Send>>); 2] = [
        (false, child.stdout.take().map(|s| Box::new(s) as _)),
        (true, child.stderr.take().map(|s| Box::new(s) as _)),
    ];
    for (is_stderr, stream) in streams {
        let Some(stream) = stream else { continue };
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { break };
                if tx.send((is_stderr, line)).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);

    let mut output = Value::Null;
    let mut stderr_tail: Vec<String> = Vec::new();
    let mut feed = |is_stderr: bool, line: String| {
        if is_stderr {
            if !line.trim().is_empty() {
                stderr_tail.push(line.trim().to_string());
                if stderr_tail.len() > 3 {
                    stderr_tail.remove(0);
                }
            }
            return;
        }
        if let Some(ev) = parse_stream_line(&line) {
            if let AiEvent::Result { output: o, .. } = &ev {
                output = o.clone();
            }
            on_event(ev);
        }
    };
    let tick = Duration::from_millis(100);
    loop {
        match rx.recv_timeout(tick) {
            Ok((is_stderr, line)) => feed(is_stderr, line),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => std::thread::sleep(tick),
        }
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AiError::Cancelled);
        }
        if child
            .try_wait()
            .map_err(|e| AiError::Failed(e.to_string()))?
            .is_some()
        {
            break;
        }
    }
    // Lines written just before exit; bounded so a process that inherited
    // the pipes (a hook, the MCP server) can't hold this open.
    while let Ok((is_stderr, line)) = rx.recv_timeout(Duration::from_millis(200)) {
        feed(is_stderr, line);
    }
    if !output.is_null() {
        return Ok(output);
    }
    Err(AiError::Failed(if stderr_tail.is_empty() {
        "no structured output".into()
    } else {
        stderr_tail.join("\n")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exists_in<'a>(present: &'a [PathBuf]) -> impl Fn(&Path) -> bool + 'a {
        move |p| present.iter().any(|x| x == p)
    }

    #[test]
    fn resolve_claude_prefers_absolute_path_then_local_bin() {
        let path_var = std::ffi::OsString::from(r"C:\a;;rel;C:\b;");
        let home = PathBuf::from(r"C:\Users\me");
        let on_path = PathBuf::from(r"C:\b").join(CLAUDE_EXE);
        let local = home.join(".local").join("bin").join(CLAUDE_EXE);
        let relative = PathBuf::from("rel").join(CLAUDE_EXE);

        let all = [relative.clone(), on_path.clone(), local.clone()];
        assert_eq!(
            resolve_claude(Some(&path_var), Some(&home), &exists_in(&all)),
            Some(on_path)
        );
        let no_path = [relative.clone(), local.clone()];
        assert_eq!(
            resolve_claude(Some(&path_var), Some(&home), &exists_in(&no_path)),
            Some(local)
        );
        assert_eq!(
            resolve_claude(Some(&path_var), Some(&home), &exists_in(&[relative])),
            None
        );
        assert_eq!(resolve_claude(None, None, &|_| true), None);
    }

    #[test]
    fn agentmemory_config_keeps_only_agentmemory() {
        let claude_json = json!({
            "numStartups": 3,
            "mcpServers": {
                "agentmemory": {"command": "node", "args": ["bin.mjs"], "env": {"AGENTMEMORY_URL": "${AGENTMEMORY_URL}"}},
                "slack": {"command": "slack-mcp"}
            }
        });
        assert_eq!(
            agentmemory_mcp_config(&claude_json),
            json!({"mcpServers": {"agentmemory": {"command": "node", "args": ["bin.mjs"], "env": {"AGENTMEMORY_URL": "${AGENTMEMORY_URL}"}}}})
        );
    }

    #[test]
    fn agentmemory_config_empty_when_missing() {
        for v in [
            json!({}),
            json!({"mcpServers": {"slack": {"command": "slack-mcp"}}}),
            Value::Null,
        ] {
            assert_eq!(agentmemory_mcp_config(&v), json!({"mcpServers": {}}), "{v}");
        }
    }

    #[test]
    fn claude_args_exact() {
        let schema = r#"{"type":"object"}"#;
        let cfg = PathBuf::from(r"C:\tmp\riff-ai-mcp-1-0.json");
        let base: Vec<String> = [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--json-schema",
            r#"{"type":"object"}"#,
            "--tools",
            "Bash",
            "--allowedTools",
            "Bash(git show:*)",
            "Bash(git grep:*)",
            "Bash(git log:*)",
            "Bash(git ls-tree:*)",
            "Bash(git cat-file:*)",
            "Bash(git merge-base:*)",
            "Bash(git rev-parse:*)",
            "mcp__agentmemory__memory_recall",
            "mcp__agentmemory__memory_smart_search",
            "mcp__agentmemory__memory_save",
            "--disallowedTools",
            "Bash(*--output*)",
            "Bash(*--open-files-in-pager*)",
            "Bash(* -O*)",
            "Bash(*>*)",
            "Bash(*|*)",
            "Bash(*;*)",
            "Bash(*&*)",
            "Bash(*$(*)",
            "Bash(*`*)",
            "Bash(git -*)",
            "Bash(*--ext-diff*)",
            "--permission-mode",
            "dontAsk",
            "--strict-mcp-config",
            "--mcp-config",
            r"C:\tmp\riff-ai-mcp-1-0.json",
            "--settings",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let exe = PathBuf::from(r"C:\Program Files\riff\riff.exe");
        let settings = json!({"hooks": {"PreToolUse": [{
            "matcher": "*",
            "hooks": [{"type": "command", "command": r#""C:\Program Files\riff\riff.exe" --ai-bash-guard || exit 2"#}]
        }]}});
        let split = |args: Vec<String>| {
            let at = base.len();
            let parsed: Value = serde_json::from_str(&args[at]).unwrap();
            (args[..at].to_vec(), parsed, args[at + 1..].to_vec())
        };
        assert_eq!(
            split(claude_args(schema, &cfg, &exe, None)),
            (base.clone(), settings.clone(), vec![])
        );
        assert_eq!(
            split(claude_args(schema, &cfg, &exe, Some("sonnet"))),
            (
                base.clone(),
                settings,
                vec!["--model".into(), "sonnet".into()]
            )
        );
    }

    #[test]
    fn guard_allows_single_read_only_git_commands() {
        for ok in [
            "git show abc:src/a.rs",
            "git grep -n foo abc -- a.rs",
            "git log --format=%s a..b",
            r#"git grep -n "a b" 0123abc"#,
            "git grep -n 'x' HEAD -- 'src/*.rs'",
            "git ls-tree -r --name-only HEAD",
            "git cat-file -p HEAD",
            "git merge-base a b",
            "git rev-parse HEAD",
            "git log --oneline -5",
            "git log --follow --first-parent --format=%s -- a.rs",
            "git grep -n -e foo HEAD",
            "  git show HEAD  ",
            // Typical AI reads.
            "git show abc123:src/a.rs",
            r#"git grep -n -e "foo(" abc -- src"#,
            "git log --oneline -n 20 a..b -- src/x.rs",
            "git log --format=%h%x20%s a..b",
            "git ls-tree -r --name-only abc",
            "git cat-file -p abc",
            "git rev-parse --short HEAD",
            "git rev-parse --verify --short=12 HEAD",
            "git show --stat --format=%H%n%an -U5 abc",
            "git show -s --oneline --no-color -M abc",
            "git show --unified=10 --name-status a...b",
            "git grep -nIiw -A3 -B2 -C1 --max-count=5 foo HEAD -- src",
            "git grep -e foo -e '-x' HEAD",
            "git grep -lc --line-number --ignore-case --word-regexp foo HEAD",
            "git log -p -n5 -3 --max-count=4 --stat --reverse --no-merges HEAD",
            "git log --since=2.weeks --until=2026-01-01 --author=bob '--grep=fix this' HEAD",
            "git log -Sneedle -G'a.*b' --name-only HEAD..",
            "git ls-tree -rtd --full-tree HEAD src",
            "git cat-file -t abc",
            "git cat-file blob abc",
            "git merge-base --is-ancestor a b",
            "git merge-base --all a b",
            "git grep -n '//host/x' HEAD",
            "git log\t--oneline\tHEAD",
            "git log --format='%h %s' -1",
            "git log --format='%h %s' a..b",
            "git grep -n 'a=~(b)' HEAD",
        ] {
            assert!(guard_allows(ok), "{ok}");
        }
        for bad in [
            "",
            "   ",
            "git",
            "cat x",
            "ls",
            "npm install",
            "git diff --output=x",
            "git status",
            "git -c core.pager=cat log",
            "git -C .. log",
            "git --git-dir=x log",
            "git --work-tree=x show HEAD",
            "git --exec-path=x log",
            "git show x > f",
            "git show x>f",
            "git show x < f",
            "git log | head",
            "git grep -O foo",
            "git grep -Ovim foo",
            "git grep -nO foo",
            "git grep --open-files-in-pager foo",
            "git grep --open foo",
            "git log --output=x",
            "git log --out=x",
            "git log -p --ext-diff",
            "git show --textconv HEAD:a",
            "git show x; rm y",
            "git show x && rm y",
            "git show x & rm y",
            "git show x\nrm y",
            "git show $(rm y)",
            "git show `rm y`",
            r#"git show HEAD "--out"'put=x'"#,
            "git show HEAD ${IFS}--output=x",
            r"git show HEAD \-\-output=x",
            "git show {--output=x,HEAD}",
            "git ls-tree HEAD src/*",
            r#"git grep "unterminated"#,
            "FOO=1 git show HEAD",
            "/usr/bin/git show HEAD",
            "git showx HEAD",
            // Options that read files outside git objects or run programs.
            "git grep -f x HEAD",
            "git grep -E -f x HEAD",
            "git grep -nf x HEAD",
            "git grep --file=x HEAD",
            "git log -f x",
            "git log -pO x",
            "git log -pOx",
            "git show -pO x HEAD",
            "git grep --no-index foo",
            "git grep --untracked foo",
            "git rev-parse --resolve-git-dir x",
            "git cat-file --filters HEAD:a",
            "git log --show-signature -1",
            "git show HEAD -- //host/s",
            r"git show HEAD -- '\\host\s'",
            "git show ~/x",
            "git show '~/x'",
            // UNC spellings that reached SMB, gpg via placeholders, other paths.
            r"git show HEAD -- '/\host\s'",
            r"git grep foo HEAD -- '\/host/s'",
            "git grep foo HEAD -- ':(literal)//host/s'",
            "git log --format=%GG -1",
            "git log --pretty=%GS",
            "git log --format='%G?'",
            "git log --format=%(describe)",
            "git log --format",
            "git show C:/x",
            r"git show 'C:\x'",
            "git show HEAD:C:/x",
            "git show HEAD:/etc/passwd",
            "git log -- ../x",
            "git log -- a/../b",
            r"git log -- 'a\..\b'",
            "git log ..",
            "git log -- /etc/passwd",
            "git log --exec=x",
            "git log --upload-pack=x",
            "git log --no-ext-diff",
            "git rev-parse --show-toplevel",
            "git rev-parse --git-path x",
            "git log -n x",
            "git log -n",
            "git show -U",
            "git show -Ux",
            "git grep -A foo HEAD",
            "git grep -e",
            "git log -S",
            "git ls-tree -rx HEAD",
            "git cat-file --batch",
            "git cat-file -tp abc",
            "git merge-base --octopus a b",
            "git rev-parse -- x",
            "git ls-tree HEAD -- src",
            "git show HEAD -- --stat",
            // P2-R7: format flag variants, whitespace bash doesn't split on,
            // {} rev syntax (git skips colons inside it), drive-relative paths.
            "git log --format=%+GG -1",
            "git log --format=%-GG -1",
            "git log '--format=% GG' -1",
            "git log '--format=%+G?' -1",
            "git log --format=%+(describe) -1",
            "git log --pretty=%-(describe) -1",
            "git log --format=%s\u{a0}%GG -1",
            "git log --format=%s\u{a0}x -1",
            "git show HEAD\u{b}x",
            "git show HEAD\u{c}x",
            "git show HEAD\u{3000}x",
            "git show 'HEAD^{/:}:C:/x'",
            "git show 'HEAD^{/:}:/Windows'",
            "git show 'HEAD@{1}'",
            "git show 'abc^{tree}'",
            "git log -- 'Q:x'",
            "git log -- 'C:Windows'",
            "git show 'abc:C:x'",
            "git show Q:",
            // P2-R8: any single char before `:` is a drive to Git for
            // Windows; `=`/`~` change what bash/MSYS hand git; control chars;
            // unquoted parentheses (extglob).
            "git show '1:x'",
            "git show '_:x'",
            "git show 'ä:x'",
            "git show 'HEAD:1:x'",
            "git show 'HEAD:.:/x'",
            "git show a=~/.gitconfig",
            "git log -- a=/c/Windows/win.ini",
            "git show HEAD~1",
            "git show HE\u{0}AD",
            "git show HEAD\u{1b}x",
            "git show HEAD (x)",
            "git log -- @(a.txt)",
        ] {
            assert!(!guard_allows(bad), "{bad:?}");
        }
    }

    #[test]
    fn guard_decision_blocks_only_bad_bash() {
        let bash = |cmd: &str| {
            json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}})
                .to_string()
        };
        assert_eq!(guard_decision(&bash("git show HEAD:a.rs")), Ok(()));
        let err = guard_decision(&bash("cat package.json")).unwrap_err();
        assert!(err.contains("cat package.json"), "{err}");
        let tool =
            |name: &str| json!({"tool_name": name, "tool_input": {"query": "x"}}).to_string();
        for ok in [
            "StructuredOutput",
            "mcp__agentmemory__memory_recall",
            "mcp__agentmemory__memory_smart_search",
            "mcp__agentmemory__memory_save",
        ] {
            assert_eq!(guard_decision(&tool(ok)), Ok(()), "{ok}");
        }
        for bad in [
            "mcp__agentmemory__memory_governance_delete",
            "Read",
            "Write",
            "PowerShell",
            "mcp__plugin_atlassian_atlassian__executeWrite",
            "",
        ] {
            assert!(guard_decision(&tool(bad)).is_err(), "{bad}");
        }
        // Fail closed on input the guard can't read.
        assert!(guard_decision("not json").is_err());
        assert!(guard_decision(r#"{"tool_input":{}}"#).is_err());
        assert!(guard_decision(r#"{"tool_name":"Bash","tool_input":{}}"#).is_err());
    }

    #[test]
    fn verify_guard_needs_a_quotable_path_and_a_blocking_guard() {
        let exe = Path::new(r"C:\Program Files\riff\riff.exe");
        let exits = |code: Option<i32>| move |_: &Path, _: &str| code;
        assert_eq!(verify_guard(exe, &exits(Some(2))), Ok(()));
        for broken in [Some(0), Some(1), Some(101), None] {
            assert_eq!(
                verify_guard(exe, &exits(broken)),
                Err(AiError::Failed("AI guard unavailable".into())),
                "{broken:?}"
            );
        }
        // The self-test input is a Bash call the guard has to block.
        verify_guard(exe, &|_, input| {
            assert!(guard_decision(input).is_err(), "{input}");
            Some(2)
        })
        .unwrap();
        for bad in [
            r#"C:\a"b\riff.exe"#,
            r"C:\$x\riff.exe",
            r"C:\`x`\riff.exe",
            r"\\server\share\riff.exe",
        ] {
            assert!(
                verify_guard(Path::new(bad), &exits(Some(2))).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn nested_session_vars_are_dropped() {
        for k in [
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_SSE_PORT",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_CODE_PARENT_SESSION_ID_X",
            "claudecode",
        ] {
            assert!(is_nested_session_var(k), "{k}");
        }
        for k in [
            "CLAUDE_CODE_GIT_BASH_PATH",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_POWERSHELL_TOOL",
            "PATH",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CONFIG_DIR",
        ] {
            assert!(!is_nested_session_var(k), "{k}");
        }
    }

    #[test]
    fn child_env_neutralizes_git_config_and_drops_session_vars() {
        let set = |k: &str, v: &str| (k.to_string(), Some(v.to_string()));
        let unset = |k: &str| (k.to_string(), None);
        let parent = |vars: &[(&str, &str)]| -> Vec<(String, String)> {
            vars.iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        // Relative values resolve against the worktree, where a PR could add
        // the file; the null device can't be shadowed.
        let null_device = if cfg!(windows) { "nul" } else { "/dev/null" };
        let env = child_env(&parent(&[
            ("PATH", "C:\\bin"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_SESSION_ID", "s"),
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
        ]));
        let mut want = vec![unset("CLAUDECODE"), unset("CLAUDE_CODE_SESSION_ID")];
        for (i, (k, v)) in [
            ("gpg.program", "riff-gpg-disabled"),
            ("gpg.ssh.program", "riff-gpg-disabled"),
            ("gpg.x509.program", "riff-gpg-disabled"),
            ("core.fsmonitor", "false"),
            ("protocol.allow", "never"),
            ("core.attributesFile", null_device),
        ]
        .into_iter()
        .enumerate()
        {
            want.push(set(&format!("GIT_CONFIG_KEY_{i}"), k));
            want.push(set(&format!("GIT_CONFIG_VALUE_{i}"), v));
        }
        want.extend([
            set("GIT_CONFIG_COUNT", "6"),
            set("GIT_NO_LAZY_FETCH", "1"),
            set("GIT_TERMINAL_PROMPT", "0"),
            set("GIT_PAGER", "cat"),
            set(
                "GIT_ATTR_SOURCE",
                "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            ),
            set("GIT_ATTR_NOSYSTEM", "1"),
            unset("GIT_EXTERNAL_DIFF"),
            unset("GIT_CONFIG_PARAMETERS"),
        ]);
        assert_eq!(env, want);

        // The user's own GIT_CONFIG_* entries stay; riff's follow them.
        let env = child_env(&parent(&[("GIT_CONFIG_COUNT", "2")]));
        assert!(env.contains(&set("GIT_CONFIG_KEY_2", "gpg.program")));
        assert!(env.contains(&set("GIT_CONFIG_KEY_6", "protocol.allow")));
        assert!(env.contains(&set("GIT_CONFIG_KEY_7", "core.attributesFile")));
        assert!(env.contains(&set("GIT_CONFIG_COUNT", "8")));
        assert!(!env
            .iter()
            .any(|(k, _)| k == "GIT_CONFIG_KEY_0" || k == "GIT_CONFIG_KEY_1"));
    }

    // Trimmed from a real `claude -p --output-format stream-json --verbose` run
    // (Claude Code 2.1.319); the Bash variant swaps name/input on the same shape.
    const STRUCTURED_TOOL_USE: &str = r#"{"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_011CgrVLsWQ5i8Gi3CPR7i97","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01KZ2tijMf3GfNJQQjojehci","name":"StructuredOutput","input":{"ok":true},"caller":{"type":"direct"}}],"stop_reason":null},"parent_tool_use_id":null,"session_id":"283c94fc-0769-4417-85b4-6c5cc99239bb"}"#;
    const BASH_TOOL_USE: &str = r#"{"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_011CgrVLsWQ5i8Gi3CPR7i97","type":"message","role":"assistant","content":[{"type":"text","text":"Reading the file."},{"type":"tool_use","id":"toolu_01KZ2tijMf3GfNJQQjojehci","name":"Bash","input":{"command":"git show 0123456789abcdef0123456789abcdef01234567:src-tauri/src/github/mod.rs --format=raw --no-patch --stat","description":"Show file"},"caller":{"type":"direct"}}],"stop_reason":null},"parent_tool_use_id":null,"session_id":"283c94fc-0769-4417-85b4-6c5cc99239bb"}"#;
    const TEXT_ONLY: &str = r#"{"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_011CgrVLhWPF3Ru1UifGxpMR","type":"message","role":"assistant","content":[{"type":"text","text":"{\"ok\":true}"}],"stop_reason":null},"parent_tool_use_id":null,"session_id":"283c94fc-0769-4417-85b4-6c5cc99239bb"}"#;
    const SUCCESS_RESULT: &str = r#"{"duration_api_ms":3431,"stop_reason":"tool_use","session_id":"283c94fc-0769-4417-85b4-6c5cc99239bb","total_cost_usd":0.01118273,"permission_denials":[],"terminal_reason":"completed","is_error":false,"num_turns":3,"subtype":"success","api_error_status":null,"result":"{\"ok\":true}","structured_output":{"ok":true},"type":"result","duration_ms":5522}"#;

    #[test]
    fn parse_tool_use_line_is_activity() {
        assert_eq!(
            parse_stream_line(BASH_TOOL_USE),
            Some(AiEvent::Activity {
                text: "Bash: git show 0123456789abcdef0123456789abcdef01234567:src-tauri/src/github/mod.rs --"
                    .into()
            })
        );
        assert_eq!(
            parse_stream_line(STRUCTURED_TOOL_USE),
            Some(AiEvent::Activity {
                text: "StructuredOutput".into()
            })
        );
    }

    #[test]
    fn parse_success_result_returns_structured_output() {
        assert_eq!(
            parse_stream_line(SUCCESS_RESULT),
            Some(AiEvent::Result {
                output: json!({"ok": true}),
                cost_usd: Some(0.01118273)
            })
        );
    }

    #[test]
    fn parse_result_without_structured_output_is_error() {
        let no_output = SUCCESS_RESULT.replace(r#""structured_output":{"ok":true},"#, "");
        let max_turns =
            SUCCESS_RESULT.replace(r#""subtype":"success""#, r#""subtype":"error_max_turns""#);
        for line in [no_output, max_turns] {
            assert!(
                matches!(
                    parse_stream_line(&line),
                    Some(AiEvent::Result {
                        output: Value::Null,
                        ..
                    })
                ),
                "{line}"
            );
        }
    }

    #[test]
    fn parse_noise_is_none() {
        for noise in [
            "",
            "not json",
            TEXT_ONLY,
            r#"{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}"#,
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01","type":"tool_result","content":"ok"}]}}"#,
        ] {
            assert_eq!(parse_stream_line(noise), None, "{noise}");
        }
    }
}
