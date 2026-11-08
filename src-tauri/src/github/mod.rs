//! GitHub access through the user's `gh` CLI login. riff never sees or stores
//! a token; `gh api --hostname <host>` carries the authentication.

use serde_json::Value;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;
use thiserror::Error;

const GH_EXE: &str = if cfg!(windows) { "gh.exe" } else { "gh" };

/// The gh shipped with the app (`resources/gh/gh.exe`), set once at setup.
static BUNDLED_GH: OnceLock<PathBuf> = OnceLock::new();

pub fn set_bundled_gh(path: PathBuf) {
    let _ = BUNDLED_GH.set(path);
}

/// First existing of: `gh` in a PATH directory, `<Program Files>\GitHub CLI`,
/// the bundled copy.
pub fn resolve_gh(
    path_var: Option<&OsStr>,
    program_files: Option<&Path>,
    bundled: Option<&Path>,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let on_path = path_var
        .into_iter()
        .flat_map(std::env::split_paths)
        // Empty (`;;`) or relative entries would resolve against riff's cwd.
        .filter(|d| d.is_absolute())
        .map(|d| d.join(GH_EXE));
    let installed = program_files.map(|p| p.join("GitHub CLI").join(GH_EXE));
    on_path
        .chain(installed)
        .chain(bundled.map(Path::to_path_buf))
        .find(|p| exists(p))
}

