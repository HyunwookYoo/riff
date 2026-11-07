//! GitHub access through the user's `gh` CLI login. riff never sees or stores
//! a token; `gh api --hostname <host>` carries the authentication.

use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};
use thiserror::Error;

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

/// `Command::new("gh")` with `CREATE_NO_WINDOW` on Windows (see `git_command`)
/// and prompts disabled so a missing login fails instead of waiting on stdin.
fn gh_command() -> Command {
    let mut cmd = Command::new("gh");
    cmd.env("GH_PROMPT_DISABLED", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
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
    match gh_command()
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
    let mut child = gh_command()
        .args(gh_args(host, method, endpoint, body.is_some()))
        .stdin(if body.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                GhError::NotInstalled
            } else {
                GhError::Io(e.to_string())
            }
        })?;
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
}
