<script setup lang="ts">
import { ref, onMounted, nextTick } from "vue";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// --- ÉTATS ---
const mapContainer = ref<HTMLElement | null>(null);
let map: maplibregl.Map;

const searchQuery = ref("");
const suggestions = ref<any[]>([]);
const selectedParcel = ref<any | null>(null);
const salesHistory = ref<any[]>([]);
const isLoading = ref(false);
const showHeatmap = ref(false);

const MAP_STYLE =
  "https://openmaptiles.geo.data.gouv.fr/styles/osm-bright/style.json";
const API_BASE = "http://localhost:8080/api";

// --- UTILS ---
const formatPrice = (val: number) =>
  new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(val);
const formatDate = (str: string) =>
  new Date(str).toLocaleDateString("fr-FR", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

// --- LOGIQUE HEATMAP ---
const toggleHeatmap = async () => {
  showHeatmap.value = !showHeatmap.value;
  if (showHeatmap.value && selectedParcel.value) {
    loadHeatmapData(selectedParcel.value.code_commune);
  }

  if (map.getLayer("dvf-heatmap")) {
    map.setLayoutProperty(
      "dvf-heatmap",
      "visibility",
      showHeatmap.value ? "visible" : "none"
    );
  }
};

const loadHeatmapData = async (codeInsee: string) => {
  const res = await fetch(`${API_BASE}/dvf/commune?code_insee=${codeInsee}`);
  const data = await res.json();

  // Correction TS : Utilisation de "as const" pour le type littéral
  const geojson = {
    type: "FeatureCollection" as const,
    features: data.results
      .filter((s: any) => s.surface_reelle_bati > 0)
      .map((sale: any) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [sale.lon, sale.lat] },
        properties: {
          price_m2: sale.valeur_fonciere / sale.surface_reelle_bati,
        },
      })),
  };

  const source = map.getSource("dvf-points") as maplibregl.GeoJSONSource;
  if (source) {
    source.setData(geojson);
  } else {
    map.addSource("dvf-points", { type: "geojson", data: geojson });
    map.addLayer({
      id: "dvf-heatmap",
      type: "heatmap",
      source: "dvf-points",
      paint: {
        "heatmap-weight": [
          "interpolate",
          ["linear"],
          ["get", "price_m2"],
          1000,
          0,
          10000,
          1,
        ],
        "heatmap-intensity": 1,
        "heatmap-color": [
          "interpolate",
          ["linear"],
          ["heatmap-density"],
          0,
          "rgba(0,0,255,0)",
          0.2,
          "royalblue",
          0.4,
          "cyan",
          0.6,
          "lime",
          0.8,
          "yellow",
          1,
          "red",
        ],
        "heatmap-radius": 15,
        "heatmap-opacity": 0.6,
      },
    });
  }
};

// --- RECHERCHE ET DATA ---
const handleSearch = async () => {
  if (searchQuery.value.length < 3) {
    suggestions.value = [];
    return;
  }
  const res = await fetch(
    `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(
      searchQuery.value
    )}&limit=5`
  );
  const data = await res.json();
  suggestions.value = data.features;
};

const selectLocation = (feat: any) => {
  const [lon, lat] = feat.geometry.coordinates;
  const codeInsee = feat.properties.citycode;
  map.flyTo({ center: [lon, lat], zoom: 17 });
  loadParcelles(codeInsee);
  if (showHeatmap.value) loadHeatmapData(codeInsee);
  searchQuery.value = feat.properties.label;
  suggestions.value = [];
};

const loadParcelles = async (codeInsee: string) => {
  isLoading.value = true;
  const res = await fetch(`${API_BASE}/cadastre?code_insee=${codeInsee}`);
  const data = await res.json();

  const source = map.getSource("parcelles") as maplibregl.GeoJSONSource;
  if (source) {
    source.setData(data);
  } else {
    map.addSource("parcelles", { type: "geojson", data });
    map.addLayer({
      id: "parcelles-layer",
      type: "fill",
      source: "parcelles",
      paint: {
        "fill-color": "#3b82f6",
        "fill-opacity": 0.1,
        "fill-outline-color": "#1e4ed8",
      },
    });
    map.addLayer({
      id: "parcelles-highlight",
      type: "line",
      source: "parcelles",
      paint: { "line-color": "#f59e0b", "line-width": 3 },
      filter: ["==", "id", ""],
    });
  }
  isLoading.value = false;
};

const fetchDVF = async (idParcelle: string) => {
  const res = await fetch(`${API_BASE}/dvf?id_parcelle=${idParcelle}`);
  const data = await res.json();
  salesHistory.value = data.results || [];
};

onMounted(async () => {
  await nextTick();
  if (!mapContainer.value) return;

  map = new maplibregl.Map({
    container: mapContainer.value,
    style: MAP_STYLE,
    center: [2.3522, 48.8566],
    zoom: 12,
  });

  map.on("click", (e) => {
    const features = map.queryRenderedFeatures(e.point, {
      layers: ["parcelles-layer"],
    });
    if (features.length > 0) {
      const p = features[0]!.properties;
      selectedParcel.value = { ...p };
      map.setFilter("parcelles-highlight", ["==", "id", p.id]);
      fetchDVF(p.id);
    } else {
      selectedParcel.value = null;
      map.setFilter("parcelles-highlight", ["==", "id", ""]);
    }
  });

  map.on(
    "mouseenter",
    "parcelles-layer",
    () => (map.getCanvas().style.cursor = "pointer")
  );
  map.on(
    "mouseleave",
    "parcelles-layer",
    () => (map.getCanvas().style.cursor = "")
  );
});
</script>

