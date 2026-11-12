//! Minimal read-only HTTP/1.1 GET over `tokio::net::TcpStream`: loopback only, no proxy, 2 s timeout.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use tokio::net::TcpStream;

pub const TIMEOUT: Duration = Duration::from_secs(2);
const MAX_BODY: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Parse `http://host[:port][/prefix]` into a loopback socket address and a path prefix.
pub fn parse_base(url: &str) -> Result<(SocketAddr, String), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("only http:// urls are supported: {url}"))?;
    let (hostport, prefix) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].trim_end_matches('/').to_string()),
        None => (rest, String::new()),
    };
    let (host, port) = if let Some(h) = hostport.strip_prefix('[') {
        let (h, p) = h.split_once(']').ok_or("bad ipv6 host")?;
        (h, p.strip_prefix(':').unwrap_or(""))
    } else {
        match hostport.rsplit_once(':') {
            Some((h, p)) => (h, p),
            None => (hostport, ""),
        }
    };
    let ip: IpAddr = match host {
        "localhost" => IpAddr::V4(Ipv4Addr::LOCALHOST),
        h => h.parse().map_err(|_| format!("host '{h}' is not an IP"))?,
    };
    if !ip.is_loopback() {
        return Err(format!("runtime host {ip} is not loopback"));
    }
    let port: u16 = if port.is_empty() {
        80
    } else {
        port.parse().map_err(|_| format!("bad port '{port}'"))?
    };
    Ok((SocketAddr::new(ip, port), prefix))
}

/// GET `base + path`. Errors on connect/timeout/parse failure; any HTTP status is returned as Ok.
pub async fn get(base: &str, path: &str) -> Result<Response, String> {
    let (addr, prefix) = parse_base(base)?;
    let full = format!("{prefix}{path}");
    tokio::time::timeout(TIMEOUT, fetch(addr, &full))
        .await
        .map_err(|_| "timeout".to_string())?
}

async fn fetch(addr: SocketAddr, path: &str) -> Result<Response, String> {
    let s = TcpStream::connect(addr).await.map_err(|e| e.to_string())?;
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nAccept: application/json\r\nUser-Agent: agentglimd\r\nConnection: close\r\n\r\n"
    );
    // Only the `net` tokio feature is enabled, so use readiness + try_* instead of AsyncRead/Write.
    let mut out = req.as_bytes();
    while !out.is_empty() {
        s.writable().await.map_err(|e| e.to_string())?;
        match s.try_write(out) {
            Ok(n) => out = &out[n..],
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        s.readable().await.map_err(|e| e.to_string())?;
        match s.try_read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(e) => return Err(e.to_string()),
        }
        if buf.len() > MAX_BODY {
            return Err("response too large".into());
        }
    }
    parse_response(&buf)
}

pub fn parse_response(buf: &[u8]) -> Result<Response, String> {
    let end = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("no header terminator")?;
    let head = std::str::from_utf8(&buf[..end]).map_err(|_| "non-utf8 headers")?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("bad status line '{status_line}'"))?;
    let mut chunked = false;
    let mut len: Option<usize> = None;
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
            if k == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            } else if k == "content-length" {
                len = v.parse().ok();
            }
        }
    }
    let raw = &buf[end + 4..];
    let body = if chunked {
        dechunk(raw)?
    } else if let Some(n) = len {
        raw.get(..n).ok_or("short body")?.to_vec()
    } else {
        raw.to_vec()
    };
    Ok(Response { status, body })
}

fn dechunk(mut raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let eol = raw
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or("bad chunk")?;
        let size_s = std::str::from_utf8(&raw[..eol]).map_err(|_| "bad chunk size")?;
        let size = usize::from_str_radix(size_s.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| "bad chunk size")?;
        raw = &raw[eol + 2..];
        if size == 0 {
            return Ok(out);
        }
        out.extend_from_slice(raw.get(..size).ok_or("short chunk")?);
        raw = raw.get(size + 2..).ok_or("short chunk")?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_must_be_loopback_http() {
        let (a, p) = parse_base("http://127.0.0.1:8080").unwrap();
        assert_eq!((a.port(), p.as_str()), (8080, ""));
        let (a, p) = parse_base("http://localhost:1/x/").unwrap();
        assert_eq!((a.port(), p.as_str()), (1, "/x"));
        assert!(parse_base("http://[::1]:9").unwrap().0.ip().is_loopback());
        assert!(parse_base("http://10.0.0.1:80").is_err());
        assert!(parse_base("http://example.invalid").is_err());
        assert!(parse_base("https://127.0.0.1").is_err());
    }

    #[test]
    fn parses_length_and_chunked() {
        let r = parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}xx").unwrap();
        assert_eq!((r.status, r.body.as_slice()), (200, &b"{}"[..]));
        let r = parse_response(
            b"HTTP/1.1 503 X\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{\"\r\n3\r\na\":\r\n0\r\n\r\n",
        )
        .unwrap();
        assert_eq!((r.status, r.body.as_slice()), (503, &b"{\"a\":"[..]));
        assert!(parse_response(b"garbage").is_err());
    }
}