/// Resolved on every call: riff's own PATH predates a gh installed while it
/// runs, so the Program Files location is checked too.
fn gh_program() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH");
    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
    resolve_gh(
        path_var.as_deref(),
        program_files.as_deref(),
        BUNDLED_GH.get().map(PathBuf::as_path),
        &|p| p.is_file(),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GhStatus {
    Ready,
    NotInstalled,
    NotLoggedIn,
}

#[derive(Debug, Error, PartialEq)]
pub enum GhError {
    #[error("gh CLI is not installed")]
    NotInstalled,
    #[error("{0}")]
    Api(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("failed to parse gh output: {0}")]
    Parse(String),
}

impl serde::Serialize for GhError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// The resolved gh with `CREATE_NO_WINDOW` on Windows (see `git_command`)
/// and prompts disabled so a missing login fails instead of waiting on stdin.
fn gh_command() -> Result<Command, GhError> {
    let mut cmd = Command::new(gh_program().ok_or(GhError::NotInstalled)?);
    cmd.env("GH_PROMPT_DISABLED", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

fn spawn_error(e: std::io::Error) -> GhError {
    if e.kind() == std::io::ErrorKind::NotFound {
        GhError::NotInstalled
    } else {
        GhError::Io(e.to_string())
    }
}

pub fn gh_args(host: &str, method: &str, endpoint: &str, has_body: bool) -> Vec<String> {
    let mut args: Vec<String> = ["api", "--hostname", host, "-X", method, endpoint]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if has_body {
        args.push("--input".into());
        args.push("-".into());
    }
    args
}

fn error_messages(v: &Value) -> Vec<String> {
    v.get("errors")
        .and_then(Value::as_array)
        .map(|errs| {
            errs.iter()
                .filter_map(|e| match e {
                    Value::String(s) => Some(s.clone()),
                    _ => e.get("message").and_then(Value::as_str).map(str::to_string),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn interpret(ok: bool, stdout: &[u8], stderr: &[u8]) -> Result<Value, GhError> {
    let text = String::from_utf8_lossy(stdout);
    let parsed: Option<Value> = serde_json::from_str(text.trim()).ok();
    if !ok {
        let mut msg = String::new();
        if let Some(v) = &parsed {
            if let Some(m) = v.get("message").and_then(Value::as_str) {
                msg = m.to_string();
            }
            let errs = error_messages(v);
            if !errs.is_empty() {
                if !msg.is_empty() {
                    msg.push_str(": ");
                }
                msg.push_str(&errs.join("; "));
            }
        }
        if msg.is_empty() {
            msg = String::from_utf8_lossy(stderr).trim().to_string();
        }
        if msg.is_empty() {
            msg = "gh api failed".into();
        }
        return Err(GhError::Api(msg));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    let v = parsed.ok_or_else(|| GhError::Parse(text.trim().chars().take(200).collect()))?;
    // GraphQL reports failures as 200 with a top-level `errors` array.
    if v.get("data").is_some() {
        let errs = error_messages(&v);
        if !errs.is_empty() {
            return Err(GhError::Api(errs.join("; ")));
        }
    }
    Ok(v)
}

/// Whether `gh` is usable for `host`. The token `gh auth token` would print
/// is sent to null and never read.
pub fn status(host: &str) -> GhStatus {
    let Ok(mut cmd) = gh_command() else {
        return GhStatus::NotInstalled;
    };
    match cmd
        .args(["auth", "token", "--hostname", host])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(s) if s.success() => GhStatus::Ready,
        Ok(_) => GhStatus::NotLoggedIn,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => GhStatus::NotInstalled,
        Err(_) => GhStatus::NotLoggedIn,
    }
}

pub fn api(
    host: &str,
    method: &str,
    endpoint: &str,
    body: Option<&Value>,
) -> Result<Value, GhError> {
    let mut child = gh_command()?
        .args(gh_args(host, method, endpoint, body.is_some()))
        .stdin(if body.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_error)?;
    let writer = match body {
        Some(b) => {
            let payload = serde_json::to_vec(b).map_err(|e| GhError::Parse(e.to_string()))?;
            let mut stdin = child.stdin.take().ok_or_else(|| GhError::Io("no stdin".into()))?;
            // Own thread so a large body can't deadlock against gh filling its stdout pipe.
            Some(std::thread::spawn(move || stdin.write_all(&payload)))
        }
        None => None,
    };
    let out = child.wait_with_output().map_err(|e| GhError::Io(e.to_string()))?;
    if let Some(w) = writer {
        let _ = w.join();
    }
    interpret(out.status.success(), &out.stdout, &out.stderr)
}

#[derive(Debug, PartialEq)]
pub enum LoginLine {
    Code(String),
    Url(String),
}

/// One line of `gh auth login --web` output when gh is not on a TTY.
pub fn parse_login_line(line: &str) -> Option<LoginLine> {
    let line = line.trim();
    let after = |prefix: &str| {
        line.find(prefix)
            .map(|i| line[i + prefix.len()..].trim())
            .filter(|s| !s.is_empty())
    };
    if let Some(code) = after("First copy your one-time code:") {
        return Some(LoginLine::Code(code.into()));
    }
    after("Open this URL to continue in your web browser:").map(|u| LoginLine::Url(u.into()))
}

/// A hostname of `[A-Za-z0-9.-]` with an optional `:port`; never an option.
pub fn valid_host(host: &str) -> bool {
    let (name, port) = match host.split_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (host, None),
    };
    !name.is_empty()
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && port.is_none_or(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LoginEvent {
    Code { code: String, url: String },
}

/// What `login` has seen of gh's output so far.
#[derive(Default)]
struct LoginScan {
    code: Option<String>,
    url: Option<String>,
    sent: bool,
    /// The last few non-empty stderr lines other than the code/URL ones.
    stderr_tail: Vec<String>,
}

impl LoginScan {
    /// The device-code event, once, as soon as both code and URL are known.
    fn feed(&mut self, is_stderr: bool, line: &str) -> Option<LoginEvent> {
        match parse_login_line(line) {
            Some(LoginLine::Code(c)) => self.code = Some(c),
            Some(LoginLine::Url(u)) => self.url = Some(u),
            None if is_stderr && !line.trim().is_empty() => {
                self.stderr_tail.push(line.trim().to_string());
                if self.stderr_tail.len() > 3 {
                    self.stderr_tail.remove(0);
                }
            }
            None => {}
        }
        if self.sent {
            return None;
        }
        let (code, url) = (self.code.clone()?, self.url.clone()?);
        self.sent = true;
        Some(LoginEvent::Code { code, url })
    }
}

/// `gh auth login --web` for `host`. `on_event` gets the device code; gh
/// stores the token itself and riff never reads it. `cancelled` is polled
/// while gh runs; true kills gh.
pub fn login(
    host: &str,
    on_event: &mut dyn FnMut(LoginEvent),
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<(), GhError> {
    if !valid_host(host) {
        return Err(GhError::Api("invalid host".into()));
    }
    // ssh + --skip-ssh-key: with https gh may rewrite the user's git
    // credential helper.
    let mut child = gh_command()?
        .args([
            "auth",
            "login",
            "--hostname",
            host,
            "--web",
            "--git-protocol",
            "ssh",
            "--skip-ssh-key",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_error)?;
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

    let mut scan = LoginScan::default();
    let tick = Duration::from_millis(100);
    let status = loop {
        match rx.recv_timeout(tick) {
            Ok((is_stderr, line)) => {
                if let Some(ev) = scan.feed(is_stderr, &line) {
                    on_event(ev);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => std::thread::sleep(tick),
        }
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(GhError::Api("cancelled".into()));
        }
        if let Some(s) = child.try_wait().map_err(|e| GhError::Io(e.to_string()))? {
            break s;
        }
    };
    // Lines written just before exit; bounded so a process that inherited
    // the pipes can't hold this open.
    while let Ok((is_stderr, line)) = rx.recv_timeout(Duration::from_millis(200)) {
        scan.feed(is_stderr, &line);
    }
    if status.success() {
        return Ok(());
    }
    Err(GhError::Api(if scan.stderr_tail.is_empty() {
        "gh auth login failed".into()
    } else {
        scan.stderr_tail.join("\n")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn gh_args_adds_input_only_with_body() {
        assert_eq!(
            gh_args("h.com", "GET", "repos/o/r/pulls", false),
            ["api", "--hostname", "h.com", "-X", "GET", "repos/o/r/pulls"]
        );
        let with = gh_args("h.com", "POST", "graphql", true);
        assert_eq!(&with[6..], ["--input", "-"]);
    }

    #[test]
    fn interpret_ok_returns_json() {
        let v = interpret(true, br#"{"a":1}"#, b"").unwrap();
        assert_eq!(v, json!({"a":1}));
    }

    #[test]
    fn interpret_graphql_errors_become_api_error() {
        let out = br#"{"data":null,"errors":[{"message":"Could not resolve"}]}"#;
        assert_eq!(
            interpret(true, out, b""),
            Err(GhError::Api("Could not resolve".into()))
        );
        let two = br#"{"data":null,"errors":[{"message":"a"},{"message":"b"}]}"#;
        assert_eq!(interpret(true, two, b""), Err(GhError::Api("a; b".into())));
    }

    #[test]
    fn interpret_failure_prefers_json_message_then_stderr() {
        let out = br#"{"message":"Validation Failed","errors":[{"message":"line must be part of the diff"}]}"#;
        assert_eq!(
            interpret(false, out, b"HTTP 422"),
            Err(GhError::Api(
                "Validation Failed: line must be part of the diff".into()
            ))
        );
        assert_eq!(
            interpret(false, b"", b"HTTP 401\n"),
            Err(GhError::Api("HTTP 401".into()))
        );
    }

    #[test]
    fn interpret_empty_success_is_null() {
        assert_eq!(interpret(true, b"", b""), Ok(Value::Null));
    }

    fn exists_in<'a>(present: &'a [PathBuf]) -> impl Fn(&Path) -> bool + 'a {
        move |p| present.iter().any(|x| x == p)
    }

    #[test]
    fn resolve_gh_prefers_path_then_program_files_then_bundled() {
        let path_dir = PathBuf::from("C:/tools");
        let path_var = std::env::join_paths([PathBuf::from("C:/empty"), path_dir.clone()]).unwrap();
        let pf = PathBuf::from("C:/Program Files");
        let pf_gh = pf.join("GitHub CLI").join(GH_EXE);
        let bundled = PathBuf::from("C:/riff/resources/gh/gh.exe");
        let on_path = path_dir.join(GH_EXE);

        let all = [on_path.clone(), pf_gh.clone(), bundled.clone()];
        assert_eq!(
            resolve_gh(Some(&path_var), Some(&pf), Some(&bundled), &exists_in(&all)),
            Some(on_path)
        );
        let no_path = [pf_gh.clone(), bundled.clone()];
        assert_eq!(
            resolve_gh(
                Some(&path_var),
                Some(&pf),
                Some(&bundled),
                &exists_in(&no_path)
            ),
            Some(pf_gh)
        );
        let only_bundled = [bundled.clone()];
        assert_eq!(
            resolve_gh(
                Some(&path_var),
                Some(&pf),
                Some(&bundled),
                &exists_in(&only_bundled)
            ),
            Some(bundled.clone())
        );
        assert_eq!(
            resolve_gh(Some(&path_var), Some(&pf), Some(&bundled), &exists_in(&[])),
            None
        );
        assert_eq!(resolve_gh(None, None, None, &|_| true), None);
    }

    #[test]
    fn resolve_gh_skips_empty_and_relative_path_entries() {
        let path_var = std::ffi::OsString::from(r"C:\a;;rel;C:\b;");
        let b_gh = PathBuf::from(r"C:\b").join(GH_EXE);
        let planted = [
            PathBuf::from(GH_EXE),
            PathBuf::from("rel").join(GH_EXE),
            b_gh.clone(),
        ];
        assert_eq!(
            resolve_gh(Some(&path_var), None, None, &exists_in(&planted)),
            Some(b_gh)
        );
        assert_eq!(
            resolve_gh(Some(&path_var), None, None, &exists_in(&planted[..2])),
            None
        );
    }

    #[test]
    fn parse_login_line_reads_code_and_url() {
        assert_eq!(
            parse_login_line("! First copy your one-time code: ABCD-1234"),
            Some(LoginLine::Code("ABCD-1234".into()))
        );
        assert_eq!(
            parse_login_line(
                "Open this URL to continue in your web browser: https://github.com/login/device"
            ),
            Some(LoginLine::Url("https://github.com/login/device".into()))
        );
    }

    #[test]
    fn parse_login_line_handles_crlf_and_ignores_noise() {
        assert_eq!(
            parse_login_line("! First copy your one-time code: ABCD-1234\r\n"),
            Some(LoginLine::Code("ABCD-1234".into()))
        );
        assert_eq!(
            parse_login_line(
                "Open this URL to continue in your web browser: https://ghe.corp/login/device\r"
            ),
            Some(LoginLine::Url("https://ghe.corp/login/device".into()))
        );
        for noise in [
            "",
            "\r",
            "✓ Authentication complete.",
            "- gh config set -h github.com git_protocol ssh",
            "! First copy your one-time code:",
            "Open this URL to continue in your web browser:",
        ] {
            assert_eq!(parse_login_line(noise), None, "{noise:?}");
        }
    }

    #[test]
    fn login_scan_sends_code_once_and_keeps_stderr_tail() {
        let mut s = LoginScan::default();
        assert!(s
            .feed(true, "! First copy your one-time code: AB-12\r")
            .is_none());
        let ev = s.feed(
            true,
            "Open this URL to continue in your web browser: https://h/d",
        );
        assert!(
            matches!(ev, Some(LoginEvent::Code { ref code, ref url }) if code == "AB-12" && url == "https://h/d")
        );
        assert!(s
            .feed(
                true,
                "Open this URL to continue in your web browser: https://h/d"
            )
            .is_none());
        for l in ["a", "", "b", "c", "d"] {
            s.feed(true, l);
        }
        s.feed(false, "stdout line");
        assert_eq!(s.stderr_tail, ["b", "c", "d"]);
    }

    #[test]
    fn valid_host_accepts_hostnames_and_ports_only() {
        for ok in [
            "github.com",
            "ghe.corp",
            "git-hub.example.com",
            "ghe.corp:8443",
            "10.0.0.1",
        ] {
            assert!(valid_host(ok), "{ok}");
        }
        for bad in [
            "",
            "-github.com",
            "--help",
            "github.com:",
            "github.com:80a",
            "github.com:1:2",
            ":443",
            "git hub.com",
            "github.com/x",
            "host;rm",
        ] {
            assert!(!valid_host(bad), "{bad}");
        }
    }
}
