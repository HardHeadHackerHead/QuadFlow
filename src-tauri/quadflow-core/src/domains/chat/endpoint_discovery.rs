//! Find LLM servers: scan the local /24 for Ollama / OpenAI-compatible APIs
//! (`discover_endpoints`) or probe one URL (`check_endpoint`).

use super::model::{ChatApiType, ChatDiscoveryResult, ChatEndpointInfo};
use crate::error::{CoreError, Result};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn http(timeout_ms: u64) -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.max(50)))
        .connect_timeout(Duration::from_millis((timeout_ms / 2).max(50)))
        .build()
        .ok()
}

fn names(v: &serde_json::Value, list: &str, field: &str) -> Option<Vec<String>> {
    let arr = v.get(list)?.as_array()?;
    Some(arr.iter().filter_map(|m| m.get(field)?.as_str().map(str::to_string)).collect())
}

fn local_ip() -> String {
    local_ip_address::local_ip().map(|ip| ip.to_string()).unwrap_or_default()
}

fn reverse_dns(host: &str) -> Option<String> {
    let ip: std::net::IpAddr = host.parse().ok()?;
    dns_lookup::lookup_addr(&ip).ok().filter(|h| !h.is_empty() && h != host)
}

/// Probe `base` (`scheme://host:port`): Ollama `/api/tags`, then `/v1/models`.
fn probe(client: &reqwest::blocking::Client, base: &str, host: &str, port: u16, local: &str, resolve: bool) -> Option<ChatEndpointInfo> {
    let start = Instant::now();
    let found = |api_type, models: Vec<String>| ChatEndpointInfo {
        host: host.to_string(),
        hostname: if resolve { reverse_dns(host) } else { None },
        port,
        endpoint_url: format!("{base}/v1"),
        api_type,
        models,
        response_time_ms: start.elapsed().as_millis().min(u32::MAX as u128) as u32,
        is_local: host == local || host == "127.0.0.1" || host == "localhost" || host == "::1",
    };
    if let Ok(r) = client.get(format!("{base}/api/tags")).send() {
        if r.status().is_success() {
            if let Some(models) = r.json::<serde_json::Value>().ok().and_then(|v| names(&v, "models", "name")) {
                return Some(found(ChatApiType::Ollama, models));
            }
        }
    }
    if let Ok(r) = client.get(format!("{base}/v1/models")).send() {
        if r.status().is_success() {
            if let Some(models) = r.json::<serde_json::Value>().ok().and_then(|v| names(&v, "data", "id")) {
                return Some(found(ChatApiType::OpenaiCompatible, models));
            }
        }
    }
    None
}

/// Scan `<local /24>.1-254:<port>` with 32 worker threads.
pub fn discover_endpoints(port: u16, timeout_ms: u64) -> Result<ChatDiscoveryResult> {
    let start = Instant::now();
    let local = local_ip_address::local_ip()
        .map_err(|e| CoreError::unsupported(format!("could not determine the local IP address: {e}")))?;
    let local_str = local.to_string();
    let octets: Vec<&str> = local_str.split('.').collect();
    if octets.len() != 4 {
        return Err(CoreError::unsupported(format!("network discovery needs an IPv4 address (local address is {local_str})")));
    }
    let prefix = format!("{}.{}.{}", octets[0], octets[1], octets[2]);
    let ips: Vec<String> = (1..=254).map(|i| format!("{prefix}.{i}")).collect();
    let found: Arc<Mutex<Vec<ChatEndpointInfo>>> = Arc::default();
    let chunk = ips.len().div_ceil(32);
    let handles: Vec<_> = ips
        .chunks(chunk)
        .map(|c| {
            let c = c.to_vec();
            let found = found.clone();
            let local = local_str.clone();
            std::thread::spawn(move || {
                let Some(client) = http(timeout_ms) else { return };
                for ip in c {
                    if let Some(e) = probe(&client, &format!("http://{ip}:{port}"), &ip, port, &local, true) {
                        found.lock().unwrap().push(e);
                    }
                }
            })
        })
        .collect();
    for h in handles {
        let _ = h.join();
    }
    let mut endpoints = std::mem::take(&mut *found.lock().unwrap());
    endpoints.sort_by(|a, b| b.is_local.cmp(&a.is_local).then(a.host.cmp(&b.host)));
    Ok(ChatDiscoveryResult {
        endpoints,
        local_ip: local_str,
        scanned_subnet: format!("{prefix}.0/24"),
        scan_duration_ms: start.elapsed().as_millis().min(u32::MAX as u128) as u32,
        ips_scanned: ips.len() as u32,
    })
}

/// Probe one URL. `Ok(None)` = not reachable / no LLM API there.
pub fn check_endpoint(url: &str, timeout_ms: u64) -> Result<Option<ChatEndpointInfo>> {
    let parsed = super::client::validate_endpoint(url)?;
    let host = parsed.host_str().unwrap_or_default().trim_matches(['[', ']']).to_string();
    let port = parsed.port_or_known_default().unwrap_or(11434);
    let base = format!("{}://{}:{}", parsed.scheme(), parsed.host_str().unwrap_or_default(), port);
    let Some(client) = http(timeout_ms) else { return Ok(None) };
    let resolve = host.parse::<std::net::IpAddr>().is_ok();
    let mut info = probe(&client, &base, &host, port, &local_ip(), resolve);
    if let Some(i) = info.as_mut() {
        if !resolve {
            i.hostname = Some(host.clone());
        }
    }
    Ok(info)
}
