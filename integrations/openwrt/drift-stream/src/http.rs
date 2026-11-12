use crate::{
    Error,
    config::Config,
    files::{self, Root},
    rpc::{Rpc, RpcFailure, Torrent},
    subtitles,
};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Method, Request, Response, StatusCode,
    body::{Frame, Incoming},
    header::{self, HeaderValue},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    convert::Infallible,
    fs::File,
    io::Read,
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::{Instant, sleep, timeout},
};

pub type Body = UnsyncBoxBody<Bytes, Error>;
pub const CHUNK: usize = 64 * 1024;
pub const CONNECTIONS: usize = 8;
const WAIT: Duration = Duration::from_secs(30);

pub struct State {
    pub config: Config,
    pub roots: Vec<Root>,
    pub rpc: Rpc,
    streams: Arc<Semaphore>,
    leases: Mutex<BTreeMap<String, Lease>>,
    next_request: AtomicU64,
}
struct Lease {
    path: String,
    authorization: Option<HeaderValue>,
    expires: Instant,
    pending: BTreeMap<u64, u64>,
}
impl State {
    pub fn new(config: Config) -> Result<Self, Error> {
        let roots = config
            .roots
            .iter()
            .map(|p| Root::open(p))
            .collect::<Result<_, _>>()?;
        Ok(Self {
            rpc: Rpc::new(config.clone()),
            config,
            roots,
            streams: Arc::new(Semaphore::new(4)),
            leases: Mutex::new(BTreeMap::new()),
            next_request: AtomicU64::new(0),
        })
    }
    fn media_authorization(&self, request: &Request<Incoming>) -> Option<HeaderValue> {
        let leases = self.leases.lock().ok()?;
        // A video ticket also covers only its matching subtitle route. Matching is
        // checked against the live torrent below before any subtitle file is read.
        let subtitle_scope = request
            .uri()
            .path()
            .strip_prefix("/v1/subtitles/")
            .and_then(|p| p.rsplit_once('/'))
            .map(|(video, _)| format!("/v1/media/{video}"));
        let scope = subtitle_scope.as_deref().unwrap_or(request.uri().path());
        request
            .uri()
            .query()
            .and_then(|q| q.strip_prefix("ticket="))
            .into_iter()
            .chain(
                request
                    .headers()
                    .get_all(header::COOKIE)
                    .iter()
                    .filter_map(|v| v.to_str().ok())
                    .flat_map(|v| v.split(';'))
                    .filter_map(|v| v.trim().strip_prefix("drift_media=")),
            )
            .filter_map(|token| leases.get(token))
            .find(|l| l.path == scope && l.expires > Instant::now())
            .and_then(|l| l.authorization.clone())
    }
    fn authorize_media(
        &self,
        path: String,
        authorization: Option<HeaderValue>,
    ) -> Result<(HeaderValue, String), Error> {
        let mut random = [0u8; 32];
        File::open("/dev/urandom")?.read_exact(&mut random)?;
        use base64::Engine;
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
        let mut leases = self
            .leases
            .lock()
            .map_err(|_| "Session store unavailable")?;
        leases.retain(|_, l| l.expires > Instant::now());
        if leases.len() >= 16 {
            if let Some(oldest) = leases
                .iter()
                .min_by_key(|(_, l)| l.expires)
                .map(|(k, _)| k.clone())
            {
                leases.remove(&oldest);
            }
        }
        let cookie =
            format!("drift_media={token}; Path={path}; Max-Age=43200; HttpOnly; SameSite=Strict");
        leases.insert(
            token.clone(),
            Lease {
                path,
                authorization,
                expires: Instant::now() + Duration::from_secs(43200),
                pending: BTreeMap::new(),
            },
        );
        Ok((cookie.parse()?, token))
    }
}

struct PendingRange {
    state: Arc<State>,
    token: String,
    id: u64,
}
impl PendingRange {
    fn set(&self, position: Option<u64>) {
        if let Ok(mut leases) = self.state.leases.lock() {
            if let Some(lease) = leases.get_mut(&self.token) {
                if let Some(position) = position {
                    lease.pending.insert(self.id, position);
                } else {
                    lease.pending.remove(&self.id);
                }
            }
        }
    }
}
impl Drop for PendingRange {
    fn drop(&mut self) {
        self.set(None);
    }
}