<template>
  <div
    class="h-screen w-screen bg-slate-50 flex flex-col overflow-hidden font-sans relative text-slate-900"
  >
    <div
      class="absolute top-6 left-1/2 -translate-x-1/2 z-50 w-full max-w-xl px-4 flex flex-col gap-3"
    >
      <div class="relative">
        <input
          v-model="searchQuery"
          @input="handleSearch"
          class="w-full h-14 pl-12 pr-4 rounded-2xl shadow-2xl border-none ring-1 ring-black/5 bg-white/90 backdrop-blur-xl focus:ring-2 focus:ring-blue-500 transition-all outline-none"
          placeholder="Rechercher une commune..."
        />
        <div class="absolute left-4 top-4 text-slate-400">
          <svg
            class="w-6 h-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        <div
          v-if="suggestions.length"
          class="absolute top-full mt-2 w-full bg-white rounded-2xl shadow-2xl border border-slate-100 overflow-hidden"
        >
          <button
            v-for="s in suggestions"
            :key="s.properties.id"
            @click="selectLocation(s)"
            class="w-full text-left px-5 py-3 hover:bg-blue-50 flex flex-col transition-colors border-b border-slate-50 last:border-none"
          >
            <span class="font-bold text-slate-700">{{
              s.properties.label
            }}</span>
            <span class="text-[10px] text-slate-400 uppercase tracking-wider">{{
              s.properties.context
            }}</span>
          </button>
        </div>
      </div>

      <div class="flex justify-center">
        <button
          @click="toggleHeatmap"
          :class="
            showHeatmap ? 'bg-orange-500 text-white' : 'bg-white text-slate-600'
          "
          class="flex items-center gap-2 px-6 py-2 rounded-full shadow-lg font-bold text-xs transition-all backdrop-blur-md bg-opacity-90 active:scale-95 border border-white/20"
        >
          <span>{{ showHeatmap ? "🔥" : "❄️" }}</span>
          {{ showHeatmap ? "Masquer la Heatmap" : "Afficher les prix au m²" }}
        </button>
      </div>
    </div>

    <div ref="mapContainer" class="flex-1"></div>

    <transition name="slide">
      <aside
        v-if="selectedParcel"
        class="absolute top-6 right-6 bottom-6 w-96 bg-white/95 backdrop-blur shadow-2xl rounded-[2.5rem] z-40 border border-white p-8 flex flex-col"
      >
        <button
          @click="selectedParcel = null"
          class="absolute top-6 right-6 p-2 hover:bg-slate-100 rounded-full transition"
        >
          ✕
        </button>

        <header class="mb-8">
          <span
            class="px-3 py-1 bg-blue-100 text-blue-700 text-[10px] font-black uppercase rounded-full tracking-widest"
            >Section {{ selectedParcel.section }}</span
          >
          <h2 class="text-3xl font-black text-slate-900 mt-2 tracking-tighter">
            {{ selectedParcel.id }}
          </h2>
          <p class="text-slate-400 text-sm font-medium uppercase mt-1">
            {{ selectedParcel.nom_com }}
          </p>
        </header>

        <div class="flex-1 overflow-y-auto space-y-6 pr-2">
          <div class="grid grid-cols-2 gap-4">
            <div class="bg-slate-50 p-4 rounded-3xl border border-slate-100">
              <span
                class="text-[9px] font-bold text-slate-400 uppercase block mb-1"
                >Surface</span
              >
              <p class="text-xl font-black text-slate-800">
                {{ selectedParcel.contenance }} m²
              </p>
            </div>
            <div
              class="bg-slate-50 p-4 rounded-3xl border border-slate-100 text-right"
            >
              <span
                class="text-[9px] font-bold text-slate-400 uppercase block mb-1"
                >Parcelle</span
              >
              <p class="text-xl font-black text-slate-800">
                n°{{ selectedParcel.numero }}
              </p>
            </div>
          </div>

          <div>
            <h3
              class="text-xs font-black text-slate-400 uppercase tracking-widest mb-4"
            >
              Historique DVF
            </h3>
            <div v-if="salesHistory.length" class="space-y-3">
              <div
                v-for="sale in salesHistory"
                :key="sale.id"
                class="p-4 bg-white border border-slate-100 rounded-2xl shadow-sm"
              >
                <div class="flex justify-between items-start mb-1">
                  <p class="text-lg font-black text-blue-600">
                    {{ formatPrice(sale.valeur_fonciere) }}
                  </p>
                  <span class="text-[10px] font-bold text-slate-300">{{
                    formatDate(sale.date_mutation)
                  }}</span>
                </div>
                <p class="text-[11px] text-slate-500 italic">
                  🏠 {{ sale.surface_reelle_bati }}m² bâtis |
                  {{ sale.nombre_pieces_principales }}p.
                </p>
              </div>
            </div>
            <div
              v-else
              class="text-center py-8 bg-slate-50 rounded-3xl border border-dashed border-slate-200"
            >
              <p class="text-xs text-slate-400">Aucune vente enregistrée</p>
            </div>
          </div>
        </div>
      </aside>
    </transition>
  </div>
</template>

<style>
.slide-enter-active,
.slide-leave-active {
  transition: all 0.6s cubic-bezier(0.16, 1, 0.3, 1);
}
.slide-enter-from,
.slide-leave-to {
  transform: translateX(110%);
  opacity: 0;
}
::-webkit-scrollbar {
  width: 4px;
}
::-webkit-scrollbar-thumb {
  background: #e2e8f0;
  border-radius: 10px;
}
</style>
