// Session token management for authentication

import { Page } from 'rebrowser-puppeteer';
import { delay } from './pageInteraction';

const AUTH_TOKEN_KEY =
  process.env.AUTH_TOKEN_KEY || 'placeholder_key';
const AUTH_API_URL =
  process.env.AUTH_API_URL || 'https://api.example-service.local/auth';
const TOKEN_TTL_MS = 80_000; // Token time-to-live

export interface SessionTokenWithMeta {
  token: string;
  generatedAt: number;
}

/**
 * Manages session authentication tokens
 */
export class SessionTokenGenerator {
  private page: Page;
  private currentToken: SessionTokenWithMeta | null = null;
  private isGenerating = false;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Check if current token is valid
   */
  public hasValidToken(): boolean {
    if (!this.currentToken) return false;
    const age = Date.now() - this.currentToken.generatedAt;
    return age < TOKEN_TTL_MS;
  }

  /**
   * Get token (cached or fresh)
   */
  public async getToken(forceNew: boolean = false): Promise<string> {
    if (!forceNew && this.hasValidToken() && this.currentToken) {
      return this.currentToken.token;
    }

    if (this.isGenerating) {
      while (this.isGenerating) {
        await delay(100);
      }
      if (this.currentToken) return this.currentToken.token;
    }

    return await this.generateToken();
  }

  /**
   * Generate new session token
   */
  private async generateToken(): Promise<string> {
    this.isGenerating = true;

    try {
      // Call authentication API
      const response = await this.page.evaluate(
        async (apiUrl: string, apiKey: string): Promise<string> => {
          const res = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': apiKey,
            },
            body: JSON.stringify({
              action: 'authenticate',
            }),
          });

          if (!res.ok) {
            throw new Error(`Auth failed: ${res.status}`);
          }

          const data = await res.json();
          return data.token;
        },
        AUTH_API_URL,
        AUTH_TOKEN_KEY,
      );

      if (!response || typeof response !== 'string') {
        throw new Error('Invalid token received');
      }

      this.currentToken = {
        token: response,
        generatedAt: Date.now(),
      };

      return response;
    } catch (error) {
      console.error('[Auth] Token generation failed:', error);
      throw error;
    } finally {
      this.isGenerating = false;
    }
  }

  /**
   * Refresh token if expired
   */
  public async ensureWarm(): Promise<void> {
    if (!this.hasValidToken() && !this.isGenerating) {
      await this.getToken(true);
    }
  }

  /**
   * Get token age
   */
  public getTokenAge(): number | null {
    if (!this.currentToken) return null;
    return Date.now() - this.currentToken.generatedAt;
  }

  /**
   * Get cached token without refresh
   */
  public getLastToken(): string | null {
    return this.currentToken?.token ?? null;
  }

  /**
   * Force regeneration
   */
  public async regenerate(): Promise<string> {
    return await this.getToken(true);
  }

  /**
   * Reset state
   */
  public reset(): void {
    this.currentToken = null;
    this.isGenerating = false;
  }
}
