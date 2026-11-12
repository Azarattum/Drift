pub mod config;
pub mod files;
pub mod http;
pub mod rpc;
pub mod subtitles;

pub type Error = Box<dyn std::error::Error + Send + Sync>;
