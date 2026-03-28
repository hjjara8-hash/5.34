
import { Content, GenerateContentResponse, Part, SafetySetting as GeminiSafetySettingFromSDK, GenerationConfig as GeminiGenerationConfigSDK } from "@google/genai";
import { ChatSession, ChatMessage, ChatMessageRole, GeminiSettings, GroundingChunk, UserMessageInput, LogApiRequestCallback, FullResponseData, AICharacter, LoggedGeminiGenerationConfig, ApiRequestPayload, ToolInvocation } from '../../types.ts';
import { createAiInstance } from './config.ts';
import { mapMessagesToGeminiHistoryInternal, mapMessagesToCharacterPerspectiveHistory } from './history.ts';
import { formatGeminiError } from './utils.ts';
import { getMemoryToolDefinition, sanitizeToolName } from '../tools/memoryTool.ts';
import { pythonToolDefinition } from '../tools/pythonTool.ts';
import * as memoryService from '../memoryService.ts';
import { useMemoryStore } from '../../store/useMemoryStore.ts';
import { useDataStore } from '../../store/useDataStore.ts'; 
import { usePythonStore } from '../../store/usePythonStore.ts';
import { MODELS_SENDING_THINKING_CONFIG_API, MODELS_SENDING_THINKING_LEVEL_API, MEMORY_STRATEGIES } from "../../constants.ts";
import { formatChaptersToMarkdown } from "../archiverService.ts";
import { generateEnhancedThinkingResponse } from './enhancedThinkingService.ts';
import { generateAutoRefineResponse } from './autoRefineService.ts';
import { useExternalModelsStore } from '../../store/useExternalModelsStore.ts';
import { generateExternalResponse } from './externalProvider.ts';
import { extractLorebookContext } from '../lorebookService.ts';

import { generateChatFingerprint } from '../utils.ts';

export interface GeminiRequestOptions {
  apiKey: string;
  sessionId: string;
  userMessageInput: UserMessageInput;
  model: string;
  baseSettings: GeminiSettings;
  currentChatMessages: ChatMessage[];
  onFullResponse: (data: FullResponseData) => Promise<void> | void;
  onError: (error: string, isAbortError?: boolean) => Promise<void> | void;
  onComplete: () => void;
  onStreamUpdate?: (text: string) => void; 
  logApiRequestCallback: LogApiRequestCallback;
  signal?: AbortSignal;
  settingsOverride?: Partial<GeminiSettings & { _characterIdForAPICall?: string }>;
  allAiCharactersInSession?: AICharacter[];
  thoughtInjectionContext?: string;
  generatingMessageId?: string; 
  sessionToUpdate?: ChatSession;
  onCacheUpdate?: (cacheInfo: { id: string; expireTime: number; fingerprint: string; }) => void;
  modelPrefillText?: string;
  isManualCacheCreationMode?: boolean;
  manualCacheMessageCount?: number;
}

// Helper to handle streaming vs regular generation
async function generateResponse(
    ai: any,
    model: string,
    contents: Content[],
    config: any,
    onStreamUpdate?: (text: string) => void
): Promise<GenerateContentResponse> {
    if (onStreamUpdate) {
        const resultStream = await ai.models.generateContentStream({
            model,
            contents,
            config,
        });

        let fullText = '';
        let fullThoughts = ''; 
        let lastChunk: GenerateContentResponse | null = null;
        const allFunctionCalls: any[] = []; 

        for await (const chunk of resultStream) {
            lastChunk = chunk;
            
            const parts = chunk.candidates?.[0]?.content?.parts || [];
            
            // Capture tool calls immediately from any chunk
            const functionCallParts = parts.filter((p: any) => p.functionCall);
            if (functionCallParts.length > 0) {
                allFunctionCalls.push(...functionCallParts);
            }

            let textChunkToAdd = '';

            for (const part of parts) {
                const p = part as any;
                if (p.thought) {
                    if (typeof p.thought === 'string') {
                        fullThoughts += p.thought;
                    } else if (p.thought === true && p.text) {
                        fullThoughts += p.text;
                    }
                } else if (p.text) {
                    textChunkToAdd += p.text;
                }
            }

            if (textChunkToAdd) {
                fullText += textChunkToAdd;
                onStreamUpdate(fullText);
            }
        }
        
        try {
            const finalResponse = await resultStream.response;
            if (finalResponse) return finalResponse;
        } catch (e) {
            // console.warn("Stream response promise failed or was undefined. Using fallback construction.", e);
        }

        const finalParts: any[] = [];
        if (fullThoughts) {
            finalParts.push({ text: fullThoughts, thought: true });
        }
        if (fullText) {
            finalParts.push({ text: fullText });
        }

        if (allFunctionCalls.length > 0) {
            finalParts.push(...allFunctionCalls);
        }

        if (finalParts.length === 0) {
            finalParts.push({ text: "" });
        }

        const syntheticResponse: any = {
            candidates: [{
                content: { role: 'model', parts: finalParts },
                finishReason: lastChunk?.candidates?.[0]?.finishReason || 'STOP',
                safetyRatings: lastChunk?.candidates?.[0]?.safetyRatings,
                citationMetadata: lastChunk?.candidates?.[0]?.citationMetadata,
                groundingMetadata: lastChunk?.candidates?.[0]?.groundingMetadata,
            }],
            usageMetadata: lastChunk?.usageMetadata,
            text: fullText 
        };

        if (allFunctionCalls.length > 0) {
            syntheticResponse.functionCalls = allFunctionCalls.map((p: any) => p.functionCall);
        }

        return syntheticResponse as GenerateContentResponse;

    } else {
        return await ai.models.generateContent({
            model,
            contents,
            config,
        });
    }
}



