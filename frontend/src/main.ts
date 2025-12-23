import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css' // Ton CSS Tailwind v4

// Import de V-Calendar et son CSS
import VCalendar from 'v-calendar';
import 'v-calendar/style.css';

const app = createApp(App)

// 1. Activation du Store (Pinia)
app.use(createPinia())

// 2. Activation du Calendrier (Setup global)
app.use(VCalendar, {
  componentPrefix: 'vc', // On utilisera <vc-calendar /> dans les templates
});

app.mount('#app')