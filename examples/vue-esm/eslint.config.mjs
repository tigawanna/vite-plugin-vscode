import { defineConfig } from '@tomjs/eslint-config';

export default defineConfig({
  rules: {
    'no-console': 'off',
    'n/prefer-global/process': 'off',
  },
});
