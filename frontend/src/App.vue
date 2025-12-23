<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// --- ÉTATS ---
const mapContainer = ref<HTMLElement | null>(null);
let map: maplibregl.Map;

const searchQuery = ref('');
const suggestions = ref<any[]>([]);
const selectedParcel = ref<any | null>(null);
const salesHistory = ref<any[]>([]);
const isLoading = ref(false);

const MAP_STYLE = 'https://openmaptiles.geo.data.gouv.fr/styles/osm-bright/style.json';
const API_BASE = 'http://localhost:8080/api';

// --- FONCTIONS UTILS ---
const formatPrice = (val: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(val);
const formatDate = (str: string) => new Date(str).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });

// --- RECHERCHE ET AUTO-COMPLÉTION ---
const handleSearch = async () => {
  if (searchQuery.value.length < 3) { suggestions.value = []; return; }
  const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(searchQuery.value)}&limit=5`);
  const data = await res.json();
  suggestions.value = data.features;
};

// --- CHARGEMENT DONNÉES ---
const loadParcelles = async (codeInsee: string) => {
  isLoading.value = true;
  const res = await fetch(`${API_BASE}/cadastre?code_insee=${codeInsee}`);
  const data = await res.json();
  if (map.getSource('parcelles')) {
    (map.getSource('parcelles') as maplibregl.GeoJSONSource).setData(data);
  } else {
    map.addSource('parcelles', { type: 'geojson', data });
    map.addLayer({
      id: 'parcelles-layer',
      type: 'fill',
      source: 'parcelles',
      paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.3, 'fill-outline-color': '#1e4ed8' }
    });
    map.addLayer({
      id: 'parcelles-highlight',
      type: 'line',
      source: 'parcelles',
      paint: { 'line-color': '#f59e0b', 'line-width': 3 },
      filter: ['==', 'id', '']
    });
  }
  isLoading.value = false;
};

const fetchDVF = async (idParcelle: string) => {
  const res = await fetch(`${API_BASE}/dvf?id_parcelle=${idParcelle}`);
  const data = await res.json();
  salesHistory.value = data.results || [];
};

const selectLocation = (feat: any) => {
  const [lon, lat] = feat.geometry.coordinates;
  map.flyTo({ center: [lon, lat], zoom: 17 });
  loadParcelles(feat.properties.citycode);
  searchQuery.value = feat.properties.label;
  suggestions.value = [];
};

// --- INITIALISATION ---
onMounted(async () => {
  await nextTick();
  map = new maplibregl.Map({
    container: mapContainer.value!,
    style: MAP_STYLE,
    center: [2.3522, 48.8566],
    zoom: 12
  });

  map.on('click', (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: ['parcelles-layer'] });
    if (features.length > 0) {
      const p = features[0]!.properties;
      selectedParcel.value = { ...p };
      map.setFilter('parcelles-highlight', ['==', 'id', p.id]);
      fetchDVF(p.id); // On récupère l'historique des ventes
    } else {
      selectedParcel.value = null;
      map.setFilter('parcelles-highlight', ['==', 'id', '']);
    }
  });

  map.on('mousemove', 'parcelles-layer', () => map.getCanvas().style.cursor = 'pointer');
  map.on('mouseleave', 'parcelles-layer', () => map.getCanvas().style.cursor = '');
});
</script>

<template>
  <div class="h-screen w-screen bg-slate-50 flex flex-col overflow-hidden font-sans">
    
    <div class="absolute top-6 left-1/2 -translate-x-1/2 z-50 w-full max-w-xl px-4">
      <div class="relative group">
        <input 
          v-model="searchQuery" @input="handleSearch"
          class="w-full h-14 pl-12 pr-4 rounded-2xl shadow-2xl border-none ring-1 ring-black/5 bg-white/90 backdrop-blur-xl focus:ring-2 focus:ring-blue-500 transition-all outline-none"
          placeholder="Adresse, ville, code postal..."
        />
        <div class="absolute left-4 top-4 text-slate-400">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        </div>
        
        <div v-if="suggestions.length" class="absolute top-full mt-2 w-full bg-white rounded-2xl shadow-2xl border border-slate-100 overflow-hidden">
          <button v-for="s in suggestions" :key="s.properties.id" @click="selectLocation(s)"
            class="w-full text-left px-5 py-3 hover:bg-blue-50 flex flex-col border-b border-slate-50 last:border-none transition-colors">
            <span class="font-bold text-slate-700">{{ s.properties.label }}</span>
            <span class="text-[10px] text-slate-400 uppercase tracking-wider">{{ s.properties.context }}</span>
          </button>
        </div>
      </div>
    </div>

    <div ref="mapContainer" class="flex-1"></div>

    <transition name="slide">
      <aside v-if="selectedParcel" class="absolute top-6 right-6 bottom-6 w-96 bg-white/95 backdrop-blur shadow-2xl rounded-[2.5rem] z-40 border border-white p-8 flex flex-col overflow-hidden">
        <button @click="selectedParcel = null" class="absolute top-6 right-6 p-2 hover:bg-slate-100 rounded-full transition">✕</button>

        <header class="mb-8">
          <span class="px-3 py-1 bg-blue-100 text-blue-700 text-[10px] font-black uppercase rounded-full tracking-widest">Parcelle {{ selectedParcel.section }}</span>
          <h2 class="text-3xl font-black text-slate-900 mt-2 tracking-tighter">{{ selectedParcel.id }}</h2>
          <p class="text-slate-400 text-sm font-medium uppercase mt-1">{{ selectedParcel.nom_com }}</p>
        </header>

        <div class="flex-1 overflow-y-auto pr-2 space-y-6">
          <div class="grid grid-cols-2 gap-4">
            <div class="bg-slate-50 p-4 rounded-3xl border border-slate-100">
              <span class="text-[9px] font-bold text-slate-400 uppercase block mb-1">Surface</span>
              <p class="text-xl font-black text-slate-800">{{ selectedParcel.contenance }} <span class="text-xs font-normal">m²</span></p>
            </div>
            <div class="bg-slate-50 p-4 rounded-3xl border border-slate-100 text-right">
              <span class="text-[9px] font-bold text-slate-400 uppercase block mb-1">Numéro</span>
              <p class="text-xl font-black text-slate-800">{{ selectedParcel.numero }}</p>
            </div>
          </div>

          <div>
            <h3 class="text-xs font-black text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
              <span class="w-1 h-1 bg-blue-500 rounded-full"></span> Ventes récentes (DVF)
            </h3>
            
            <div v-if="salesHistory.length" class="space-y-3">
              <div v-for="sale in salesHistory" :key="sale.id" class="p-4 bg-white border border-slate-100 rounded-2xl shadow-sm hover:shadow-md transition-shadow">
                <div class="flex justify-between items-start mb-2">
                  <p class="text-lg font-black text-blue-600">{{ formatPrice(sale.valeur_fonciere) }}</p>
                  <span class="text-[10px] font-bold text-slate-300">{{ formatDate(sale.date_mutation) }}</span>
                </div>
                <div class="flex gap-4">
                  <div class="text-[11px] text-slate-500 flex items-center gap-1">🏠 <b>{{ sale.surface_reelle_bati }}m²</b> bâtis</div>
                  <div class="text-[11px] text-slate-500 flex items-center gap-1">🌳 <b>{{ sale.surface_terrain }}m²</b> terrain</div>
                </div>
              </div>
            </div>
            <div v-else class="text-center py-10 bg-slate-50 rounded-3xl border border-dashed border-slate-200">
              <p class="text-xs text-slate-400 italic">Aucune transaction trouvée</p>
            </div>
          </div>
        </div>

        <button class="mt-8 w-full bg-slate-900 text-white py-4 rounded-2xl font-bold shadow-xl hover:bg-blue-600 transition-all active:scale-95">
          Télécharger la fiche PDF
        </button>
      </aside>
    </transition>
  </div>
</template>

<style>
.slide-enter-active, .slide-leave-active { transition: all 0.6s cubic-bezier(0.16, 1, 0.3, 1); }
.slide-enter-from, .slide-leave-to { transform: translateX(110%); opacity: 0; }
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
</style>