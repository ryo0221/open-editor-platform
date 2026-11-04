import type { CreativeLayerProvider } from './generation';

/** A consuming Host chooses this endpoint. No provider key or Workflow engine lives here. */
export function createCreativeLayerHttpProvider(
  endpoint: string,
  fetcher: typeof fetch = fetch,
): CreativeLayerProvider {
  if (
    !endpoint ||
    (!endpoint.startsWith('/') && !/^https:\/\//.test(endpoint)) ||
    endpoint.startsWith('//') ||
    /[\\\s]/.test(endpoint)
  )
    throw Error('Hostの同一originパスまたはHTTPS endpointを指定してください。');
  return {
    async generate(request, signal) {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        signal,
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error(`生成Hostが結果を返せませんでした (${response.status})。`);
      }
      const limit = 6 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw Error('生成結果が大きすぎます。');
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error('生成結果が空です。');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          if (signal.aborted) throw Error('生成依頼を中止しました。');
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > limit) throw Error('生成結果が大きすぎます。');
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      const joined = new Uint8Array(length);
      let offset = 0;
      for (const c of chunks) {
        joined.set(c, offset);
        offset += c.length;
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
    },
  };
}
