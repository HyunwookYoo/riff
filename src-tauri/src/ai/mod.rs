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
/// never saw (`${IFS}--output=x`, `\-\-output`, `{--output=x,}`).
fn shell_words(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut quote: Option<char> = None;
    for c in command.chars() {
        match quote {
            Some('\'') if c == '\'' => quote = None,
            Some('"') if c == '"' => quote = None,
            Some('"') if matches!(c, '\\' | '$') => return None,
            Some(_) => word.get_or_insert_with(String::new).push(c),
            None if c.is_whitespace() => words.extend(word.take()),
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                word.get_or_insert_with(String::new);
            }
            None if matches!(c, '\\' | '$' | '{' | '}' | '*' | '?' | '[') => return None,
            None => word.get_or_insert_with(String::new).push(c),
        }
    }
    if quote.is_some() {
        return None;
    }
    words.extend(word);
    Some(words)
}

/// Whether the AI's Bash call is one read-only git command: `git <sub>` with
/// an allowed subcommand right after `git` (so no `-c`/`-C`/`--git-dir`), no
/// shell operators, and no option that writes a file, runs a program or
/// reads a file outside git objects. Long options also match by prefix both
/// ways, because git accepts abbreviations (`--out=x` is `--output=x`).
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
    const UNSAFE_LONG: &[&str] = &[
        // write a file
        "output",
        // run a program (configured diff driver, filter, gpg)
        "ext-diff",
        "textconv",
        "filters",
        "show-signature",
        "open-files-in-pager",
        // read a file outside git objects
        "file",
        "no-index",
        "untracked",
        "resolve-git-dir",
    ];
    if OPERATORS.iter().any(|op| command.contains(op)) {
        return false;
    }
    let Some(words) = shell_words(command) else {
        return false;
    };
    let [git, sub, rest @ ..] = words.as_slice() else {
        return false;
    };
    if git != "git" || !SUBCOMMANDS.contains(&sub.as_str()) {
        return false;
    }
    rest.iter().all(|w| {
        // UNC paths (`//host/x`) reach the network on Windows; `~` is home.
        if w.starts_with("//") || w.starts_with("\\\\") || w.starts_with('~') {
            return false;
        }
        if let Some(long) = w.strip_prefix("--") {
            let name = long.split('=').next().unwrap_or_default();
            name.is_empty()
                || !UNSAFE_LONG
                    .iter()
                    .any(|u| u.starts_with(name) || name.starts_with(u))
        } else if let Some(short) = w.strip_prefix('-') {
            // Short flags bundle (`-nO`, `-pOx`): `O` is grep's pager command
            // and log/show's orderfile, `f` grep's pattern file.
            !(short.contains('O') || short == "f" || (sub == "grep" && short.contains('f')))
        } else {
            true
        }
    })
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
        "Blocked by riff: run exactly one read-only git command per call \
         (git show, grep, log, ls-tree, cat-file, merge-base or rev-parse) with no pipes, \
         redirects, chaining, options before the subcommand, unquoted globs or $. \
         Quote patterns with single quotes. Blocked: {command}"
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
    if exe
        .to_string_lossy()
        .contains(|c| matches!(c, '"' | '$' | '`'))
    {
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

/// `exe --ai-bash-guard` with `input` on stdin; None if it can't be run.
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
    child.wait().ok()?.code()
}

/// Variables a parent Claude Code session sets for its children; inherited,
/// they would make the run a nested session. `CLAUDE_CODE_GIT_BASH_PATH` is
/// user configuration (where Git Bash lives on Windows), not session state.
fn is_nested_session_var(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key == "CLAUDECODE" || (key.starts_with("CLAUDE_CODE_") && key != "CLAUDE_CODE_GIT_BASH_PATH")
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
    for (key, _) in std::env::vars_os() {
        if key.to_str().is_some_and(is_nested_session_var) {
            cmd.env_remove(key);
        }
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
            "git log --oneline -5 --no-ext-diff",
            "git log --follow --first-parent --format=%s -- a.rs",
            "git rev-parse --show-toplevel",
            "git grep -n -e foo HEAD",
            "  git show HEAD  ",
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
        for bad in [r#"C:\a"b\riff.exe"#, r"C:\$x\riff.exe", r"C:\`x`\riff.exe"] {
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
            "CLAUDE_CODE_SESSION_ID",
            "claudecode",
        ] {
            assert!(is_nested_session_var(k), "{k}");
        }
        for k in [
            "CLAUDE_CODE_GIT_BASH_PATH",
            "PATH",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CONFIG_DIR",
        ] {
            assert!(!is_nested_session_var(k), "{k}");
        }
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
