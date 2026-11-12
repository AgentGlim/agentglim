export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface Ev { seq: number; kind: string; source: string; ts: number; data: Record<string, any> }
export interface Status {
  version: string; api_version: number; uptime_s: number;
  sources: { id: string; kind: string; detected: boolean; reason: string | null; caps: string[]; sessions?: number }[];
  runtimes: { id: string; state: { state: 'up' | 'down' | 'owner_off'; models?: string[]; vram_bytes?: number; ram_bytes?: number; slots?: number; ctx?: number; tps?: number } }[];
  sessions: { total: number; active: number }; needs_you: number;
  tasks: { running: number; interrupted: number; total: number }; last_seq: number;
}
export interface Data { status: Status; events: Ev[]; now: number }
