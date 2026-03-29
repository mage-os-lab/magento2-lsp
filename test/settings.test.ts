import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { updateSettings, getSettings, getEffectiveHintMode, getEffectiveCompletionMatcher, setClientName } from '../src/settings';

describe('settings', () => {
  // Reset settings and client name before each test to avoid cross-contamination.
  beforeEach(() => {
    updateSettings({});
    setClientName(undefined);
  });

  describe('updateSettings', () => {
    it('parses templateDir from initializationOptions', () => {
      updateSettings({ templateDir: '/custom/templates' });
      expect(getSettings().templateDir).toBe('/custom/templates');
    });

    it('ignores non-string templateDir', () => {
      updateSettings({ templateDir: 42 });
      expect(getSettings().templateDir).toBeUndefined();
    });

    it('parses hintMode "codeLens"', () => {
      updateSettings({ hintMode: 'codeLens' });
      expect(getSettings().hintMode).toBe('codeLens');
    });

    it('parses hintMode "inlayHint"', () => {
      updateSettings({ hintMode: 'inlayHint' });
      expect(getSettings().hintMode).toBe('inlayHint');
    });

    it('ignores invalid hintMode values', () => {
      updateSettings({ hintMode: 'somethingElse' });
      expect(getSettings().hintMode).toBeUndefined();
    });

    it('ignores non-string hintMode', () => {
      updateSettings({ hintMode: true });
      expect(getSettings().hintMode).toBeUndefined();
    });

    it('parses completionMatcher "segment"', () => {
      updateSettings({ completionMatcher: 'segment' });
      expect(getSettings().completionMatcher).toBe('segment');
    });

    it('parses completionMatcher "fuzzy"', () => {
      updateSettings({ completionMatcher: 'fuzzy' });
      expect(getSettings().completionMatcher).toBe('fuzzy');
    });

    it('ignores invalid completionMatcher values', () => {
      updateSettings({ completionMatcher: 'somethingElse' });
      expect(getSettings().completionMatcher).toBeUndefined();
    });

    it('ignores non-string completionMatcher', () => {
      updateSettings({ completionMatcher: 42 });
      expect(getSettings().completionMatcher).toBeUndefined();
    });

    it('ignores non-object settings', () => {
      updateSettings('not-an-object');
      // Should not throw; settings remain empty.
      expect(getSettings().hintMode).toBeUndefined();
    });
  });

  describe('getEffectiveHintMode', () => {
    // Save and restore the env var to avoid leaking state between tests.
    const ENV_KEY = 'MAGENTO_LSP_HINT_MODE';
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
      updateSettings({});
      setClientName(undefined);
    });

    afterEach(() => {
      if (savedEnv !== undefined) {
        process.env[ENV_KEY] = savedEnv;
      } else {
        delete process.env[ENV_KEY];
      }
    });

    it('defaults to "codeLens" for unknown editors', () => {
      expect(getEffectiveHintMode()).toBe('codeLens');
    });

    it('defaults to "codeLens" for Neovim', () => {
      setClientName('Neovim');
      expect(getEffectiveHintMode()).toBe('codeLens');
    });

    it('defaults to "inlayHint" for Zed', () => {
      setClientName('Zed');
      expect(getEffectiveHintMode()).toBe('inlayHint');
    });

    it('defaults to "inlayHint" for Zed (case-insensitive)', () => {
      setClientName('zed');
      expect(getEffectiveHintMode()).toBe('inlayHint');
    });

    it('uses initializationOptions.hintMode when set', () => {
      updateSettings({ hintMode: 'inlayHint' });
      expect(getEffectiveHintMode()).toBe('inlayHint');
    });

    it('initializationOptions overrides Zed default', () => {
      setClientName('Zed');
      updateSettings({ hintMode: 'codeLens' });
      expect(getEffectiveHintMode()).toBe('codeLens');
    });

    it('falls back to MAGENTO_LSP_HINT_MODE env var', () => {
      process.env[ENV_KEY] = 'inlayHint';
      expect(getEffectiveHintMode()).toBe('inlayHint');
    });

    it('initializationOptions takes priority over env var', () => {
      updateSettings({ hintMode: 'codeLens' });
      process.env[ENV_KEY] = 'inlayHint';
      expect(getEffectiveHintMode()).toBe('codeLens');
    });

    it('env var overrides Zed default', () => {
      setClientName('Zed');
      process.env[ENV_KEY] = 'codeLens';
      expect(getEffectiveHintMode()).toBe('codeLens');
    });

    it('ignores invalid env var values', () => {
      process.env[ENV_KEY] = 'invalid';
      expect(getEffectiveHintMode()).toBe('codeLens');
    });
  });

  describe('getEffectiveCompletionMatcher', () => {
    const ENV_KEY = 'MAGENTO_LSP_COMPLETION_MATCHER';
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
      updateSettings({});
    });

    afterEach(() => {
      if (savedEnv !== undefined) {
        process.env[ENV_KEY] = savedEnv;
      } else {
        delete process.env[ENV_KEY];
      }
    });

    it('defaults to "fuzzy"', () => {
      expect(getEffectiveCompletionMatcher()).toBe('fuzzy');
    });

    it('uses initializationOptions.completionMatcher when set', () => {
      updateSettings({ completionMatcher: 'segment' });
      expect(getEffectiveCompletionMatcher()).toBe('segment');
    });

    it('falls back to MAGENTO_LSP_COMPLETION_MATCHER env var', () => {
      process.env[ENV_KEY] = 'segment';
      expect(getEffectiveCompletionMatcher()).toBe('segment');
    });

    it('initializationOptions takes priority over env var', () => {
      updateSettings({ completionMatcher: 'segment' });
      process.env[ENV_KEY] = 'fuzzy';
      expect(getEffectiveCompletionMatcher()).toBe('segment');
    });

    it('ignores invalid env var values', () => {
      process.env[ENV_KEY] = 'invalid';
      expect(getEffectiveCompletionMatcher()).toBe('fuzzy');
    });
  });
});