export async function getFullChatResponse(options: GeminiRequestOptions): Promise<void | { id: string; expireTime: number; fingerprint: string }> {
  const {
    apiKey,
    sessionId,
    userMessageInput,
    model,
    baseSettings,
    currentChatMessages,
    onFullResponse,
    onError,
    onComplete,
    onStreamUpdate,
    logApiRequestCallback,
    signal,
    settingsOverride,
    allAiCharactersInSession,
    thoughtInjectionContext,
    generatingMessageId,
    sessionToUpdate,
    onCacheUpdate,
    modelPrefillText,
    isManualCacheCreationMode,
    manualCacheMessageCount
  } = options;

  if (!apiKey) {
    await onError("API Key is not configured. Please add a key in Settings.", false);
    onComplete();
    return;
  }
  const ai = createAiInstance(apiKey);

  if (signal?.aborted) {
    await onError("Request aborted by user before sending.", true);
    onComplete();
    return;
  }

  let aggregatedResponseText = "";

  const handleStreamUpdate = (newTextFromCurrentTurn: string) => {
      if (onStreamUpdate) {
          onStreamUpdate(aggregatedResponseText + newTextFromCurrentTurn);
      }
  };

  const combinedSettings = { ...baseSettings, ...settingsOverride }; 
  const characterIdForAPICall = (settingsOverride as any)?._characterIdForAPICall;

  const externalStore = useExternalModelsStore.getState();
  const activeExternalModel = externalStore.models.find(m => m.id === externalStore.activeModelId);
  const isExternal = externalStore.isExternalModeActive && !!activeExternalModel;

  const characterForCall = characterIdForAPICall && allAiCharactersInSession
    ? allAiCharactersInSession.find(c => c.id === characterIdForAPICall)
    : undefined;
  
  const isCharacterTurn = !!characterForCall;
  const characterNameForLogging = characterForCall ? characterForCall.name : undefined;
  const characterIdForCacheKey = characterForCall ? characterForCall.id : undefined;


  const messageParts: Part[] = []; 
  let effectiveUserText = userMessageInput.text;

  const configForChatCreate: any = {};
  if(!configForChatCreate.tools) configForChatCreate.tools = [];
  
  if (!isExternal) {
    if (combinedSettings.useGoogleSearch) {
      if (!configForChatCreate.tools.some((tool: any) => 'googleSearch' in tool)) {
        configForChatCreate.tools.push({googleSearch: {}});
      }
    }

    const pythonMode = combinedSettings.pythonExecutionMode || 'disabled'; 
    
    if (pythonMode === 'cloud') {
        configForChatCreate.tools.push({ codeExecution: {} });
    } else if (pythonMode === 'local') {
        if (usePythonStore.getState().isEnabled) {
            configForChatCreate.tools.push({ functionDeclarations: [pythonToolDefinition] });
        }
    }
  }

  if (combinedSettings.urlContext && combinedSettings.urlContext.length > 0 && userMessageInput.text.trim()) {
    const urlContextString = `\n\nProvided URL Context:\n${combinedSettings.urlContext.map(url => `- ${url}`).join('\n')}`;
    effectiveUserText = `${effectiveUserText}${urlContextString}`;
  }
  
  let textPartAdded = false;
  if (effectiveUserText.trim()) {
    messageParts.push({ text: effectiveUserText });
    textPartAdded = true;
  }

  if (userMessageInput.attachments) {
    userMessageInput.attachments.forEach(att => {
        if (att.fileUri) {
          messageParts.push({ fileData: { mimeType: att.mimeType, fileUri: att.fileUri } });
        } else if (att.base64Data && !att.error) { 
          messageParts.push({ inlineData: { mimeType: att.mimeType, data: att.base64Data } });
        }
    });
  }
  
  if (!textPartAdded && messageParts.length > 0) {
    messageParts.unshift({ text: "" }); 
  }

  if (messageParts.length === 0) { 
      const hasValidAttachments = userMessageInput.attachments && userMessageInput.attachments.some(att => (att.fileUri && att.uploadState === 'completed_cloud_upload') || (att.base64Data && !att.error));
      if (!effectiveUserText.trim() && !hasValidAttachments && !isManualCacheCreationMode) {
          await onError("Cannot send an empty message with no valid attachments.", false);
          onComplete();
          return;
      }
      if(messageParts.length === 0) {
        messageParts.push({ text: "" });
      }
  }
  
  let effectiveSettingsForCacheKeyConstruction = { ...combinedSettings };
  if (characterIdForCacheKey && characterForCall) {
      effectiveSettingsForCacheKeyConstruction.systemInstruction = characterForCall.systemInstruction; 
      (effectiveSettingsForCacheKeyConstruction as any)._characterIdForCacheKey = characterIdForCacheKey;
      delete (effectiveSettingsForCacheKeyConstruction as any)._characterIdForAPICall;
  } else {
      delete (effectiveSettingsForCacheKeyConstruction as any)._characterIdForCacheKey;
      delete (effectiveSettingsForCacheKeyConstruction as any)._characterIdForAPICall;
  }
  const sortedSettingsForCacheKey = JSON.parse(JSON.stringify(effectiveSettingsForCacheKeyConstruction, Object.keys(effectiveSettingsForCacheKeyConstruction).sort()));

  const cacheKeyForSDKInstance = characterIdForCacheKey
      ? `${sessionId}_char_${characterIdForCacheKey}-${model}-${JSON.stringify(sortedSettingsForCacheKey)}`
      : `${sessionId}-${model}-${JSON.stringify(sortedSettingsForCacheKey)}`;

  let manualCacheInfo = options.sessionToUpdate?.manualCacheInfo;
  let isManualCacheValid = false;

  if (manualCacheInfo && manualCacheInfo.expireTime > Date.now() && options.sessionToUpdate) {
      const currentFingerprint = generateChatFingerprint(options.sessionToUpdate, manualCacheInfo.cachedMessageCount);
      if (currentFingerprint === manualCacheInfo.fingerprint) {
          isManualCacheValid = true;
      }
  }

  let messagesToProcess = currentChatMessages;
  if (isManualCacheCreationMode && manualCacheMessageCount !== undefined) {
      messagesToProcess = currentChatMessages.slice(0, manualCacheMessageCount);
  } else if (isManualCacheValid && manualCacheInfo) {
      configForChatCreate.cachedContent = manualCacheInfo.id;
      messagesToProcess = currentChatMessages.slice(manualCacheInfo.cachedMessageCount);
  }

  let historyForChatInitialization: any[];
  if (isCharacterTurn && characterForCall && allAiCharactersInSession) {
    historyForChatInitialization = mapMessagesToCharacterPerspectiveHistory(messagesToProcess, characterForCall.id, allAiCharactersInSession, combinedSettings);
  } else {
    historyForChatInitialization = mapMessagesToGeminiHistoryInternal(messagesToProcess, combinedSettings);
  }

  const fullContents: Content[] = [];
  
  historyForChatInitialization.forEach((entry) => {
      fullContents.push(entry as Content);
  });
  
  let finalSystemInstructionText: string | undefined = undefined;

  // 1. Persona (Character or System)
  if (characterForCall && characterForCall.systemInstruction) { 
      finalSystemInstructionText = characterForCall.systemInstruction;
  } else if (combinedSettings.systemInstruction) { 
      finalSystemInstructionText = combinedSettings.systemInstruction;
  }

  // 2. User Profile Injection (New Logic)
  // Replaces previous Anchor System. Injects profile directly into System Instruction.
  if ((combinedSettings.isMemoryBoxEnabled || combinedSettings.isMemoryReadOnly) && combinedSettings.memoryBoxContent) {
      const profileContent = `
=== USER PROFILE (READ ONLY CONTEXT) ===
The following JSON defines the user's permanent identity and preferences.
Use this data to inform your responses, but DO NOT attempt to modify it. You do not have write access.
<user_profile>
${combinedSettings.memoryBoxContent}
</user_profile>
`;
      finalSystemInstructionText = finalSystemInstructionText 
          ? `${finalSystemInstructionText}\n\n${profileContent}`
          : profileContent;
  }

  // 4. Story Manager Injection
  let storyContextForCache = "";
  let currentFingerprintForCache = "";
  let backupSystemInstruction: any;
  let backupTools: any;
  let backupToolConfig: any;

  const buildAndSetCache = async () => {
      try {
          const cachePayload: any = {
              model: model,
              config: {
                  contents: [{ role: 'user', parts: [{ text: storyContextForCache }] }],
                  ttl: '3600s'
              }
          };
          const sysInst = backupSystemInstruction || configForChatCreate.systemInstruction;
          if (sysInst) {
              cachePayload.config.systemInstruction = sysInst;
          }
          const tls = backupTools || configForChatCreate.tools;
          if (tls && tls.length > 0) {
              cachePayload.config.tools = tls;
          }
          const cache = await ai.caches.create(cachePayload);

          if (logApiRequestCallback) {
              logApiRequestCallback({
                  requestType: 'cachedContents.create',
                  payload: {
                      model,
                      toolsLength: tls?.length || 0,
                      instructionLength: sysInst?.parts?.[0]?.text?.length || finalSystemInstructionText?.length || 0,
                      textLength: storyContextForCache.length
                  } as any,
                  characterName: characterNameForLogging,
                  apiSessionId: cacheKeyForSDKInstance
              });
          }

          const expireTime = Date.now() + 3600 * 1000;
          if (options.onCacheUpdate) {
              options.onCacheUpdate({
                  id: cache.name,
                  expireTime,
                  fingerprint: currentFingerprintForCache
              });
          }

          configForChatCreate.cachedContent = cache.name;
          return true;
      } catch (error) {
          console.warn("Context Caching failed (likely < 32k tokens). Falling back to inline injection.", error);
          return false;
      }
  };

  if (combinedSettings.archivedChapters && combinedSettings.archivedChapters.length > 0) {
      storyContextForCache = formatChaptersToMarkdown(combinedSettings.archivedChapters);
      currentFingerprintForCache = `${model}${finalSystemInstructionText}${JSON.stringify(configForChatCreate.tools || [])}${storyContextForCache.length}`;

      if (isExternal || isManualCacheValid) {
          finalSystemInstructionText = finalSystemInstructionText 
              ? `${finalSystemInstructionText}\n\n${storyContextForCache}`
              : storyContextForCache;
      } else if (
          options.sessionToUpdate?.cacheInfo &&
          options.sessionToUpdate.cacheInfo.fingerprint === currentFingerprintForCache &&
          options.sessionToUpdate.cacheInfo.expireTime > Date.now() + 300000
      ) {
          configForChatCreate.cachedContent = options.sessionToUpdate.cacheInfo.id;
      } else {
          const success = await buildAndSetCache();
          if (!success) {
              finalSystemInstructionText = finalSystemInstructionText 
                  ? `${finalSystemInstructionText}\n\n${storyContextForCache}`
                  : storyContextForCache;
          }
      }
  }

  let activeMemoryToolName: string | undefined = undefined;

  if (!isExternal && combinedSettings.enableLongTermMemory) {
      const strategyKey = combinedSettings.memoryQueryStrategy || 'companion';
      
      const { customMemoryStrategies } = useDataStore.getState();
      let strategy = MEMORY_STRATEGIES[strategyKey];
      if (!strategy) {
          const custom = customMemoryStrategies.find(s => s.id === strategyKey);
          if (custom) {
              strategy = custom;
          } else {
              strategy = MEMORY_STRATEGIES['companion']; 
          }
      }
      
      const memoryMandate = strategy.systemMandate;
      finalSystemInstructionText = finalSystemInstructionText ? `${finalSystemInstructionText}\n\n${memoryMandate}` : memoryMandate;

      activeMemoryToolName = sanitizeToolName(strategy.label);

      const hasMemoryTool = configForChatCreate.tools.some((t: any) => t.functionDeclarations && t.functionDeclarations.some((f: any) => f.name === activeMemoryToolName));
      if (!hasMemoryTool) {
          configForChatCreate.tools.push({ functionDeclarations: [getMemoryToolDefinition(activeMemoryToolName, memoryMandate)] });
      }
  }

  if (finalSystemInstructionText) {
    configForChatCreate.systemInstruction = { role: "system", parts: [{text: finalSystemInstructionText }] };
  }

  if (combinedSettings.temperature !== undefined) configForChatCreate.temperature = combinedSettings.temperature;
  if (combinedSettings.topP !== undefined) configForChatCreate.topP = combinedSettings.topP;
  if (combinedSettings.topK !== undefined) configForChatCreate.topK = combinedSettings.topK;
  if (combinedSettings.safetySettings) {
    configForChatCreate.safetySettings = combinedSettings.safetySettings.map(s => ({
        category: s.category,
        threshold: s.threshold,
    })) as GeminiSafetySettingFromSDK[];
  }
  
  if (MODELS_SENDING_THINKING_LEVEL_API.includes(model)) {
     const level = combinedSettings.thinkingLevel ? combinedSettings.thinkingLevel.toUpperCase() : 'HIGH';
     configForChatCreate.thinkingConfig = { thinkingLevel: level };
  } else if (MODELS_SENDING_THINKING_CONFIG_API.includes(model) && combinedSettings.thinkingBudget !== undefined) {
    configForChatCreate.thinkingConfig = { thinkingBudget: combinedSettings.thinkingBudget };
  }

  if (combinedSettings.showThinkingProcess) {
      configForChatCreate.thinkingConfig = configForChatCreate.thinkingConfig || {};
      configForChatCreate.thinkingConfig.includeThoughts = true;
  }

  if (combinedSettings.seed !== undefined) {
      configForChatCreate.seed = combinedSettings.seed;
  }

  if (combinedSettings.isStrategyToolEnabled && !isManualCacheCreationMode) {
      const rawProtocol = combinedSettings.strategyContent || "No protocol defined.";
      const protocolContent = `[[SYSTEM ALERT: PRIORITY OVERRIDE]]\n${rawProtocol}`;
      const ackText = combinedSettings.strategyGhostResponse?.trim() || "OK I UNDERSTAND AND I WILL FOLLOW THEM STEP BY STEP";
      
      const protocolMessages: Content[] = [
          {
              role: 'user',
              parts: [{ text: protocolContent }]
          },
          {
              role: 'model',
              parts: [{ text: ackText }]
          }
      ];

      let insertIndex = fullContents.length;
      for (let i = fullContents.length - 1; i >= 0; i--) {
          if (fullContents[i].role === 'user') {
              insertIndex = i;
              break;
          }
      }
      fullContents.splice(insertIndex, 0, ...protocolMessages);
  }

  if (thoughtInjectionContext && !isManualCacheCreationMode) {
      const thoughtHandoffTemplate = `[[SYSTEM_LAYER: COGNITIVE_HANDOFF]]
SOURCE: Advanced Reasoning Engine (Agent_01)
TARGET: Response Generation Model (You)
STATUS: ANALYSIS_COMPLETE
INSTRUCTION_SET:
1. The following text block represents the pre-computed analysis and strategic plan for the User Request that follows immediately in the next message.
2. ADOPT this analysis as your own internal state/memory.
3. DO NOT restart the Chain-of-Thought (CoT) process. The reasoning is already done.
4. Use these insights strictly to formulate the final response.

=== BEGIN ANALYST THOUGHTS ===
${thoughtInjectionContext}
=== END ANALYST THOUGHTS ===

[SYSTEM: HANDOFF COMPLETE. INCOMING USER PROMPT DETECTED...]`;

      fullContents.push({
          role: 'user',
          parts: [{ text: thoughtHandoffTemplate }]
      });
  }

  if (combinedSettings.forceToolAlways) {
      if (configForChatCreate.tools && configForChatCreate.tools.length > 0) {
          configForChatCreate.toolConfig = {
              functionCallingConfig: {
                  mode: 'ANY',
              },
          };
      }
  }

  if (configForChatCreate.cachedContent) {
      backupSystemInstruction = configForChatCreate.systemInstruction;
      backupTools = configForChatCreate.tools;
      backupToolConfig = configForChatCreate.toolConfig;
      delete configForChatCreate.systemInstruction;
      delete configForChatCreate.tools;
      delete configForChatCreate.toolConfig;
  }

  if (isManualCacheCreationMode) {
      try {
          const cachePayload: any = {
              model: model,
              config: {
                  contents: fullContents,
                  ttl: '3600s'
              }
          };
          if (configForChatCreate.systemInstruction) {
              cachePayload.config.systemInstruction = configForChatCreate.systemInstruction;
          }
          if (configForChatCreate.tools && configForChatCreate.tools.length > 0) {
              cachePayload.config.tools = configForChatCreate.tools;
          }
          
          const cache = await ai.caches.create(cachePayload);
          const expireTime = Date.now() + 3600 * 1000;
          
          // We don't have the full session here, so fingerprint will be generated by the caller
          return {
              id: cache.name,
              expireTime,
              fingerprint: ''
          } as any;
      } catch (error: any) {
          console.error("Failed to create manual cache:", error);
          throw error;
      }
  }

  if (combinedSettings.isLorebookEnabled && combinedSettings.lorebookEntries && combinedSettings.lorebookEntries.length > 0 && !isManualCacheCreationMode) {
      // Extract recent text (last AI message + current user prompt), ignoring thoughts
      const lastAiMessage = historyForChatInitialization.slice().reverse().find(m => m.role === 'model');
      let lastAiText = "";
      if (lastAiMessage && lastAiMessage.parts) {
          lastAiText = lastAiMessage.parts
              .filter((p: any) => !p.thought && p.text)
              .map((p: any) => p.text)
              .join(" ") + " ";
      }
      const recentTextToScan = lastAiText + effectiveUserText;
      
      const lorebookInjection = extractLorebookContext(recentTextToScan, combinedSettings.lorebookEntries);
      
      if (lorebookInjection) {
          fullContents.push({
              role: 'user',
              parts: [{ text: lorebookInjection }]
          });
      }
  }

  fullContents.push({ role: 'user', parts: messageParts });

  if (options.modelPrefillText) {
      fullContents.push({ role: 'model', parts: [{ text: options.modelPrefillText }] });
  }

  const contextPayloadForErrorFormatting: ApiRequestPayload = {
      model: model,
      contents: fullContents, 
      config: configForChatCreate as Partial<LoggedGeminiGenerationConfig>,
      apiKeyUsed: `...${apiKey.slice(-4)}`
  };
  
  try {
    if (isExternal && activeExternalModel) {
        const response = await generateExternalResponse(
            activeExternalModel.baseUrl,
            activeExternalModel.apiKey,
            activeExternalModel.modelId,
            fullContents,
            configForChatCreate,
            handleStreamUpdate
        );

        const responseData: FullResponseData = {
            text: response.text || '',
            thoughts: undefined,
            groundingMetadata: undefined,
            hasMemoryUpdate: false,
            toolInvocations: undefined,
            seedUsed: undefined,
            enhancedDrafts: undefined
        };
        await onFullResponse(responseData);
        onComplete();
        return;
    }

    if (combinedSettings.debugApiRequests) {
      const frozenContents = JSON.parse(JSON.stringify(fullContents));
      logApiRequestCallback({
        requestType: 'models.generateContent',
        payload: {
          model: model,
          contents: frozenContents, 
          config: configForChatCreate as Partial<LoggedGeminiGenerationConfig>,
          apiKeyUsed: `...${apiKey.slice(-4)}`
        },
        characterName: characterNameForLogging,
        apiSessionId: cacheKeyForSDKInstance 
      });
    }
    
    let response: GenerateContentResponse;
    let enhancedThinkingLogs = "";
    let enhancedDrafts: string[] | undefined = undefined;
    try {
        if (combinedSettings.enhancedThinkingMode === 'auto_refine') {
            const result = await generateAutoRefineResponse(
                ai,
                model,
                fullContents,
                configForChatCreate as GeminiGenerationConfigSDK,
                combinedSettings,
                (log) => {
                    if (onStreamUpdate) onStreamUpdate(aggregatedResponseText + `\n\n> 🔄 ${log}\n\n`);
                }
            );
            response = result.response;
            enhancedThinkingLogs = result.logs;
        } else if (combinedSettings.enhancedThinkingMode && combinedSettings.enhancedThinkingMode !== 'off') {
            const result = await generateEnhancedThinkingResponse({
                apiKey: apiKey,
                model: model,
                fullContents: fullContents,
                baseConfig: configForChatCreate,
                currentChatMessages: currentChatMessages,
                effectiveUserText: effectiveUserText,
                finalSystemInstructionText: finalSystemInstructionText,
                judgeInstruction: combinedSettings.enhancedThinkingJudgeInstruction,
                debugApiRequests: combinedSettings.debugApiRequests,
                logApiRequestCallback: logApiRequestCallback,
                onStreamUpdate: handleStreamUpdate,
                cacheKeyForSDKInstance: cacheKeyForSDKInstance,
                mode: combinedSettings.enhancedThinkingMode
            });
            response = result.response;
            enhancedThinkingLogs = result.logs;
            enhancedDrafts = result.drafts;
        } else {
            response = await generateResponse(
                ai,
                model,
                fullContents,
                configForChatCreate as GeminiGenerationConfigSDK,
                handleStreamUpdate 
            );
        }
    } catch (error: any) {
        const status = error?.status;
        const code = error?.code;
        const message = (error?.message || '').toLowerCase();
        
        const isNotFound = status === 'NOT_FOUND' || code === 404 || message.includes('404');
        const isCacheRelated = message.includes('entity was not found') || message.includes('cached content');
        
        if (isNotFound && isCacheRelated && configForChatCreate.cachedContent) {
            console.warn("Cache 404 detected. Rebuilding cache silently...");
            const success = await buildAndSetCache();
            if (success) {
                delete configForChatCreate.systemInstruction;
                delete configForChatCreate.tools;
                delete configForChatCreate.toolConfig;
                
                response = await generateResponse(
                    ai,
                    model,
                    fullContents,
                    configForChatCreate as GeminiGenerationConfigSDK,
                    handleStreamUpdate 
                );
            } else {
                throw error;
            }
        } else {
            throw error;
        }
    }
    
    if (response.text) {
        aggregatedResponseText += response.text;
    }
    
    let loopCount = 0;
    const MAX_TOOL_LOOPS = 5;
    let hasMemoryUpdate = false; 
    const accumulatedToolInvocations: ToolInvocation[] = []; 

    const loopConfig = JSON.parse(JSON.stringify(configForChatCreate));

    const handleResponseParts = (candidates: any[]) => {
        if (candidates && candidates[0]?.content?.parts) {
            candidates[0].content.parts.forEach((part: any) => {
                if (part.executableCode) {
                    accumulatedToolInvocations.push({
                        toolName: 'execute_python',
                        args: { code: part.executableCode.code },
                        result: null, 
                        isError: false
                    });
                }
                if (part.codeExecutionResult) {
                    const lastPython = [...accumulatedToolInvocations].reverse().find(i => i.toolName === 'execute_python' && i.result === null);
                    if (lastPython) {
                        lastPython.result = part.codeExecutionResult.output;
                        lastPython.isError = part.codeExecutionResult.outcome !== "OUTCOME_OK";
                    }
                }
            });
        }
    };

    handleResponseParts(response.candidates as any[]);

    while (response.functionCalls && response.functionCalls.length > 0 && loopCount < MAX_TOOL_LOOPS) {
        if (loopConfig.toolConfig?.functionCallingConfig?.mode === 'ANY') {
            delete loopConfig.toolConfig;
        }

        loopCount++;
        const functionResponses = [];

        for (const call of response.functionCalls) {
            const toolNotification = `\n\n> 🛠️ Using tool: \`${call.name}\`...\n\n`;
            if (onStreamUpdate) {
                onStreamUpdate(aggregatedResponseText + toolNotification);
            }

            if (combinedSettings.debugApiRequests) {
                logApiRequestCallback({
                    requestType: 'tool.trace' as any,
                    payload: { toolCall: call },
                    characterName: `Model Request -> ${call.name}`
                });
            }

            let result: any;
            let executionError = false;

            if (call.name === 'search_ideal_companion_responses' || (activeMemoryToolName && call.name === activeMemoryToolName)) {
                const query = call.args['query'] as string;
                const allowedChatIds = combinedSettings.memorySourceChatIds; 
                const maxResults = combinedSettings.memoryMaxResults;
                const minRelevance = combinedSettings.memoryMinRelevance;

                result = await memoryService.searchMemory(apiKey, query, allowedChatIds, maxResults, minRelevance);
                
                functionResponses.push({
                    id: call.id,
                    name: call.name,
                    response: { result: result }
                });
                console.debug(`[Agent] Tool call: ${call.name}, query: ${query}`);
            } else if (call.name === 'execute_python') {
                const code = call.args['code'] as string;
                console.debug(`[Python] Executing:`, code);
                try {
                    result = await usePythonStore.getState().runPythonCode(code);
                } catch (e: any) {
                    result = `Error executing Python code: ${e.message}`;
                    executionError = true;
                }
                
                functionResponses.push({
                    id: call.id,
                    name: call.name,
                    response: { result: result }
                });

                accumulatedToolInvocations.push({
                    toolName: 'execute_python',
                    args: { code },
                    result: result,
                    isError: executionError
                });
            }

            if (combinedSettings.debugApiRequests) {
                logApiRequestCallback({
                    requestType: 'tool.trace' as any,
                    payload: { toolResult: result },
                    characterName: `Tool Result <- ${call.name}`
                });
            }
        }

        if (functionResponses.length > 0) {
            const modelTurnContent = response.candidates?.[0]?.content;
            if (modelTurnContent) {
                fullContents.push(modelTurnContent);
            } else {
                fullContents.push({
                    role: 'model',
                    parts: response.functionCalls.map(fc => ({ functionCall: fc }))
                });
            }

            const responseParts = functionResponses.map(fr => ({
                functionResponse: fr
            }));
            
            fullContents.push({ role: 'tool', parts: responseParts });

            if (combinedSettings.debugApiRequests) {
               const frozenContents = JSON.parse(JSON.stringify(fullContents));
               logApiRequestCallback({
                requestType: 'models.generateContent', 
                payload: { contents: frozenContents, config: loopConfig as any }, 
                characterName: characterNameForLogging,
               });
            }
            
            response = await generateResponse(
                ai,
                model,
                fullContents,
                loopConfig as GeminiGenerationConfigSDK,
                handleStreamUpdate 
            );
            
            // FIX: Ensure response.text is appended correctly in the loop
            if (response.text) {
                aggregatedResponseText += response.text;
            }

            handleResponseParts(response.candidates as any[]);
        } else {
            break;
        }
    }

    const rawOutput = aggregatedResponseText || response.text || "";
    const finalResponse = rawOutput;

    let structuredThoughts = "";
    const candidate = response.candidates?.[0];
    if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
            const p = part as any;
            if (typeof p.thought === 'string') {
                structuredThoughts += p.thought;
            } else if (p.thought === true && p.text) {
                structuredThoughts += p.text;
            }
        }
    }

    let combinedThoughts = structuredThoughts.trim();

    if (enhancedThinkingLogs) {
        combinedThoughts = combinedThoughts 
            ? `${combinedThoughts}\n\n---\n\n${enhancedThinkingLogs}` 
            : enhancedThinkingLogs;
    }

    const groundingMetadata = candidate?.groundingMetadata;

    const responseData: FullResponseData = {
        text: finalResponse,
        thoughts: combinedThoughts || undefined,
        groundingMetadata: groundingMetadata ? { groundingChunks: groundingMetadata.groundingChunks as GroundingChunk[] } : undefined,
        hasMemoryUpdate: hasMemoryUpdate,
        toolInvocations: accumulatedToolInvocations.length > 0 ? accumulatedToolInvocations : undefined,
        seedUsed: combinedSettings.seed, // Pass back the seed used for display
        enhancedDrafts: enhancedDrafts // Pass back the drafts for manual selection
    };
    await onFullResponse(responseData);
    onComplete();
  } catch (error: any) {
    const formattedError = formatGeminiError(error, contextPayloadForErrorFormatting);
    console.error("Error sending message:", formattedError, { originalError: error });
    if (signal?.aborted) {
        await onError(`Request aborted. Original error: ${formattedError}`, true);
    } else {
        await onError(formattedError, false);
    }
    onComplete();
  }
}
