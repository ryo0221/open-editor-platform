import type { Page } from '@playwright/test';

/** A local image file authored for import/export QA; no app state is injected. */
export async function prototypeImage(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 840;
    canvas.height = 300;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#e8effa';
    ctx.fillRect(0, 0, 840, 300);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(28, 24, 784, 252);
    ctx.fillStyle = '#203b66';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('作業を記録する', 58, 66);
    ctx.font = '18px sans-serif';
    for (const [i, label] of ['今日の作業', 'かかった時間', '気づいたこと'].entries()) {
      ctx.fillStyle = '#334155';
      ctx.fillText(label, 58, 108 + i * 53);
      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(200, 85 + i * 53, 330, 36);
    }
    ctx.fillStyle = '#2563eb';
    ctx.fillRect(580, 174, 174, 52);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('記録を保存', 616, 207);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(base64, 'base64');
}
