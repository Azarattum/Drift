use serde_json::Value;
use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
};

use crate::Error;

#[derive(Clone)]
pub struct Config {
    pub rpc: SocketAddr,
    pub listen: SocketAddr,
    pub rpc_path: String,
    pub roots: Vec<PathBuf>,
    pub authentication: bool,
    whitelist: Option<Vec<String>>,
    hosts: Vec<String>,
}

impl Config {
    pub fn parse(value: &Value) -> Result<Self, Error> {
        let get = |key: &str| value.get(key).or_else(|| value.get(key.replace('-', "_")));
        let text = |key: &str, default: &str| {
            get(key)
                .and_then(Value::as_str)
                .unwrap_or(default)
                .to_owned()
        };
        let flag = |key: &str, default| get(key).and_then(Value::as_bool).unwrap_or(default);
        if !flag("rpc-enabled", true) {
            return Err("Transmission RPC is disabled".into());
        }
        let bind: IpAddr = text("rpc-bind-address", "127.0.0.1").parse()?;
        let port = u16::try_from(get("rpc-port").and_then(Value::as_u64).unwrap_or(9091))?;
        let stream_port = port
            .checked_add(1)
            .ok_or("RPC port has no adjacent stream port")?;
        if port == 0 {
            return Err("Invalid RPC port".into());
        }
        let local = if bind.is_unspecified() {
            if bind.is_ipv4() {
                "127.0.0.1".parse()?
            } else {
                "::1".parse()?
            }
        } else {
            bind
        };
        let mut path = text("rpc-url", "/transmission/");
        if !path.starts_with('/') || !path.ends_with('/') || path.contains(['?', '#', '\r', '\n']) {
            return Err("Invalid Transmission RPC URL".into());
        }
        path.push_str("rpc");
        let root = PathBuf::from(text("download-dir", ""));
        if !root.is_absolute() {
            return Err("An absolute download directory is required".into());
        }
        let mut roots = vec![root];
        if flag("incomplete-dir-enabled", false) {
            let incomplete = PathBuf::from(text("incomplete-dir", ""));
            if !incomplete.is_absolute() {
                return Err("Invalid incomplete directory".into());
            }
            roots.push(incomplete);
        }
        let split = |v: String| {
            v.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        };
        Ok(Self {
            rpc: SocketAddr::new(local, port),
            listen: SocketAddr::new(bind, stream_port),
            rpc_path: path,
            roots,
            authentication: flag("rpc-authentication-required", false),
            whitelist: flag("rpc-whitelist-enabled", true)
                .then(|| split(text("rpc-whitelist", "127.0.0.1"))),
            hosts: split(text("rpc-host-whitelist", "")),
        })
    }

    pub fn allows_peer(&self, ip: IpAddr) -> bool {
        let ip = match ip {
            IpAddr::V6(v) => v.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
            _ => ip,
        };
        self.whitelist
            .as_ref()
            .is_none_or(|patterns| patterns.iter().any(|p| wildcard(p, &ip.to_string())))
    }

    pub fn allows_host(&self, host: &str, local: IpAddr) -> bool {
        host.eq_ignore_ascii_case(&local.to_string())
            || (local.is_loopback() && host.eq_ignore_ascii_case("localhost"))
            || self
                .hosts
                .iter()
                .any(|p| wildcard(&p.to_ascii_lowercase(), &host.to_ascii_lowercase()))
    }
}

// Transmission-style '*' wildcards; no regex or DNS resolution on requests.
fn wildcard(pattern: &str, text: &str) -> bool {
    let (p, t) = (pattern.as_bytes(), text.as_bytes());
    let (mut i, mut j, mut star, mut retry) = (0, 0, None, 0);
    while j < t.len() {
        if i < p.len() && p[i] == t[j] {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == b'*' {
            star = Some(i);
            i += 1;
            retry = j;
        } else if let Some(s) = star {
            retry += 1;
            j = retry;
            i = s + 1;
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == b'*' {
        i += 1;
    }
    i == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn settings_aliases_and_fail_closed_defaults() {
        let c = Config::parse(&json!({"download_dir":"/data", "rpc_port":9000})).unwrap();
        assert_eq!(c.listen.port(), 9001);
        assert!(c.allows_peer("127.0.0.1".parse().unwrap()));
        assert!(!c.allows_peer("192.168.1.2".parse().unwrap()));
        assert!(!c.allows_host("attacker.test", "192.168.1.1".parse().unwrap()));
        assert!(Config::parse(&json!({"download-dir":"/data", "rpc-port":65535})).is_err());
    }
    #[test]
    fn whitelist_does_not_match_prefixes_accidentally() {
        assert!(wildcard("192.168.1.*", "192.168.1.20"));
        assert!(!wildcard("192.168.1.*", "192.168.10.20"));
        assert!(!wildcard("127.0.0.1", "127.0.0.12"));
        assert!(wildcard("*.lan", "router.lan"));
    }
}