pub async fn handle(
    request: Request<Incoming>,
    state: Arc<State>,
    local: SocketAddr,
) -> Result<Response<Body>, Infallible> {
    let origin = if validate_context(&request, &state, local).is_ok() {
        request.headers().get(header::ORIGIN).cloned()
    } else {
        None
    };
    let response = match checked(request, &state, local).await {
        Ok(response) => response,
        Err((code, text)) => response(code, "text/plain; charset=utf-8", text),
    };
    let mut response = response;
    let headers = response.headers_mut();
    headers.insert(header::CONNECTION, HeaderValue::from_static("close"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    // Valid callers can read authentication, buffering and range errors too.
    {
        if let Some(origin) = origin {
            headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
                HeaderValue::from_static("true"),
            );
        }
        headers.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static("Content-Range, Accept-Ranges, Content-Length"),
        );
    }
    if response.status() == StatusCode::UNAUTHORIZED {
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Basic realm=\"Transmission\""),
        );
    }
    Ok(response)
}

type Failure = (StatusCode, &'static str);
fn error(code: StatusCode, text: &'static str) -> Failure {
    (code, text)
}
fn rpc_error(e: Error) -> Failure {
    if let Some(RpcFailure(status)) = e.downcast_ref::<RpcFailure>() {
        if *status == StatusCode::UNAUTHORIZED {
            return error(*status, "Authentication required\n");
        }
        if *status == StatusCode::NOT_FOUND {
            return error(*status, "Video not found\n");
        }
    }
    error(StatusCode::BAD_GATEWAY, "Transmission unavailable\n")
}

fn validate_context(
    request: &Request<Incoming>,
    state: &State,
    local: SocketAddr,
) -> Result<(), Failure> {
    for name in [
        header::HOST,
        header::ORIGIN,
        header::AUTHORIZATION,
        header::RANGE,
    ] {
        if request.headers().get_all(name).iter().count() > 1 {
            return Err(error(StatusCode::FORBIDDEN, "Ambiguous headers\n"));
        }
    }
    let authority = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<hyper::http::uri::Authority>().ok())
        .ok_or(error(StatusCode::FORBIDDEN, "Invalid host\n"))?;
    let host = authority.host().trim_matches(['[', ']']);
    if !state.config.allows_host(host, local.ip())
        || authority.port_u16().unwrap_or(80) != state.config.listen.port()
    {
        return Err(error(StatusCode::FORBIDDEN, "Invalid host\n"));
    }
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        let origin = origin
            .to_str()
            .map_err(|_| error(StatusCode::FORBIDDEN, "Invalid origin\n"))?;
        let expected = |port| format!("http://{}:{}", authority.host(), port);
        if origin != expected(state.config.rpc.port())
            && origin != expected(state.config.listen.port())
        {
            return Err(error(StatusCode::FORBIDDEN, "Invalid origin\n"));
        }
    }
    Ok(())
}

