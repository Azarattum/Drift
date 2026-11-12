use bytes::Bytes;
use drift_stream::{
    config::Config,
    http::{self, State},
};
use http_body_util::{BodyExt, Full};
use hyper::{Request, Response, StatusCode, body::Incoming, service::service_fn};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    task::JoinHandle,
    time::timeout,
};

const HASH: &str = "0123456789012345678901234567890123456789";
struct Fixture {
    _dir: tempfile::TempDir,
    tasks: Vec<JoinHandle<()>>,
    address: SocketAddr,
    bits: Arc<AtomicU8>,
    calls: Arc<AtomicUsize>,
    writes: Arc<AtomicUsize>,
    data: Vec<u8>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}
impl Fixture {
    async fn new(auth: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let incomplete = dir.path().join(".incomplete");
        std::fs::create_dir(&incomplete).unwrap();
        let mut data = (0..131072).map(|n| (n % 251) as u8).collect::<Vec<_>>();
        data[..16].copy_from_slice(b"\0\0\0\x18ftypisom\0\0\0\0");
        std::fs::write(incomplete.join("movie.mp4.part"), &data).unwrap();
        std::fs::write(incomplete.join("fake.mp4.part"), vec![b'x'; 131072]).unwrap();
        let rpc_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let rpc_address = rpc_listener.local_addr().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut config = Config::parse(&json!({"download-dir":dir.path(),"incomplete-dir":incomplete,"incomplete-dir-enabled":true,"rpc-port":rpc_address.port(),"rpc-authentication-required":auth})).unwrap();
        config.listen = address;
        let bits = Arc::new(AtomicU8::new(0xe0));
        let calls = Arc::new(AtomicUsize::new(0));
        let writes = Arc::new(AtomicUsize::new(0));
        let (b, c, w, root) = (
            bits.clone(),
            calls.clone(),
            writes.clone(),
            dir.path().to_owned(),
        );
        let rpc_task = tokio::spawn(async move {
            while let Ok((socket, _)) = rpc_listener.accept().await {
                let (b, c, w, root) = (b.clone(), c.clone(), w.clone(), root.clone());
                tokio::spawn(async move {
                    let service = service_fn(move |request: Request<Incoming>| {
                        let (b, c, w, root) = (b.clone(), c.clone(), w.clone(), root.clone());
                        async move {
                            c.fetch_add(1, Ordering::SeqCst);
                            if auth
                                && request
                                    .headers()
                                    .get("authorization")
                                    .is_none_or(|h| h != "Basic dXNlcjpwYXNz")
                            {
                                return Ok::<_, Infallible>(
                                    Response::builder()
                                        .status(401)
                                        .body(Full::new(Bytes::new()))
                                        .unwrap(),
                                );
                            }
                            if request
                                .headers()
                                .get("x-transmission-session-id")
                                .is_none_or(|h| h != "fixture-token")
                            {
                                return Ok(Response::builder()
                                    .status(409)
                                    .header("x-transmission-session-id", "fixture-token")
                                    .body(Full::new(Bytes::new()))
                                    .unwrap());
                            }
                            let value: Value = serde_json::from_slice(
                                &request.into_body().collect().await.unwrap().to_bytes(),
                            )
                            .unwrap();
                            let arguments = match value["method"].as_str().unwrap() {
                                "session-get" => json!({"version":"4.1.3"}),
                                "torrent-set" | "torrent-start" => {
                                    w.fetch_add(1, Ordering::SeqCst);
                                    json!({})
                                }
                                "torrent-get" => {
                                    json!({"torrents":[{"hashString":HASH,"downloadDir":root,"pieceSize":65536,"pieceCount":5,"pieces":base64::Engine::encode(&base64::engine::general_purpose::STANDARD,[b.load(Ordering::SeqCst)]),"status":4,"sequential_download":true,"files":[{"name":"notes.nfo","length":333},{"name":"movie.mp4","length":131072},{"name":"fake.mp4","length":131072}]}]})
                                }
                                _ => panic!("unexpected RPC"),
                            };
                            Ok(Response::new(Full::new(Bytes::from(
                                json!({"result":"success","arguments":arguments}).to_string(),
                            ))))
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .keep_alive(false)
                        .serve_connection(TokioIo::new(socket), service)
                        .await;
                });
            }
        });
        let state = Arc::new(State::new(config).unwrap());
        let server = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let state = state.clone();
                tokio::spawn(async move {
                    let service =
                        service_fn(move |request| http::handle(request, state.clone(), address));
                    let _ = hyper::server::conn::http1::Builder::new()
                        .keep_alive(false)
                        .serve_connection(TokioIo::new(socket), service)
                        .await;
                });
            }
        });
        Self {
            _dir: dir,
            tasks: vec![rpc_task, server],
            address,
            bits,
            calls,
            writes,
            data,
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
    ) -> Response<Incoming> {
        let socket = TcpStream::connect(self.address).await.unwrap();
        let (mut client, connection) = hyper::client::conn::http1::handshake(TokioIo::new(socket))
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let mut r = Request::builder()
            .method(method)
            .uri(path)
            .header("host", self.address.to_string());
        for (name, value) in headers {
            r = r.header(*name, *value);
        }
        client
            .send_request(r.body(Full::new(Bytes::new())).unwrap())
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn part_files_ranges_head_and_no_get_mutations() {
    let f = Fixture::new(false).await;
    let r = f
        .request(
            "GET",
            &format!("/v1/media/{HASH}/1"),
            &[("range", "bytes=10-500")],
        )
        .await;
    assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(r.headers()["content-range"], "bytes 10-500/131072");
    assert_eq!(r.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        r.into_body().collect().await.unwrap().to_bytes(),
        &f.data[10..501]
    );
    let r = f.request("HEAD", &format!("/v1/media/{HASH}/1"), &[]).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["content-length"], "131072");
    assert!(r.into_body().collect().await.unwrap().to_bytes().is_empty());
    assert_eq!(f.writes.load(Ordering::SeqCst), 0);
    let r = f
        .request(
            "POST",
            &format!("/v1/play/{HASH}/1"),
            &[("x-drift-stream", "1")],
        )
        .await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(f.writes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn never_sends_a_hole_and_stops_polling_after_disconnect() {
    let f = Fixture::new(false).await;
    f.bits.store(0x80, Ordering::SeqCst);
    let r = f.request("GET", &format!("/v1/media/{HASH}/1"), &[]).await;
    let mut body = r.into_body();
    let mut prefix = Vec::new();
    while prefix.len() < 65536 - 333 {
        prefix.extend_from_slice(&body.frame().await.unwrap().unwrap().into_data().unwrap());
    }
    assert_eq!(prefix.len(), 65536 - 333);
    assert_eq!(prefix, &f.data[..65536 - 333]);
    assert!(
        timeout(Duration::from_millis(150), body.frame())
            .await
            .is_err()
    );
    f.bits.store(0xf8, Ordering::SeqCst);
    let rest = timeout(Duration::from_secs(3), body.collect())
        .await
        .unwrap()
        .unwrap()
        .to_bytes();
    assert_eq!(rest, &f.data[65536 - 333..]);
    f.bits.store(0x80, Ordering::SeqCst);
    let r = f.request("GET", &format!("/v1/media/{HASH}/1"), &[]).await;
    drop(r);
    tokio::time::sleep(Duration::from_millis(650)).await;
    let calls = f.calls.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(650)).await;
    assert_eq!(f.calls.load(Ordering::SeqCst), calls);
}

#[tokio::test]
async fn auth_origin_path_and_container_rejections() {
    let f = Fixture::new(true).await;
    let path = format!("/v1/media/{HASH}/1");
    assert_eq!(f.request("GET", &path, &[]).await.status(), 401);
    let origin = format!("http://{}", f.address);
    let denied = f.request("GET", &path, &[("origin", &origin)]).await;
    assert_eq!(denied.status(), 401);
    assert_eq!(denied.headers()["access-control-allow-origin"], origin);
    assert_eq!(
        f.request("GET", &path, &[("authorization", "Basic dXNlcjp3cm9uZw==")])
            .await
            .status(),
        401
    );
    let auth = ("authorization", "Basic dXNlcjpwYXNz");
    assert_eq!(
        f.request("GET", &path, &[auth, ("range", "bytes=0-1")])
            .await
            .status(),
        206
    );
    assert_eq!(
        f.request("GET", &path, &[auth, ("origin", "http://evil.test")])
            .await
            .status(),
        403
    );
    assert_eq!(
        f.request("GET", &path, &[auth, ("host", "evil.test:9092")])
            .await
            .status(),
        403
    );
    assert_eq!(
        f.request("GET", &format!("/v1/media/{HASH}/0"), &[auth])
            .await
            .status(),
        404
    );
    assert_eq!(
        f.request("GET", "/v1/media/../../etc/passwd", &[auth])
            .await
            .status(),
        404
    );
    assert_eq!(
        f.request("GET", &format!("{path}?path=/etc/passwd"), &[auth])
            .await
            .status(),
        400
    );
    assert_eq!(
        f.request("POST", &format!("/v1/play/{HASH}/1"), &[auth])
            .await
            .status(),
        403
    );
    f.bits.store(0xf8, Ordering::SeqCst);
    assert_eq!(
        f.request("GET", &format!("/v1/media/{HASH}/2"), &[auth])
            .await
            .status(),
        415
    );
    assert_eq!(
        f.request("GET", &path, &[auth, ("range", "bytes=131072-")])
            .await
            .status(),
        416
    );
}

#[tokio::test]
async fn media_sessions_are_opaque_scoped_and_still_checked_by_transmission() {
    let f = Fixture::new(true).await;
    let response = f
        .request(
            "POST",
            &format!("/v1/play/{HASH}/1"),
            &[
                ("authorization", "Basic dXNlcjpwYXNz"),
                ("x-drift-stream", "1"),
            ],
        )
        .await;
    assert_eq!(response.status(), 200);
    let cookie = response.headers()["set-cookie"].to_str().unwrap();
    assert!(cookie.contains("HttpOnly; SameSite=Strict"));
    assert!(cookie.contains(&format!("Path=/v1/media/{HASH}/1")));
    assert!(!cookie.contains("dXNlcjpwYXNz"));
    let token = cookie.split(';').next().unwrap().to_owned();
    let payload: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let ticket_url = payload["src"].as_str().unwrap();
    assert!(ticket_url.contains("?ticket="));
    assert!(!ticket_url.contains("dXNlcjpwYXNz"));
    assert_eq!(
        f.request("GET", ticket_url, &[("range", "bytes=0-1")])
            .await
            .status(),
        206
    );
    assert_eq!(
        f.request("GET", &ticket_url.replace("/1?", "/2?"), &[])
            .await
            .status(),
        401
    );

    let media = f
        .request(
            "GET",
            &format!("/v1/media/{HASH}/1"),
            &[("cookie", token.as_str()), ("range", "bytes=0-1")],
        )
        .await;
    assert_eq!(media.status(), 206);
    assert_eq!(
        media.into_body().collect().await.unwrap().to_bytes(),
        &f.data[..2]
    );
    assert_eq!(
        f.request(
            "GET",
            &format!("/v1/media/{HASH}/2"),
            &[("cookie", token.as_str())]
        )
        .await
        .status(),
        401
    );
    assert_eq!(
        f.request("GET", "/v1/status", &[("cookie", token.as_str())])
            .await
            .status(),
        401
    );
    assert_eq!(
        f.request(
            "GET",
            &format!("/v1/media/{HASH}/1"),
            &[
                ("cookie", token.as_str()),
                ("authorization", "Basic dXNlcjp3cm9uZw==")
            ]
        )
        .await
        .status(),
        401
    );
}
