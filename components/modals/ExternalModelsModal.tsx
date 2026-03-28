import React, { useState } from 'react';
import { Button } from '../ui/Button.tsx';
import { Input } from '../ui/Input.tsx';
import BaseModal from '../common/BaseModal.tsx';
import { ServerIcon, CheckIcon, PencilIcon, TrashIcon } from '../common/Icons.tsx';
import { useExternalModelsStore } from '../../store/useExternalModelsStore.ts';
import { useSettingsUI } from '../../store/ui/useSettingsUI.ts';
import { useTranslation } from '../../hooks/useTranslation.ts';
import { ExternalModel } from '../../types/settings.ts';

const ExternalModelsModal: React.FC = () => {
  const { t } = useTranslation();
  const { isExternalModelsModalOpen, closeExternalModelsModal } = useSettingsUI();
  const { models, activeModelId, addModel, updateModel, deleteModel, setActiveModel } = useExternalModelsStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [modelId, setModelId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');

  const handleEdit = (model: ExternalModel) => {
    setEditingId(model.id);
    setDisplayName(model.displayName);
    setModelId(model.modelId);
    setBaseUrl(model.baseUrl);
    setApiKey(model.apiKey);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setDisplayName('');
    setModelId('');
    setBaseUrl('');
    setApiKey('');
  };

  const handleSave = async () => {
    if (!displayName || !modelId || !baseUrl) return;

    if (editingId) {
      await updateModel(editingId, { displayName, modelId, baseUrl, apiKey });
    } else {
      await addModel({
        id: crypto.randomUUID(),
        displayName,
        modelId,
        baseUrl,
        apiKey,
      });
    }
    handleCancelEdit();
  };

  return (
    <BaseModal
      isOpen={isExternalModelsModalOpen}
      onClose={closeExternalModelsModal}
      title={t.externalModels}
      headerIcon={<ServerIcon className="w-5 h-5 text-brand-primary" />}
      maxWidth="max-w-2xl"
    >
      <div className="space-y-6">
        {/* Top Section (List) */}
        <div className="space-y-3 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
          {models.length === 0 ? (
            <div className="text-sm text-text-muted italic text-center py-4">
              No external models configured.
            </div>
          ) : (
            models.map(model => (
              <div 
                key={model.id} 
                className={`p-3 rounded-xl border flex items-center justify-between transition-colors backdrop-blur-sm ${
                  model.id === activeModelId 
                    ? 'border-brand-primary/30 bg-brand-primary/10 shadow-sm' 
                    : 'border-border-base bg-bg-panel/20 hover:bg-bg-hover shadow-sm'
                }`}
              >
                <div>
                  <div className="font-medium text-text-primary flex items-center gap-2">
                    {model.displayName}
                    {model.id === activeModelId && (
                      <span className="text-[10px] uppercase tracking-wider bg-brand-primary/20 text-brand-primary px-2 py-0.5 rounded-full border border-brand-primary/20">
                        Active
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-muted mt-1 truncate max-w-[200px] sm:max-w-xs">
                    {model.baseUrl}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {model.id !== activeModelId && (
                    <Button 
                      variant="ghost"
                      onClick={() => setActiveModel(model.id)}
                      className="p-1.5 text-text-secondary hover:text-brand-primary hover:bg-brand-primary/10 h-auto bg-bg-element"
                      title="Set Active"
                      icon={<CheckIcon className="w-4 h-4" />}
                    />
                  )}
                  <Button 
                    variant="ghost"
                    onClick={() => handleEdit(model)}
                    className="p-1.5 text-text-secondary hover:text-brand-accent hover:bg-brand-accent/10 h-auto bg-bg-element"
                    title={t.edit}
                    icon={<PencilIcon className="w-4 h-4" />}
                  />
                  <Button 
                    variant="ghost"
                    onClick={() => deleteModel(model.id)}
                    className="p-1.5 text-text-secondary hover:text-tint-red-text hover:bg-tint-red-bg/10 h-auto bg-bg-element"
                    title={t.delete}
                    icon={<TrashIcon className="w-4 h-4" />}
                  />
                </div>
              </div>
            ))
          )}
        </div>

        <div className="h-px bg-border-base" />

        {/* Bottom Section (Form) */}
        <div className="space-y-4 bg-bg-element/40 p-4 rounded-xl border border-border-base backdrop-blur-md shadow-sm">
          <h3 className="text-sm font-medium text-text-primary">
            {editingId ? t.editModel : t.addModel}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs text-text-secondary">{t.displayName}</label>
              <Input 
                type="text" 
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="e.g., Local LM Studio"
                className="bg-bg-element border-border-base focus:border-brand-primary focus:ring-ring-focus"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-text-secondary">{t.modelId}</label>
              <Input 
                type="text" 
                value={modelId}
                onChange={e => setModelId(e.target.value)}
                placeholder="e.g., llama-3-8b"
                className="bg-bg-element border-border-base focus:border-brand-primary focus:ring-ring-focus"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-text-secondary">{t.baseUrl}</label>
              <Input 
                type="text" 
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                placeholder="e.g., http://localhost:1234/v1"
                className="bg-bg-element border-border-base focus:border-brand-primary focus:ring-ring-focus"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-text-secondary">{t.apiKey} (Optional)</label>
              <Input 
                type="password" 
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="bg-bg-element border-border-base focus:border-brand-primary focus:ring-ring-focus"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            {editingId && (
              <Button 
                variant="ghost"
                onClick={handleCancelEdit}
                className="bg-bg-element hover:bg-bg-hover text-text-primary"
              >
                {t.cancelEdit}
              </Button>
            )}
            <Button 
              variant="secondary"
              onClick={handleSave}
              disabled={!displayName || !modelId || !baseUrl}
              className="bg-brand-primary/20 text-brand-primary border border-brand-primary/30 hover:bg-brand-primary/30 shadow-sm"
            >
              {t.save}
            </Button>
          </div>
        </div>
      </div>
    </BaseModal>
  );
};

export default ExternalModelsModal;
