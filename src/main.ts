import { mount } from 'svelte';
import '@fontsource-variable/inter';
import './app.css';
import App from './App.svelte';
import { prepareBrowser } from './lib/browser';

async function start() {
  await prepareBrowser();
  mount(App, { target: document.getElementById('app')! });
}
void start();