async fn checked(
    request: Request<Incoming>,
    state: &Arc<State>,
    local: SocketAddr,
) -> Result<Response<Body>, Failure> {
    validate_context(&request, state, local)?;
    let ticket_query = request.uri().query().is_some_and(|q| {
        q.strip_prefix("ticket=").is_some_and(|t| {
            t.len() == 43
                && t.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
    });
    if (request.uri().query().is_some()
        && !(ticket_query
            && (((request.uri().path().starts_with("/v1/media/")
                || request.uri().path().starts_with("/v1/subtitles/"))
                && (request.method() == Method::GET
                    || request.method() == Method::HEAD
                    || request.method() == Method::OPTIONS))
                || (request.uri().path().starts_with("/v1/priority/")
                    && (request.method() == Method::POST || request.method() == Method::OPTIONS)))))
        || request.uri().authority().is_some()
    {
        return Err(error(StatusCode::BAD_REQUEST, "Invalid URL\n"));
    }
    if request.method() == Method::OPTIONS {
        let mut r = response(StatusCode::NO_CONTENT, "text/plain", "");
        r.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, HEAD, POST, OPTIONS"),
        );
        r.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Authorization, Range, X-Drift-Stream"),
        );
        return Ok(r);
    }
    let auth = request
        .headers()
        .get(header::AUTHORIZATION)
        .cloned()
        .or_else(|| state.media_authorization(&request));
    if state.config.authentication
        && auth
            .as_ref()
            .is_none_or(|v| !v.as_bytes().starts_with(b"Basic "))
    {
        return Err(error(StatusCode::UNAUTHORIZED, "Authentication required\n"));
    }
    let path = request.uri().path();
    if path == "/v1/status" && (request.method() == Method::GET || request.method() == Method::HEAD)
    {
        // Even discovery verifies credentials against Transmission; never trust its stored password hash.
        state
            .rpc
            .call("session-get", json!({"fields":["version"]}), auth.as_ref())
            .await
            .map_err(rpc_error)?;
        return Ok(response(
            StatusCode::OK,
            "application/json",
            "{\"version\":1,\"media\":true,\"transcoding\":false}",
        ));
    }
    let parts: Vec<_> = path.split('/').collect();
    let subtitle = parts.get(2) == Some(&"subtitles");
    if parts.len() != if subtitle { 6 } else { 5 }
        || parts[1] != "v1"
        || !["media", "play", "subtitles", "priority"].contains(&parts[2])
        || parts[3].len() != 40
        || !parts[3].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(error(StatusCode::NOT_FOUND, "Video not found\n"));
    }
    let hash = parts[3].to_ascii_lowercase();
    let index: usize = parts[4]
        .parse()
        .map_err(|_| error(StatusCode::NOT_FOUND, "Video not found\n"))?;
    let play = parts[2] == "play";
    let priority = parts[2] == "priority";
    if ((play || priority) && request.method() != Method::POST)
        || (!(play || priority)
            && request.method() != Method::GET
            && request.method() != Method::HEAD)
    {
        return Err(error(
            StatusCode::METHOD_NOT_ALLOWED,
            "Method not allowed\n",
        ));
    }
    // A non-simple header prevents cross-site forms from changing torrent settings.
    if (play || priority)
        && request
            .headers()
            .get("x-drift-stream")
            .is_none_or(|v| v != "1")
    {
        return Err(error(StatusCode::FORBIDDEN, "Playback intent required\n"));
    }
    if request.headers().contains_key(header::TRANSFER_ENCODING)
        || request
            .headers()
            .get(header::CONTENT_LENGTH)
            .is_some_and(|v| v != "0")
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Request bodies are not accepted\n",
        ));
    }
    let permit =
        if priority {
            None
        } else {
            Some(
                state.streams.clone().try_acquire_owned().map_err(|_| {
                    error(StatusCode::SERVICE_UNAVAILABLE, "Stream limit reached\n")
                })?,
            )
        };
    let torrent = state
        .rpc
        .torrent(&hash, auth.as_ref())
        .await
        .map_err(rpc_error)?;
    if torrent.status == 1 || torrent.status == 2 {
        return Err(error(
            StatusCode::CONFLICT,
            "Transmission is checking this video\n",
        ));
    }
    let entry = torrent
        .files
        .get(index)
        .ok_or(error(StatusCode::NOT_FOUND, "Video not found\n"))?;
    let mime =
        files::media_type(&entry.name).ok_or(error(StatusCode::NOT_FOUND, "Video not found\n"))?;
    let length = entry.length;
    let offset = torrent.files[..index]
        .iter()
        .try_fold(0u64, |a, f| a.checked_add(f.length))
        .ok_or(error(StatusCode::BAD_GATEWAY, "Invalid torrent geometry\n"))?;
    let total = torrent
        .files
        .iter()
        .try_fold(0u64, |a, f| a.checked_add(f.length))
        .ok_or(error(StatusCode::BAD_GATEWAY, "Invalid torrent geometry\n"))?;
    if length < 16 || total.div_ceil(torrent.piece_size) != torrent.piece_count {
        return Err(error(StatusCode::BAD_GATEWAY, "Invalid torrent geometry\n"));
    }
    let bits = files::decode_pieces(&torrent.pieces, torrent.piece_count)
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "Invalid torrent pieces\n"))?;
    let media_path = format!("/v1/media/{hash}/{index}");
    let ticket = request
        .uri()
        .query()
        .and_then(|q| q.strip_prefix("ticket="));
    if priority {
        // Changing scheduling requires explicit intent and normal RPC credentials;
        // the ticket only identifies this player's pending range requests.
        let pending = {
            let leases = state.leases.lock().map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Session store unavailable\n",
                )
            })?;
            let lease = ticket
                .and_then(|t| leases.get(t))
                .filter(|l| l.path == media_path && l.expires > Instant::now())
                .ok_or(error(StatusCode::FORBIDDEN, "Playback session expired\n"))?;
            lease
                .pending
                .last_key_value()
                .map(|(_, position)| *position)
        };
        let first_ready =
            files::verified_end(&bits, torrent.piece_size, offset, offset + length.min(512))
                == offset + length.min(512);
        let needed = pending
            .or(if first_ready { None } else { Some(0) })
            .filter(|p| *p < length);
        let missing = needed.filter(|p| {
            files::verified_end(&bits, torrent.piece_size, offset + p, offset + p + 1) == offset + p
        });
        if let Some(position) = missing {
            let piece = (offset + position) / torrent.piece_size;
            if !torrent.sequential_download || torrent.sequential_download_from_piece != piece {
                state.rpc.call("torrent-set", json!({"ids":[hash],"sequential_download":true,"sequential_download_from_piece":piece}), auth.as_ref()).await.map_err(rpc_error)?;
            }
        }
        return Ok(response(
            StatusCode::OK,
            "application/json",
            &json!({"pending":missing.is_some(),"offset":missing,"firstPieceReady":first_ready})
                .to_string(),
        ));
    }
    let tracks = subtitles::matching(&torrent, index);
    if subtitle {
        let subtitle_index: usize = parts[5]
            .parse()
            .map_err(|_| error(StatusCode::NOT_FOUND, "Subtitle not found\n"))?;
        if !tracks.iter().any(|t| t.index == subtitle_index) {
            return Err(error(StatusCode::NOT_FOUND, "Subtitle not found\n"));
        }
        let entry = &torrent.files[subtitle_index];
        let subtitle_offset = torrent.files[..subtitle_index]
            .iter()
            .try_fold(0u64, |a, f| a.checked_add(f.length))
            .ok_or(error(StatusCode::BAD_GATEWAY, "Invalid torrent geometry\n"))?;
        if torrent.status == 1
            || torrent.status == 2
            || (!torrent.sequential_download
                && files::verified_end(&bits, torrent.piece_size, offset, offset + length)
                    < offset + length)
            || files::verified_end(
                &bits,
                torrent.piece_size,
                subtitle_offset,
                subtitle_offset + entry.length,
            ) < subtitle_offset + entry.length
        {
            return Err(error(
                StatusCode::CONFLICT,
                "Subtitles are still downloading\n",
            ));
        }
        let state = state.clone();
        let length = entry.length;
        let vtt = tokio::task::spawn_blocking(move || {
            let file = files::open_torrent_file(&state.roots, &torrent, subtitle_index)
                .map_err(|_| error(StatusCode::NOT_FOUND, "Subtitle not found\n"))?;
            let bytes = files::read_at(&file, 0, length as usize).map_err(|_| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Subtitle data unavailable\n",
                )
            })?;
            subtitles::convert(&bytes).map_err(|_| {
                error(
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    "Invalid or unsupported subtitle text\n",
                )
            })
        })
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "Subtitle unavailable\n"))??;
        let mut reply = response(StatusCode::OK, "text/vtt; charset=utf-8", &vtt);
        reply.headers_mut().insert(
            header::CONTENT_LENGTH,
            vtt.len().to_string().parse().unwrap(),
        );
        if request.method() == Method::HEAD {
            *reply.body_mut() = empty();
        }
        return Ok(reply);
    }
    if play {
        let wanted: Vec<_> = std::iter::once(index)
            .chain(tracks.iter().map(|t| t.index))
            .collect();
        state.rpc.call("torrent-set", json!({"ids":[hash],"sequential_download":true,"sequential_download_from_piece":offset / torrent.piece_size,"files-wanted":wanted}), auth.as_ref()).await.map_err(rpc_error)?;
        if torrent.status == 0
            && files::verified_end(&bits, torrent.piece_size, offset, offset + length)
                < offset + length
        {
            state
                .rpc
                .call("torrent-start", json!({"ids":[hash]}), auth.as_ref())
                .await
                .map_err(rpc_error)?;
        }
        let path = format!("/v1/media/{hash}/{index}");
        let session = state
            .authorize_media(
                path.clone(),
                if state.config.authentication {
                    auth.clone()
                } else {
                    None
                },
            )
            .map_err(|_| {
                error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Cannot create media session\n",
                )
            })?;
        let src = format!("{path}?ticket={}", session.1);
        let captions: Vec<_> = tracks
            .iter()
            .map(|track| {
                let path = format!("/v1/subtitles/{hash}/{index}/{}", track.index);
                let src = format!("{path}?ticket={}", session.1);
                json!({"index":track.index,"label":track.label,"language":track.language,"src":src})
            })
            .collect();
        let mut reply = response(
            StatusCode::OK,
            "application/json",
            &json!({"version":1,"src":src,"type":mime,"length":length,"subtitles":captions,"priority":format!("/v1/priority/{hash}/{index}?ticket={}",session.1)})
                .to_string(),
        );
        if state.config.authentication {
            reply.headers_mut().insert(header::SET_COOKIE, session.0);
        }
        return Ok(reply);
    }
    if torrent.status == 1
        || torrent.status == 2
        || (!torrent.sequential_download
            && files::verified_end(&bits, torrent.piece_size, offset, offset + length)
                < offset + length)
    {
        return Err(error(
            StatusCode::CONFLICT,
            "Use the playback endpoint to enable sequential mode; wait for verification to finish\n",
        ));
    }
    let (start, end, partial) = match parse_range(
        request
            .headers()
            .get(header::RANGE)
            .map(|v| v.to_str().unwrap_or("")),
        length,
    ) {
        Ok(range) => range,
        Err(InvalidRange) => {
            let mut r = response(
                StatusCode::RANGE_NOT_SATISFIABLE,
                "text/plain",
                "Invalid byte range\n",
            );
            r.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes */{length}").parse().unwrap(),
            );
            return Ok(r);
        }
    };
    let file = files::open_media(&state.roots, &torrent, index)
        .map_err(|_| error(StatusCode::NOT_FOUND, "Video not found\n"))?;
    let mut stream = Media {
        state: state.clone(),
        torrent,
        bits,
        file: Arc::new(file),
        auth,
        offset,
        index,
        _permit: permit.ok_or(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Missing stream slot\n",
        ))?,
        pending: ticket.and_then(|token| {
            let leases = state.leases.lock().ok()?;
            let lease = leases.get(token)?;
            (lease.path == media_path && lease.expires > Instant::now()).then(|| PendingRange {
                state: state.clone(),
                token: token.to_owned(),
                id: state.next_request.fetch_add(1, Ordering::Relaxed),
            })
        }),
    };
    // Sniff only verified bytes, never sparse/unflushed data. Bound the startup wait.
    let sniff_len = length.min(512);
    let mut sniff_end = 0;
    while sniff_end < sniff_len {
        sniff_end = stream
            .wait_for(sniff_end, sniff_len)
            .await
            .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "Waiting for video data\n"))?;
    }
    let sniff = stream
        .read(0, sniff_len as usize)
        .await
        .map_err(|_| error(StatusCode::SERVICE_UNAVAILABLE, "Waiting for video data\n"))?;
    if !files::matches_container(mime, &sniff) {
        return Err(error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Unrecognized video container\n",
        ));
    }
    let body = if request.method() == Method::HEAD {
        empty()
    } else {
        let body = async_stream::try_stream! {
            let mut position = start;
            while position < end {
                let wanted = end.min(position + CHUNK as u64);
                let available = stream.wait_for(position, wanted).await?;
                let bytes = stream.read(position, (available - position) as usize).await?;
                position = available;
                yield Frame::data(Bytes::from(bytes));
            }
        };
        StreamBody::new(body).boxed_unsync()
    };
    let mut r = Response::new(body);
    *r.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    r.headers_mut().insert(
        header::CONTENT_LENGTH,
        (end - start).to_string().parse().unwrap(),
    );
    r.headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if partial {
        r.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{length}", end - 1)
                .parse()
                .unwrap(),
        );
    }
    Ok(r)
}

