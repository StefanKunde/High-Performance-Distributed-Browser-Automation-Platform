import { Page } from 'rebrowser-puppeteer';

export async function selectMatOptionByText(
  p: Page,
  selectDataTest: string,
  optionText: string,
  timeoutMs = 8000,
) {
  const selectSelector = `mat-select[data-test="${selectDataTest}"]`;
  await p.waitForSelector(selectSelector, { timeout: timeoutMs });
  await p.click(selectSelector);

  await p.waitForSelector('.cdk-overlay-container .mat-select-panel', {
    timeout: timeoutMs,
  });

  const clicked = await p.evaluate((label: string) => {
    function norm(s: string) {
      return s.trim().toLowerCase();
    }
    const wanted = norm(label);
    const panel = document.querySelector(
      '.cdk-overlay-container .mat-select-panel',
    );
    if (!panel) return false;
    const opts = Array.from(panel.querySelectorAll('mat-option, .mat-option'));
    for (const el of opts) {
      const txt = norm((el.textContent || '').replace(/\s+/g, ' '));
      if (txt.includes(wanted)) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, optionText);

  if (!clicked) {
    throw new Error(`selectMatOptionByText: option "${optionText}" not found`);
  }

  await p.waitForFunction(
    (sel) => {
      const s = document.querySelector(sel) as HTMLElement | null;
      return !!s && s.getAttribute('aria-expanded') === 'false';
    },
    { timeout: timeoutMs },
    selectSelector,
  );
}

export async function clickRandomItemFromFirstN(
  p: Page,
  n: number,
  timeoutMs = 8000,
): Promise<boolean> {
  await p.waitForSelector(
    '.cdk-virtual-scroll-content-wrapper .item-card.selectable',
    { timeout: timeoutMs },
  );

  return await p.evaluate((maxFirst: number) => {
    const all = Array.from(
      document.querySelectorAll(
        '.cdk-virtual-scroll-content-wrapper .item-card.selectable',
      ),
    ) as HTMLElement[];
    if (all.length === 0) return false;
    const upper = Math.min(maxFirst, all.length);
    const idx = Math.floor(Math.random() * upper);
    const el = all[idx];
    el.click();
    return true;
  }, n);
}
