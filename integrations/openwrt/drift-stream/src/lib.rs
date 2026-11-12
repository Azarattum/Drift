pub mod config;
pub mod files;
pub mod http;
pub mod rpc;

pub type Error = Box<dyn std::error::Error + Send + Sync>;
