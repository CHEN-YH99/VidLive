import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#16201d',
        surface: '#f7f9f4',
        mint: '#1f8a70',
        coral: '#d85c42',
        sun: '#f0b43c',
      },
      boxShadow: {
        panel: '0 18px 50px rgba(22, 32, 29, 0.08)',
      },
    },
  },
  plugins: [],
};

export default config;
