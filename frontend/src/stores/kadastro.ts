import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const API_BASE = import.meta.env.PROD ? '' : 'http://localhost:8080';

// --- TYPES EXISTANTS (ITEMS/EVENTS) ---
export interface SubTask {
  ID: number;
  item_id: number;
  content: string;
  is_done: boolean;
}

export interface Item {
  ID: number;
  title: string;
  description?: string;
  type: 'EVENT' | 'ENVIE' | 'RESOLUTION' | 'OBLIGATION';
  status: 'TODO' | 'DOING' | 'DONE';
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  date?: string;        
  sub_tasks: SubTask[];
}

// --- NOUVEAUX TYPES (EPICS/PROJETS) ---
export interface EpicTask {
  ID: number;
  epic_id: number;
  title: string;
  is_done: boolean;
}

export interface Epic {
  ID: number;
  title: string;
  description?: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  start_date: string; // ISO String
  end_date: string;   // ISO String
  tasks: EpicTask[];
}

export const useKlaroStore = defineStore('klaro', () => {
  // STATES
  const items = ref<Item[]>([])
  const epics = ref<Epic[]>([])
  const loading = ref(false)

  // ===========================================================================
  // GETTERS (COMPUTED)
  // ===========================================================================

  // --- ITEMS (Legacy/Event) ---
  const calendarItems = computed(() => items.value.filter((i): i is Item & { date: string } => !!i.date))
  const backlogItems = computed(() => items.value.filter(i => !i.date && i.status !== 'DONE'))
  
  const calendarAttributes = computed(() => {
    return calendarItems.value.map(item => {
      let color = 'gray';
      switch(item.type) {
        case 'EVENT': color = 'blue'; break;
        case 'OBLIGATION': color = 'red'; break;
        case 'RESOLUTION': color = 'purple'; break;
        case 'ENVIE': color = 'yellow'; break;
      }
      return {
        key: `item-${item.ID}`,
        dot: true,
        dates: new Date(item.date),
        customData: item,
        popover: { label: item.title },
        highlight: { color: color, fillMode: 'light' }
      }
    })
  })

  // --- EPICS (Nouveau) ---
  // Transforme les épopées en objets riches pour l'affichage (Barres de temps)
  const epicRanges = computed(() => {
    return epics.value.map(epic => {
      const total = epic.tasks?.length || 0;
      const done = epic.tasks?.filter(t => t.is_done).length || 0;
      const progress = total > 0 ? Math.round((done / total) * 100) : 0;

      return {
        ...epic,
        progress,
        // Helper pour savoir si l'épopée est "en retard" (date fin passée et pas 100%)
        isOverdue: new Date(epic.end_date) < new Date() && progress < 100,
        startDateObj: new Date(epic.start_date),
        endDateObj: new Date(epic.end_date)
      }
    }).sort((a, b) => a.startDateObj.getTime() - b.startDateObj.getTime());
  });

  // Focus du jour mélangé (Items importants + Epics en cours)
  const focusItems = computed(() => {
    const today = new Date().toISOString().split('T')[0];
    
    // 1. Items du jour ou haute priorité
    const criticalItems = items.value.filter(i => 
      (i.priority === 'HIGH' && i.status !== 'TODO') || 
      (i.date && i.date.startsWith(today!))
    );

    return criticalItems.slice(0, 5);
  });

  const completionRate = computed(() => {
    if (items.value.length === 0) return 0;
    const done = items.value.filter(i => i.status === 'DONE').length;
    return Math.round((done / items.value.length) * 100);
  });

  // ===========================================================================
  // ACTIONS
  // ===========================================================================

  async function fetchAll() {
    loading.value = true;
    try {
        await Promise.all([fetchItems(), fetchEpics()]);
    } finally {
        loading.value = false;
    }
  }

  // --- ITEMS ACTIONS ---
  async function fetchItems() {
    try {
      const res = await fetch(`${API_BASE}/api/items`);
      if (res.ok) items.value = await res.json();
    } catch (e) { console.error(e); }
  }

  async function createItem(newItem: Partial<Item>) {
    try {
      const res = await fetch(`${API_BASE}/api/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newItem, priority: newItem.priority || 'MEDIUM' })
      });
      const created = await res.json();
      items.value.push(created);
    } catch (e) { console.error("Erreur création item", e); }
  }

  async function updateItem(item: Item) {
    const idx = items.value.findIndex(i => i.ID === item.ID);
    if (idx !== -1) items.value[idx] = item;
    // TODO: Connecter le PUT backend quand implémenté
  }

  async function toggleSubTask(itemId: number, taskId: number) {
    // Optimistic
    const item = items.value.find(i => i.ID === itemId);
    if (item) {
        const task = item.sub_tasks.find(t => t.ID === taskId);
        if (task) task.is_done = !task.is_done;
    }
    // API
    try {
      await fetch(`${API_BASE}/api/subtasks/${taskId}/toggle`, { method: 'PATCH' });
    } catch (e) { console.error(e); }
  }

  // --- EPICS ACTIONS (Nouveau) ---

  async function fetchEpics() {
    try {
      const res = await fetch(`${API_BASE}/api/epics`);
      if (res.ok) epics.value = await res.json();
    } catch (e) { console.error(e); }
  }

  async function createEpic(epic: Partial<Epic>) {
    try {
      const res = await fetch(`${API_BASE}/api/epics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(epic)
      });
      const created = await res.json();
      // On s'assure que le tableau tasks existe
      created.tasks = []; 
      epics.value.push(created);
      return created;
    } catch (e) { console.error("Erreur création epic", e); }
  }

  async function addEpicTask(epicId: number, title: string) {
    try {
      const res = await fetch(`${API_BASE}/api/epics/${epicId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      });
      const newTask = await res.json();
      
      // Update local
      const epic = epics.value.find(e => e.ID === epicId);
      if (epic) epic.tasks.push(newTask);
      
      return newTask;
    } catch (e) { console.error("Erreur ajout task epic", e); }
  }

  async function toggleEpicTask(taskId: number) {
    // Optimistic Update (Recherche imbriquée)
    let found = false;
    for (const epic of epics.value) {
        const task = epic.tasks?.find(t => t.ID === taskId);
        if (task) {
            task.is_done = !task.is_done;
            found = true;
            break;
        }
    }
    
    if (found) {
        try {
            await fetch(`${API_BASE}/api/tasks/${taskId}/toggle`, { method: 'PATCH' });
        } catch(e) { console.error(e); }
    }
  }

  return { 
    // State
    items, 
    epics,
    loading, 
    
    // Getters
    calendarItems, 
    backlogItems, 
    focusItems, 
    completionRate,
    calendarAttributes,
    epicRanges, // <-- Le nouveau getter puissant pour le calendrier
    
    // Actions
    fetchAll,
    fetchItems, 
    createItem, 
    updateItem,
    toggleSubTask,
    // Actions Epics
    fetchEpics,
    createEpic,
    addEpicTask,
    toggleEpicTask
  }
});