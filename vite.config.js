import { defineConfig } from 'vite';
// GitHub Pages serves the site from /<repo>/; override with BASE_PATH when needed.
export default defineConfig({ base: process.env.BASE_PATH ?? './' });
