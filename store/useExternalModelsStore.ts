import { create } from 'zustand';
import { ExternalModel } from '../types/settings';
import { getAppMetadata, setAppMetadata, METADATA_KEYS } from '../services/db/metadataDb';

interface ExternalModelsState {
  models: ExternalModel[];
  activeModelId: string | null;
  isExternalModeActive: boolean;
  isLoading: boolean;
  init: () => Promise<void>;
  addModel: (model: ExternalModel) => Promise<void>;
  updateModel: (id: string, updates: Partial<ExternalModel>) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
  setActiveModel: (id: string) => Promise<void>;
  toggleExternalMode: () => Promise<void>;
}

export const useExternalModelsStore = create<ExternalModelsState>((set, get) => ({
  models: [],
  activeModelId: null,
  isExternalModeActive: false,
  isLoading: true,

  init: async () => {
    try {
      const models = await getAppMetadata<ExternalModel[]>(METADATA_KEYS.EXTERNAL_MODELS) || [];
      const isExternalModeActive = await getAppMetadata<boolean>(METADATA_KEYS.EXTERNAL_MODE_ACTIVE) || false;
      const activeId = await getAppMetadata<string>(METADATA_KEYS.ACTIVE_EXTERNAL_MODEL_ID);
      
      let activeModelId = null;
      if (activeId && models.some(m => m.id === activeId)) {
        activeModelId = activeId;
      } else if (models.length > 0) {
        activeModelId = models[0].id;
        await setAppMetadata(METADATA_KEYS.ACTIVE_EXTERNAL_MODEL_ID, activeModelId);
      }

      set({ models, isExternalModeActive, activeModelId, isLoading: false });
    } catch (error) {
      console.error('Failed to init external models store:', error);
      set({ isLoading: false });
    }
  },

  addModel: async (model) => {
    const { models, activeModelId } = get();
    const newModels = [...models, model];
    await setAppMetadata(METADATA_KEYS.EXTERNAL_MODELS, newModels);
    
    let newActiveId = activeModelId;
    if (!newActiveId) {
      newActiveId = model.id;
      await setAppMetadata(METADATA_KEYS.ACTIVE_EXTERNAL_MODEL_ID, newActiveId);
    }
    
    set({ models: newModels, activeModelId: newActiveId });
  },

  updateModel: async (id, updates) => {
    const { models } = get();
    const newModels = models.map(m => m.id === id ? { ...m, ...updates } : m);
    await setAppMetadata(METADATA_KEYS.EXTERNAL_MODELS, newModels);
    set({ models: newModels });
  },

  deleteModel: async (id) => {
    const { models, activeModelId } = get();
    const newModels = models.filter(m => m.id !== id);
    await setAppMetadata(METADATA_KEYS.EXTERNAL_MODELS, newModels);
    
    let newActiveId = activeModelId;
    if (activeModelId === id) {
      newActiveId = newModels.length > 0 ? newModels[0].id : null;
      await setAppMetadata(METADATA_KEYS.ACTIVE_EXTERNAL_MODEL_ID, newActiveId);
    }
    
    set({ models: newModels, activeModelId: newActiveId });
  },

  setActiveModel: async (id) => {
    await setAppMetadata(METADATA_KEYS.ACTIVE_EXTERNAL_MODEL_ID, id);
    set({ activeModelId: id });
  },

  toggleExternalMode: async () => {
    const { isExternalModeActive } = get();
    const newValue = !isExternalModeActive;
    await setAppMetadata(METADATA_KEYS.EXTERNAL_MODE_ACTIVE, newValue);
    set({ isExternalModeActive: newValue });
  }
}));

useExternalModelsStore.getState().init();
