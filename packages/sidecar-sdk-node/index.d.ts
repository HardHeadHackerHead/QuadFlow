export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export declare class RpcError extends Error {
  constructor(code: number, message: string, data?: JsonValue)
  code: number
  data?: JsonValue
  /** QuadFlow error code (`permission_denied`, `not_found`, …) when the host sent one. */
  kind?: string
}

export interface InitializeParams {
  protocolVersion: number
  host: { version: string; apiVersion: string; platform: string; arch: string; mode: 'gui' | 'cli' }
  plugin: { id: string; version: string; dir: string; dataDir: string }
  project: { root: string; rootKey: string } | null
  settings: Record<string, JsonValue>
  locale: string
}

export interface Host {
  request<T = JsonValue>(method: string, params?: JsonValue, opts?: { timeoutMs?: number }): Promise<T>
  /** `host/call`: a host API method (e.g. `storage.get`), permission-checked like UI calls. */
  call<T = JsonValue>(method: string, params?: JsonValue, opts?: { timeoutMs?: number }): Promise<T>
  notify(method: string, params?: JsonValue): void
  emit(topic: string, payload?: JsonValue): void
  ui(name: string, params?: JsonValue): void
  log(level: 'debug' | 'info' | 'warn' | 'error', message: unknown): void
  readonly init: InitializeParams | null
}

export interface Server {
  readonly host: Host
  onRequest(method: string, fn: (params: any, host: Host) => unknown): Server
  onNotification(method: string, fn: (params: any, host: Host) => unknown): Server
  onInitialize(fn: (params: InitializeParams, host: Host) => unknown): Server
  onShutdown(fn: (host: Host) => unknown): Server
  run(opts?: { exit?: boolean }): Promise<void>
}

export declare function createServer(opts?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }): Server
