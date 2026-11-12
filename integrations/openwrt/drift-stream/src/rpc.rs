use crate::{Error, config::Config};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Request, StatusCode,
    header::{AUTHORIZATION, HeaderValue},
};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{fmt, time::Duration};
use tokio::{net::TcpStream, sync::Mutex, time::timeout};

#[derive(Debug)]
pub struct RpcFailure(pub StatusCode);
impl fmt::Display for RpcFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Transmission RPC rejected request ({})", self.0)
    }
}
impl std::error::Error for RpcFailure {}

#[derive(Clone, Debug, Deserialize)]
pub struct TorrentFile {
    pub name: String,
    pub length: u64,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Torrent {
    #[serde(rename = "hashString", alias = "hash_string")]
    pub hash: String,
    #[serde(rename = "downloadDir", alias = "download_dir")]
    pub download_dir: String,
    pub files: Vec<TorrentFile>,
    #[serde(rename = "pieceSize", alias = "piece_size")]
    pub piece_size: u64,
    #[serde(rename = "pieceCount", alias = "piece_count")]
    pub piece_count: u64,
    pub pieces: String,
    pub status: u8,
    #[serde(default)]
    pub sequential_download: bool,
    #[serde(default)]
    pub sequential_download_from_piece: u64,
}

pub struct Rpc {
    config: Config,
    token: Mutex<String>,
}
impl Rpc {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            token: Mutex::new(String::new()),
        }
    }
    pub async fn call(
        &self,
        method: &str,
        arguments: Value,
        auth: Option<&HeaderValue>,
    ) -> Result<Value, Error> {
        timeout(
            Duration::from_secs(5),
            self.exchange(method, arguments, auth),
        )
        .await?
    }
    async fn exchange(
        &self,
        method: &str,
        arguments: Value,
        auth: Option<&HeaderValue>,
    ) -> Result<Value, Error> {
        // Serializes negotiations and bounds simultaneous RPC work. No retained socket/timer at idle.
        let mut token = self.token.lock().await;
        for _ in 0..3 {
            let socket = TcpStream::connect(self.config.rpc).await?;
            let (mut sender, connection) =
                hyper::client::conn::http1::handshake(TokioIo::new(socket)).await?;
            let driver = tokio::spawn(async move {
                let _ = connection.await;
            });
            let mut request = Request::post(&self.config.rpc_path)
                .header("host", self.config.rpc.to_string())
                .header("connection", "close")
                .header("content-type", "application/json")
                .header("x-transmission-session-id", &*token);
            if let Some(auth) = auth {
                request = request.header(AUTHORIZATION, auth);
            }
            let request = request.body(Full::new(Bytes::from(serde_json::to_vec(
                &json!({"method":method,"arguments":arguments}),
            )?)))?;
            // Abort the connection driver on cancellation/timeout as well as normal completion.
            struct Driver(tokio::task::JoinHandle<()>);
            impl Drop for Driver {
                fn drop(&mut self) {
                    self.0.abort();
                }
            }
            let _driver = Driver(driver);
            let response = sender.send_request(request).await?;
            if response.status() == StatusCode::CONFLICT {
                *token = response
                    .headers()
                    .get("x-transmission-session-id")
                    .ok_or("Missing RPC session token")?
                    .to_str()?
                    .to_owned();
                continue;
            }
            if !response.status().is_success() {
                return Err(Box::new(RpcFailure(response.status())));
            }
            let body = Limited::new(response.into_body(), 1024 * 1024)
                .collect()
                .await?
                .to_bytes();
            let mut reply: Value = serde_json::from_slice(&body)?;
            if reply.get("result").and_then(Value::as_str) != Some("success") {
                return Err("Transmission RPC failed".into());
            }
            return reply
                .get_mut("arguments")
                .map(Value::take)
                .ok_or_else(|| "Missing RPC response".into());
        }
        Err("RPC session negotiation failed".into())
    }
    pub async fn torrent(&self, hash: &str, auth: Option<&HeaderValue>) -> Result<Torrent, Error> {
        let mut reply = self.call("torrent-get", json!({"ids":[hash], "fields":["hashString","downloadDir","files","pieceSize","pieceCount","pieces","status","sequential_download","sequential_download_from_piece"]}), auth).await?;
        let rows = reply
            .get_mut("torrents")
            .and_then(Value::as_array_mut)
            .ok_or("Invalid torrent response")?;
        if rows.len() != 1 {
            return Err(Box::new(RpcFailure(StatusCode::NOT_FOUND)));
        }
        let torrent: Torrent = serde_json::from_value(rows.pop().ok_or("Missing torrent")?)?;
        if !torrent.hash.eq_ignore_ascii_case(hash)
            || torrent.files.len() > 100_000
            || torrent.piece_size == 0
        {
            return Err("Invalid torrent metadata".into());
        }
        Ok(torrent)
    }
}
