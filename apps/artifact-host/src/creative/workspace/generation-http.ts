import { assertCreativeWorldDispatch, type CreativeWorldProvider } from './generation-execution';

/** Explicit endpoint contract. The safe probe precedes any World body; no bare-v1 fallback. */
export function createCreativeWorldHttpProvider(
  endpoint: string,
  fetcher: typeof fetch = fetch,
): CreativeWorldProvider {
  if (
    !endpoint ||
    endpoint.startsWith('//') ||
    endpoint.includes('#') ||
    /[\\\s]/.test(endpoint) ||
    (!endpoint.startsWith('/') && !/^https:\/\//.test(endpoint))
  )
    throw Error('Hostの同一originパスまたはHTTPS endpointを指定してください。');
  if (endpoint.startsWith('https:')) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.hash)
      throw Error('認証情報・fragment入りendpointは使えません。');
  }
  return Object.freeze({
    capability: 'creative-world-v1' as const,
    label: 'World対応HTTP Host',
    async generate(dispatch, signal) {
      assertCreativeWorldDispatch(dispatch);
      const probe = await fetcher(endpoint, {
        method: 'OPTIONS',
        credentials: 'same-origin',
        redirect: 'error',
        signal,
        headers: { 'X-Creative-World-Contract': '1' },
      });
      await probe.body?.cancel();
      assertCreativeWorldDispatch(dispatch);
      if (!probe.ok || probe.headers.get('X-Creative-World-Contract') !== '1')
        throw Error(
          '接続先はWorld入力・冪等operation ID契約に対応していません。本文は送信しません。',
        );
      await dispatch.preflight();
      assertCreativeWorldDispatch(dispatch);
      const identity = dispatch.identity,
        body = dispatch.serialize();
      const response = await fetcher(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Creative-World-Contract': '1',
          'Idempotency-Key': identity.operationId,
          'X-Creative-Payload-Hash': identity.payloadHash,
        },
        body,
      });
      assertCreativeWorldDispatch(dispatch);
      if (!response.ok || response.headers.get('X-Creative-World-Contract') !== '1') {
        await response.body?.cancel();
        throw Error(`World Hostの応答契約・状態が不正です (${response.status})。`);
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
          assertCreativeWorldDispatch(dispatch);
          const { value, done } = await reader.read();
          assertCreativeWorldDispatch(dispatch);
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
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    },
  } satisfies CreativeWorldProvider);
}
