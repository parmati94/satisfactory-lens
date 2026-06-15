import { Agent, fetch as undiciFetch } from 'undici';
import { config } from '../config';

// Runtime connection state (overrides env vars when set via the connect UI)
let runtimeHost = '';
let runtimePort = 0;
let bearerToken: string | null = null;

let tlsAgent: Agent | null = null;

function getAgent(): Agent {
  if (!tlsAgent) {
    tlsAgent = new Agent({
      connect: { rejectUnauthorized: !config.sfAllowSelfSigned },
    });
  }
  return tlsAgent;
}

function effectiveHost(): string {
  return runtimeHost || config.sfHost;
}

function effectivePort(): number {
  return runtimePort || config.sfPort;
}

function baseUrl(): string {
  return `https://${effectiveHost()}:${effectivePort()}/api/v1`;
}

async function call<T = unknown>(fn: string, data: Record<string, unknown> = {}): Promise<T> {
  const host = effectiveHost();
  if (!host) throw new Error('Satisfactory server host not configured. Use the Connect button.');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

  const res = await undiciFetch(baseUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ function: fn, data }),
    // @ts-ignore undici-specific dispatcher not in fetch types
    dispatcher: getAgent(),
  });

  const text = await res.text();
  const json = (text.trim() ? JSON.parse(text) : {}) as Record<string, unknown>;

  if (!res.ok) {
    const errCode = json['errorCode'] ?? res.status;
    const errMsg = json['errorMessage'] ?? JSON.stringify(json);
    throw new Error(`SF API [${fn}] ${errCode}: ${errMsg}`);
  }

  return (json['data'] ?? json) as T;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

async function login(password: string): Promise<void> {
  const fn = password ? 'PasswordLogin' : 'PasswordlessLogin';
  const data = password
    ? { password, minimumPrivilegeLevel: 'Administrator' }
    : { minimumPrivilegeLevel: 'Client' };
  const result = await call<{ authenticationToken: string }>(fn, data);
  bearerToken = result.authenticationToken;
}

export async function connectTo(host: string, port: number, password: string): Promise<void> {
  runtimeHost = host;
  runtimePort = port || config.sfPort;
  // Reset agent if host changed (new TLS connection needed)
  tlsAgent = null;
  await login(password);
}

export async function autoConnect(): Promise<void> {
  await connectTo(config.sfHost, config.sfPort, config.sfPassword);
}

export function disconnect(): void {
  bearerToken = null;
}

export function isConnected(): boolean {
  return bearerToken !== null;
}

export function getConnectionInfo(): { host: string; port: number; connected: boolean } {
  return {
    host: effectiveHost(),
    port: effectivePort(),
    connected: isConnected(),
  };
}

// ─── API wrappers ─────────────────────────────────────────────────────────────

export function healthCheck() {
  return call('HealthCheck', { clientCustomData: '' });
}

export function queryServerState() {
  return call('QueryServerState');
}

export function getServerOptions() {
  return call('GetServerOptions');
}

export function setServerOptions(options: Record<string, string>) {
  return call('SetServerOptions', { appliedOptions: options });
}

export function getAdvancedGameSettings() {
  return call('GetAdvancedGameSettings');
}

export function applyAdvancedGameSettings(settings: Record<string, string>) {
  return call('ApplyAdvancedGameSettings', { appliedAdvancedGameSettings: settings });
}

export function enumerateSessions() {
  return call('EnumerateSessions');
}

export function loadGame(sessionName: string, saveName: string, enableAdvancedGameSettings = false) {
  return call('LoadGame', { sessionName, saveName, enableAdvancedGameSettings });
}

export function saveGame(saveName: string) {
  return call('SaveGame', { saveName });
}

export function deleteSavegame(saveName: string) {
  return call('DeleteSaveFile', { saveName });
}

export function runCommand(command: string) {
  return call('RunCommand', { command });
}

/** Download a save file as a raw Buffer (SF API returns binary octet-stream). */
export async function downloadSavegame(saveName: string): Promise<Buffer> {
  const host = effectiveHost();
  if (!host) throw new Error('Satisfactory server host not configured.');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;

  const res = await undiciFetch(baseUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ function: 'DownloadSavegame', data: { saveName } }),
    // @ts-ignore undici-specific dispatcher not in fetch types
    dispatcher: getAgent(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SF API [DownloadSavegame] ${res.status}: ${text}`);
  }

  return Buffer.from(await res.arrayBuffer());
}
