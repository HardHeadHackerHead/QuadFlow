/**
 * `@quadflow/plugin-api/rpc` — the sandbox transport (plugin-system.md §8.4):
 * the wire protocol shared by the host bridge and the in-frame runtime, and the
 * frame-side `PluginContext` implementation. Not for plugin code: plugins get
 * their context from the host in both isolation modes.
 */
export * from './protocol'
export { connectRpc, windowEndpoint, toRpcError, type RpcEndpoint, type RpcFrame } from './client'
