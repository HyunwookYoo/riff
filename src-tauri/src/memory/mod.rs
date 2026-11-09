//! Best-effort writes to agentmemory's REST API. riff records review
//! reactions itself (the AI runs are recall-only); callers build the content
//! from enum words, a file path and the repo name, never from PR text.

use std::time::Duration;

use serde_json::{json, Value};
use ureq::http::Request;

pub fn remember_body(content: &str, project: &str, concepts: &[String]) -> Value {
    json!({ "content": content, "project": project, "concepts": concepts, "type": "fact" })
}

/// The POST to `<url>/agentmemory/remember`, built but not sent.
pub fn remember_request(
    url: &str,
    secret: Option<&str>,
    body: &Value,
) -> Result<Request<String>, String> {
    let mut b = Request::post(format!(
        "{}/agentmemory/remember",
        url.trim_end_matches('/')
    ))
    .header("content-type", "application/json");
    if let Some(s) = secret {
        b = b.header("authorization", format!("Bearer {s}"));
    }
    b.body(body.to_string()).map_err(|e| e.to_string())
}

/// Sends `body` with a 2 s overall timeout; blocking.
pub fn remember(url: &str, secret: Option<&str>, body: &Value) -> Result<(), String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(2)))
        .build()
        .into();
    let res = agent
        .run(remember_request(url, secret, body)?)
        .map_err(|e| e.to_string())?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("agentmemory answered {}", res.status()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn remember_body_shape() {
        let b = remember_body(
            "c",
            "o/r",
            &["riff-review".to_string(), "thread-resolved".to_string()],
        );
        assert_eq!(
            b,
            json!({ "content": "c", "project": "o/r", "concepts": ["riff-review", "thread-resolved"], "type": "fact" })
        );
    }

    #[test]
    fn remember_adds_bearer_only_when_secret_set() {
        let body = remember_body("c", "o/r", &[]);
        let r = remember_request("http://localhost:3111/", None, &body).unwrap();
        assert_eq!(r.method(), "POST");
        assert_eq!(r.uri(), "http://localhost:3111/agentmemory/remember");
        assert_eq!(r.headers()["content-type"], "application/json");
        assert!(r.headers().get("authorization").is_none());
        assert_eq!(serde_json::from_str::<Value>(r.body()).unwrap(), body);

        let r = remember_request("http://h:1", Some("s3"), &body).unwrap();
        assert_eq!(r.uri(), "http://h:1/agentmemory/remember");
        assert_eq!(r.headers()["authorization"], "Bearer s3");
    }
}