struct Media {
    state: Arc<State>,
    torrent: Torrent,
    bits: Vec<u8>,
    file: Arc<File>,
    auth: Option<HeaderValue>,
    offset: u64,
    index: usize,
    _permit: OwnedSemaphorePermit,
    pending: Option<PendingRange>,
}
impl Media {
    async fn wait_for(&mut self, position: u64, wanted: u64) -> Result<u64, Error> {
        let deadline = Instant::now() + WAIT;
        let mut announced = false;
        loop {
            let available = files::verified_end(
                &self.bits,
                self.torrent.piece_size,
                self.offset + position,
                self.offset + wanted,
            ) - self.offset;
            if available > position {
                if announced {
                    if let Some(pending) = &self.pending {
                        pending.set(None);
                    }
                }
                return Ok(available);
            }
            if !announced {
                if let Some(pending) = &self.pending {
                    pending.set(Some(position));
                }
                announced = true;
            }
            if Instant::now() >= deadline {
                return Err("Timed out waiting for verified pieces".into());
            }
            // Only a body actively waiting on a hole polls; dropping it cancels the timer and RPC.
            sleep(Duration::from_millis(500)).await;
            let next = self
                .state
                .rpc
                .torrent(&self.torrent.hash, self.auth.as_ref())
                .await?;
            if next.status == 1 || next.status == 2 || !next.sequential_download {
                return Err("Sequential playback was disabled or verification started".into());
            }
            if next.piece_size != self.torrent.piece_size
                || next.piece_count != self.torrent.piece_count
                || next.files.len() != self.torrent.files.len()
                || next
                    .files
                    .iter()
                    .zip(&self.torrent.files)
                    .any(|(a, b)| a.length != b.length || a.name != b.name)
            {
                return Err("Torrent changed during playback".into());
            }
            self.bits = files::decode_pieces(&next.pieces, next.piece_count)?;
            self.torrent = next;
            self.file = Arc::new(files::open_media(
                &self.state.roots,
                &self.torrent,
                self.index,
            )?);
        }
    }
    async fn read(&self, position: u64, length: usize) -> Result<Vec<u8>, Error> {
        let file = self.file.clone();
        Ok(timeout(
            Duration::from_secs(5),
            tokio::task::spawn_blocking(move || files::read_at(&file, position, length)),
        )
        .await???)
    }
}

