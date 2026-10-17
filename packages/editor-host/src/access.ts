/** Access policy belongs to the Host; this adapter only displays fresh metadata. */
export interface HostAccessMetadata {
  scope: 'owner-only' | 'public' | 'link' | 'restricted';
  revision: number;
  expiresAt: number;
  source: string;
}
export interface HostAccessAdapter {
  read(signal: AbortSignal): Promise<unknown>;
  /** A trusted Host policy notification invalidates the display before refetch. */
  subscribe?(invalidate: () => void): () => void;
}
export function accessLabel(metadata: HostAccessMetadata | undefined, now = Date.now()): string {
  if (!metadata || metadata.expiresAt <= now) return '共有設定はHostで確認';
  return {
    'owner-only': '非公開 · あなたのみ',
    public: '公開',
    link: 'リンクを知っている人',
    restricted: 'Hostが指定した範囲',
  }[metadata.scope];
}
export class HostAccessDisplay {
  private value?: HostAccessMetadata;
  private request?: AbortController;
  private highestRevision = -1;
  private accepted?: Pick<HostAccessMetadata, 'scope' | 'source'>;
  constructor(
    private readonly adapter: HostAccessAdapter,
    private readonly now = Date.now,
  ) {}
  get metadata() {
    return this.value ? { ...this.value } : undefined;
  }
  get label() {
    return accessLabel(this.value, this.now());
  }
  invalidate() {
    this.request?.abort();
    this.request = undefined;
    this.value = undefined;
  }
  async refresh(): Promise<string> {
    this.invalidate();
    const request = new AbortController();
    this.request = request;
    try {
      const raw = await this.adapter.read(request.signal);
      if (this.request !== request || request.signal.aborted) return this.label;
      if (!raw || typeof raw !== 'object') return this.label;
      const v = raw as Record<string, unknown>;
      if (
        !['owner-only', 'public', 'link', 'restricted'].includes(String(v.scope)) ||
        !Number.isSafeInteger(v.revision) ||
        (v.revision as number) < 0 ||
        (v.revision as number) < this.highestRevision ||
        (v.revision === this.highestRevision &&
          this.accepted !== undefined &&
          (v.scope !== this.accepted.scope || v.source !== this.accepted.source)) ||
        typeof v.expiresAt !== 'number' ||
        !Number.isFinite(v.expiresAt) ||
        v.expiresAt <= this.now() ||
        typeof v.source !== 'string' ||
        !v.source.trim()
      )
        return this.label;
      this.value = {
        scope: v.scope as HostAccessMetadata['scope'],
        revision: v.revision as number,
        expiresAt: v.expiresAt,
        source: v.source,
      };
      this.highestRevision = this.value.revision;
      this.accepted = { scope: this.value.scope, source: this.value.source };
    } catch {
      /* Failed/unknown metadata stays neutral; never claim privacy. */
    }
    return this.label;
  }
}

/** Re-arm after the platform timer clamp; expiry must not depend on a new response. */
export function scheduleAccessExpiry(
  display: HostAccessDisplay,
  notify: (label: string) => void,
  now = Date.now,
): () => void {
  const expiry = display.metadata?.expiresAt;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (expiry === undefined) return;
    const remaining = expiry - now();
    if (remaining <= 0) notify(display.label);
    else timer = setTimeout(schedule, Math.min(2147483647, remaining));
  };
  schedule();
  return () => clearTimeout(timer);
}
