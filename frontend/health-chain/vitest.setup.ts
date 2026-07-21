import { beforeAll, afterEach, afterAll, expect } from 'vitest';
import { configureAxe, toHaveNoViolations } from 'jest-axe';

// Extend vitest expect with axe matcher
expect.extend(toHaveNoViolations);

export const axe = configureAxe({
  rules: {
    // Enforce WCAG 2.1 AA
    'color-contrast': { enabled: true },
    'label': { enabled: true },
    'button-name': { enabled: true },
    'image-alt': { enabled: true },
    'landmark-one-main': { enabled: true },
    'region': { enabled: true },
  },
});

// Setup global test environment
beforeAll(() => {
  const sessionStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: (key: string) => store[key] || null,
      setItem: (key: string, value: string) => { store[key] = value.toString(); },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { store = {}; },
    };
  })();

  Object.defineProperty(window, 'sessionStorage', { value: sessionStorageMock });
});

afterEach(() => { window.sessionStorage.clear(); });
afterAll(() => {});