// Half-open byte ranges simplify chunk boundaries and avoid inclusive-length overflow.
#[derive(Debug, PartialEq, Eq)]
pub struct InvalidRange;

pub fn parse_range(value: Option<&str>, length: u64) -> Result<(u64, u64, bool), InvalidRange> {
    let Some(value) = value else {
        return Ok((0, length, false));
    };
    let value = value.strip_prefix("bytes=").ok_or(InvalidRange)?;
    let (a, b) = value.split_once('-').ok_or(InvalidRange)?;
    let number = |s: &str| {
        if !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) {
            s.parse::<u64>().map_err(|_| InvalidRange)
        } else {
            Err(InvalidRange)
        }
    };
    if length == 0 {
        return Err(InvalidRange);
    }
    if a.is_empty() {
        let suffix = number(b)?;
        if suffix == 0 {
            return Err(InvalidRange);
        }
        return Ok((length.saturating_sub(suffix), length, true));
    }
    let start = number(a)?;
    let end = if b.is_empty() {
        length
    } else {
        number(b)?.saturating_add(1).min(length)
    };
    if start >= end || start >= length {
        return Err(InvalidRange);
    }
    Ok((start, end, true))
}
fn empty() -> Body {
    Full::new(Bytes::new())
        .map_err(|e| match e {})
        .boxed_unsync()
}
fn response(status: StatusCode, mime: &'static str, text: &str) -> Response<Body> {
    let mut r = Response::new(
        Full::new(Bytes::copy_from_slice(text.as_bytes()))
            .map_err(|e| match e {})
            .boxed_unsync(),
    );
    *r.status_mut() = status;
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn byte_ranges_cover_browser_probes_and_overflow() {
        assert_eq!(parse_range(Some("bytes=0-1"), 100), Ok((0, 2, true)));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Ok((90, 100, true)));
        assert_eq!(parse_range(Some("bytes=90-"), 100), Ok((90, 100, true)));
        assert_eq!(
            parse_range(Some("bytes=0-18446744073709551615"), 100),
            Ok((0, 100, true))
        );
        for s in [
            "bytes=100-",
            "bytes=-0",
            "bytes=20-10",
            "bytes=0-1,4-5",
            "bytes=+1-2",
            "bytes=1-18446744073709551616",
        ] {
            assert!(parse_range(Some(s), 100).is_err(), "{s}");
        }
    }
}
