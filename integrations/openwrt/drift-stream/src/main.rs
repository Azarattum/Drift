use drift_stream::Error;
#[cfg(target_os = "linux")]
use drift_stream::{
    config::Config,
    http::{self, State},
};
#[cfg(target_os = "linux")]
use hyper::service::service_fn;
#[cfg(target_os = "linux")]
use hyper_util::rt::{TokioIo, TokioTimer};
use std::time::Duration;
#[cfg(target_os = "linux")]
use std::{path::PathBuf, sync::Arc};
#[cfg(target_os = "linux")]
use tokio::{net::TcpListener, sync::Semaphore, task::JoinSet};

fn main() -> Result<(), Error> {
    // One reactor, at most two disk workers. Workers retire after activity; no idle watchdog.
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(2)
        .thread_keep_alive(Duration::from_secs(1))
        .build()?
        .block_on(run())
}

async fn run() -> Result<(), Error> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 || !["--pid", "--config-dir"].contains(&args[0].as_str()) {
        return Err(
            "Usage: drift-stream --config-dir <Transmission directory> | --pid <pid>".into(),
        );
    }
    #[cfg(target_os = "linux")]
    let pid: u32 = if args[0] == "--pid" {
        args[1].parse()?
    } else {
        discover(std::path::Path::new(&args[1])).await?
    };
    #[cfg(not(target_os = "linux"))]
    let pid = 0u32;
    // Open the pidfd before inspecting /proc: exit/reuse cannot silently retarget the watcher.
    #[cfg(target_os = "linux")]
    let pidfd = rustix::process::pidfd_open(
        rustix::process::Pid::from_raw(i32::try_from(pid)?).ok_or("Invalid PID")?,
        rustix::process::PidfdFlags::NONBLOCK,
    )?;
    #[cfg(target_os = "linux")]
    // SAFETY: the OwnedFd is moved into AsyncFd, never closed or replaced until it is dropped.
    let process = unsafe {
        tokio::io::unix::AsyncFd::register_with_interest(pidfd, tokio::io::Interest::READABLE)?
    };
    #[cfg(not(target_os = "linux"))]
    return Err(format!("OpenWrt/Linux is required (PID {pid})").into());

    #[cfg(target_os = "linux")]
    {
        let command = std::fs::read(format!("/proc/{pid}/cmdline"))?;
        let arguments: Vec<_> = command
            .split(|b| *b == 0)
            .filter(|v| !v.is_empty())
            .map(std::str::from_utf8)
            .collect::<Result<_, _>>()?;
        if arguments
            .first()
            .and_then(|p| std::path::Path::new(p).file_name())
            .is_none_or(|n| n != "transmission-daemon")
        {
            return Err("PID is not transmission-daemon".into());
        }
        let directory = arguments
            .windows(2)
            .find(|a| a[0] == "-g" || a[0] == "--config-dir")
            .map(|a| PathBuf::from(a[1]))
            .ok_or("Transmission must have an explicit config directory")?;
        let settings = std::fs::read(directory.join("settings.json"))?;
        let config = Config::parse(&serde_json::from_slice(&settings)?)?;
        let listen = config.listen;
        let state = Arc::new(State::new(config)?);
        let listener = TcpListener::bind(listen).await?;
        eprintln!(
            "drift-stream {} listening on {listen}; following Transmission PID {pid}",
            env!("CARGO_PKG_VERSION")
        );
        let slots = Arc::new(Semaphore::new(http::CONNECTIONS));
        let mut connections = JoinSet::new();
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        loop {
            tokio::select! {
                biased;
                result = process.readable() => { eprintln!("Transmission exit notification: {}", if result.is_ok() { "exited" } else { "watch failed" }); break; },
                _ = term.recv() => { eprintln!("Stopping on SIGTERM"); break; },
                _ = tokio::signal::ctrl_c() => { eprintln!("Stopping on SIGINT"); break; },
                Some(_) = connections.join_next(), if !connections.is_empty() => {},
                incoming = listener.accept() => {
                    let (socket, peer) = incoming?;
                    if !state.config.allows_peer(peer.ip()) { continue; }
                    let Ok(permit) = slots.clone().try_acquire_owned() else { continue; };
                    let local = socket.local_addr()?;
                    socket.set_nodelay(true)?;
                    let state = state.clone();
                    connections.spawn(async move {
                        let _permit = permit;
                        let service = service_fn(move |request| http::handle(request, state.clone(), local));
                        let mut builder = hyper::server::conn::http1::Builder::new();
                        builder.keep_alive(false).max_headers(32).max_buf_size(16 * 1024)
                            .auto_date_header(false).timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(5));
                        // A stalled receiver cannot occupy a connection forever. This is a lifetime bound,
                        // not a recurring timer; normal films can stream for up to 12 hours per request.
                        let _ = tokio::time::timeout(Duration::from_secs(12 * 3600), builder.serve_connection(TokioIo::new(socket), service)).await;
                    });
                }
            }
        }
        // Immediate cancellation: no body waits, RPCs, disk queues or sockets survive Transmission.
        connections.abort_all();
        while connections.join_next().await.is_some() {}
        Ok(())
    }
}

#[cfg(target_os = "linux")]
async fn discover(directory: &std::path::Path) -> Result<u32, Error> {
    // Only during startup: procd may launch siblings in either order. No background scan.
    for _ in 0..100 {
        let mut found = None;
        for entry in std::fs::read_dir("/proc")?.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.parse::<u32>().ok())
            else {
                continue;
            };
            let Ok(command) = std::fs::read(entry.path().join("cmdline")) else {
                continue;
            };
            let arguments: Vec<_> = command
                .split(|b| *b == 0)
                .filter_map(|a| std::str::from_utf8(a).ok())
                .collect();
            if arguments
                .first()
                .and_then(|p| std::path::Path::new(p).file_name())
                .is_some_and(|n| n == "transmission-daemon")
                && arguments.windows(2).any(|a| {
                    (a[0] == "-g" || a[0] == "--config-dir")
                        && std::path::Path::new(a[1]) == directory
                })
                && found.replace(pid).is_some()
            {
                return Err("Multiple Transmission instances use this config directory".into());
            }
        }
        if let Some(pid) = found {
            return Ok(pid);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("Transmission did not start within ten seconds".into())
}
