//! NDJSON JSON-RPC 2.0 codec (plugin-system.md §10.1): one JSON object per
//! line, UTF-8, `\n` terminated, at most [`MAX_LINE_BYTES`] per line. No batches.

use crate::error::{CoreError, ErrorCode};
use serde_json::{json, Map, Value};
use std::io::{self, BufRead, Write};

/// Longest accepted line (16 MiB). Longer → protocol error (the sidecar is restarted).
pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// JSON-RPC error code for host errors; `data.code` carries the `CoreError` code.
pub const HOST_ERROR: i64 = -32000;
pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;

/// A request / response id. The host only ever sends integers; sidecars may use strings.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum RpcId {
    Num(i64),
    Str(String),
}

impl RpcId {
    fn from_value(v: &Value) -> Option<RpcId> {
        match v {
            Value::Number(n) => n.as_i64().map(RpcId::Num),
            Value::String(s) => Some(RpcId::Str(s.clone())),
            _ => None,
        }
    }
    pub fn to_value(&self) -> Value {
        match self {
            RpcId::Num(n) => json!(n),
            RpcId::Str(s) => json!(s),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RpcErrorObj {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcErrorObj {
    /// A host error, keeping the `CoreError` code + details in `data`.
    pub fn from_core(e: &CoreError) -> Self {
        let mut data = Map::new();
        data.insert("code".into(), json!(e.code.as_str()));
        if let Some(d) = &e.details {
            data.insert("details".into(), d.clone());
        }
        Self { code: HOST_ERROR, message: e.message.clone(), data: Some(Value::Object(data)) }
    }

    /// Back to a `CoreError`: `data.code` when it names one, else `external`.
    pub fn to_core(&self) -> CoreError {
        let code = self
            .data
            .as_ref()
            .and_then(|d| d.get("code"))
            .and_then(|c| serde_json::from_value::<ErrorCode>(c.clone()).ok())
            .unwrap_or(ErrorCode::External);
        let mut e = CoreError::new(code, self.message.clone());
        if let Some(d) = self.data.as_ref().and_then(|d| d.get("details")) {
            e = e.with_details(d.clone());
        }
        e
    }

    fn to_value(&self) -> Value {
        let mut o = json!({ "code": self.code, "message": self.message });
        if let Some(d) = &self.data {
            o["data"] = d.clone();
        }
        o
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Message {
    Request { id: RpcId, method: String, params: Value },
    Notification { method: String, params: Value },
    Response { id: RpcId, result: Result<Value, RpcErrorObj> },
}

impl Message {
    pub fn to_line(&self) -> String {
        let v = match self {
            Message::Request { id, method, params } => {
                json!({ "jsonrpc": "2.0", "id": id.to_value(), "method": method, "params": params })
            }
            Message::Notification { method, params } => json!({ "jsonrpc": "2.0", "method": method, "params": params }),
            Message::Response { id, result: Ok(r) } => json!({ "jsonrpc": "2.0", "id": id.to_value(), "result": r }),
            Message::Response { id, result: Err(e) } => {
                json!({ "jsonrpc": "2.0", "id": id.to_value(), "error": e.to_value() })
            }
        };
        // serde_json never emits raw newlines (they are escaped inside strings).
        let mut s = v.to_string();
        s.push('\n');
        s
    }

    /// Parse one line (without its terminator). `Err` = protocol error.
    pub fn parse(line: &str) -> Result<Message, String> {
        let v: Value = serde_json::from_str(line).map_err(|e| format!("invalid JSON: {e}"))?;
        let o = v.as_object().ok_or("message is not a JSON object")?;
        if o.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err("missing \"jsonrpc\": \"2.0\"".into());
        }
        let params = o.get("params").cloned().unwrap_or(Value::Null);
        match (o.get("method").and_then(Value::as_str), o.get("id")) {
            (Some(method), Some(id)) if !id.is_null() => {
                let id = RpcId::from_value(id).ok_or("request id must be a number or string")?;
                Ok(Message::Request { id, method: method.to_string(), params })
            }
            (Some(method), _) => Ok(Message::Notification { method: method.to_string(), params }),
            (None, Some(id)) => {
                let id = RpcId::from_value(id).ok_or("response id must be a number or string")?;
                let result = match (o.get("result"), o.get("error")) {
                    (_, Some(e)) if !e.is_null() => {
                        let code = e.get("code").and_then(Value::as_i64).unwrap_or(HOST_ERROR);
                        let message = e.get("message").and_then(Value::as_str).unwrap_or("error").to_string();
                        Err(RpcErrorObj { code, message, data: e.get("data").cloned() })
                    }
                    (r, _) => Ok(r.cloned().unwrap_or(Value::Null)),
                };
                Ok(Message::Response { id, result })
            }
            (None, None) => Err("message has neither a method nor an id".into()),
        }
    }
}

pub fn write_message(w: &mut impl Write, m: &Message) -> io::Result<()> {
    w.write_all(m.to_line().as_bytes())?;
    w.flush()
}

/// What [`read_line`] produced.
#[derive(Debug, PartialEq)]
pub enum Line {
    Text(String),
    Eof,
    /// Longer than the limit (the rest of the line is not consumed).
    TooLong,
}

/// Read one `\n`-terminated line of at most `max` bytes (a trailing `\r` is dropped).
pub fn read_line(r: &mut impl BufRead, max: usize) -> io::Result<Line> {
    let mut buf = Vec::new();
    loop {
        let (done, used) = {
            let avail = r.fill_buf()?;
            if avail.is_empty() {
                if buf.is_empty() {
                    return Ok(Line::Eof);
                }
                (true, 0)
            } else if let Some(i) = avail.iter().position(|b| *b == b'\n') {
                buf.extend_from_slice(&avail[..i]);
                (true, i + 1)
            } else {
                buf.extend_from_slice(avail);
                (false, avail.len())
            }
        };
        r.consume(used);
        if buf.len() > max {
            return Ok(Line::TooLong);
        }
        if done {
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(Line::Text(String::from_utf8_lossy(&buf).into_owned()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let msgs = [
            Message::Request { id: RpcId::Num(7), method: "ping".into(), params: json!({"a": "x\ny"}) },
            Message::Notification { method: "ui/tick".into(), params: json!([1, 2]) },
            Message::Response { id: RpcId::Str("s1".into()), result: Ok(json!(null)) },
            Message::Response {
                id: RpcId::Num(1),
                result: Err(RpcErrorObj::from_core(
                    &CoreError::permission_denied("nope").with_details(json!({"permission": "clipboard:read"})),
                )),
            },
        ];
        for m in msgs {
            let line = m.to_line();
            assert_eq!(line.matches('\n').count(), 1, "{line}");
            assert_eq!(Message::parse(line.trim_end()).unwrap(), m);
        }
        let e = Message::parse(r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"m","data":{"code":"permission_denied","details":{"permission":"p"}}}}"#).unwrap();
        let Message::Response { result: Err(e), .. } = e else { panic!() };
        let core = e.to_core();
        assert_eq!(core.code, ErrorCode::PermissionDenied);
        assert_eq!(core.details.unwrap()["permission"], "p");
    }

    #[test]
    fn protocol_errors() {
        assert!(Message::parse("not json").is_err());
        assert!(Message::parse("[1]").is_err());
        assert!(Message::parse(r#"{"id":1,"method":"x"}"#).is_err());
        assert!(Message::parse(r#"{"jsonrpc":"2.0"}"#).is_err());
    }

    #[test]
    fn line_limit() {
        let mut r = io::Cursor::new(b"abc\r\n0123456789\nlast".to_vec());
        assert_eq!(read_line(&mut r, 8).unwrap(), Line::Text("abc".into()));
        assert_eq!(read_line(&mut r, 8).unwrap(), Line::TooLong);
        let mut r = io::Cursor::new(b"last".to_vec());
        assert_eq!(read_line(&mut r, 8).unwrap(), Line::Text("last".into()));
        assert_eq!(read_line(&mut r, 8).unwrap(), Line::Eof);
    }
}
