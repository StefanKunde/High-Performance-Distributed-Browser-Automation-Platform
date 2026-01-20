// Page interaction utilities for browser automation

import { Page } from 'rebrowser-puppeteer';

/**
 * Async delay utility
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Move mouse to specific coordinates
 */
export async function moveMouse(
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  await page.mouse.move(x, y);
}

/**
 * Scroll viewport by delta
 */
export async function scrollPage(
  page: Page,
  deltaY: number,
): Promise<void> {
  await page.mouse.wheel({ deltaY });
}

/**
 * Click at coordinates
 */
export async function clickAt(
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  await page.mouse.click(x, y);
}

/**
 * Type text into active element
 */
export async function typeText(
  page: Page,
  text: string,
): Promise<void> {
  await page.keyboard.type(text);
}
