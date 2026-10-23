//! Agent context: the registry of context modules ([`registry`]) and the
//! writer of the managed region in provider context files ([`writer`],
//! agent-providers.md §7). Enablement lives in `ProjectConfig.agentContext`.

pub mod registry;
pub mod writer;

pub use registry::{ContextModule, ContextModuleInfo, ContextRegistry, BASE_MODULE};
pub use writer::{render_region, sync, ContextFileResult, ContextSyncReport};
