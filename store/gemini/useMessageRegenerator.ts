
import { create } from 'zustand';
import { geminiRefs } from './sharedRefs.ts';
import { useGeminiStatusStore } from './useGeminiStatusStore.ts';
import { useApiKeyStore } from '../useApiKeyStore.ts';
import { useActiveChatStore } from '../useActiveChatStore.ts';
import { useDataStore } from '../useDataStore.ts';
import { useChatListStore } from '../useChatListStore.ts';
import { useAudioStore } from '../useAudioStore.ts';
import { 
    ChatMessage, GeminiSettings, UserMessageInput, 
    FullResponseData, ChatMessageRole, ChatSession
} from '../../types.ts';
import { getFullChatResponse } from '../../services/llm/chat.ts';
import { findPrecedingUserMessageIndex, getHistoryUpToMessage } from '../../services/utils.ts';
import { extractThoughtsByTag } from '../../services/llm/utils.ts';
import * as dbService from '../../services/dbService.ts';
import { useStreamingStore } from '../useStreamingStore.ts';

interface MessageRegeneratorActions {
    handleRegenerateAIMessage: (aiMessageIdToRegenerate: string, targetChatId?: string) => Promise<void>;
    handleRegenerateResponseForUserMessage: (userMessageId: string, targetChatId?: string) => Promise<void>;
}

export const useMessageRegenerator = create<MessageRegeneratorActions>((set, get) => ({
    handleRegenerateAIMessage: async (aiMessageIdToRegenerate: string, targetChatId?: string) => {
        const { activeApiKey, rotateActiveKey } = useApiKeyStore.getState();
        const { currentChatSession, updateCurrentChatSession } = useActiveChatStore.getState();
        const { setMessageGenerationTimes } = useDataStore.getState();
        const { setIsLoading, logApiRequest } = useGeminiStatusStore.getState();
        const { handleStopAndCancelAllForCurrentAudio } = useAudioStore.getState();
        const isLoading = useGeminiStatusStore.getState().isLoading;

        let sessionToUpdate = currentChatSession;
        if (targetChatId && targetChatId !== currentChatSession?.id) {
            const fetchedSession = await dbService.getChatSession(targetChatId);
            if (fetchedSession) {
                sessionToUpdate = fetchedSession;
            } else {
                console.error("Target chat session not found for regeneration:", targetChatId);
                return;
            }
        }

        if (!sessionToUpdate || isLoading) return;
        if (!activeApiKey?.value) {
            const errorMessage: ChatMessage = { id: `err-${Date.now()}`, role: ChatMessageRole.ERROR, content: "No API key set. Please go to Settings > API Key to set your key.", timestamp: new Date() };
            const updatedMessages = [...sessionToUpdate.messages, errorMessage];
            
            if (sessionToUpdate.id === currentChatSession?.id) {
                let sessionAfterError: ChatSession | null = null;
                await updateCurrentChatSession(session => {
                    if (!session) return null;
                    sessionAfterError = { ...session, messages: updatedMessages };
                    return sessionAfterError;
                });
                if (sessionAfterError) await dbService.addOrUpdateChatSession(sessionAfterError);
            } else {
                sessionToUpdate.messages = updatedMessages;
                await dbService.addOrUpdateChatSession(sessionToUpdate);
            }
            return;
        }

        const messageIndex = sessionToUpdate.messages.findIndex(m => m.id === aiMessageIdToRegenerate);
        if (messageIndex === -1) return;
        
        const originalAiMessage = sessionToUpdate.messages[messageIndex];
        if (originalAiMessage.role !== ChatMessageRole.MODEL && originalAiMessage.role !== ChatMessageRole.ERROR) return;

        // Audio Cleanup Logic
        if (originalAiMessage.cachedAudioSegmentCount && originalAiMessage.cachedAudioSegmentCount > 0) {
            handleStopAndCancelAllForCurrentAudio();
            const deletePromises: Promise<void>[] = [];
            for (let i = 0; i < originalAiMessage.cachedAudioSegmentCount; i++) {
                deletePromises.push(dbService.deleteAudioBuffer(`${originalAiMessage.id}_part_${i}`));
            }
            Promise.all(deletePromises).catch(err => console.error("Failed to cleanup audio during regenerate:", err));
        }

        const precedingUserMessageIndex = findPrecedingUserMessageIndex(sessionToUpdate.messages, messageIndex);
        if (precedingUserMessageIndex === -1) return;

        const userMessage = sessionToUpdate.messages[precedingUserMessageIndex];
        const historyForGeminiSDK = getHistoryUpToMessage(sessionToUpdate.messages, precedingUserMessageIndex);
        
        await rotateActiveKey();
        geminiRefs.requestCancelledByUser = false;
        geminiRefs.onFullResponseCalledForPendingMessage = false;
        geminiRefs.originalMessageSnapshot = null;
        
        setIsLoading(true);
        geminiRefs.abortController = new AbortController();
        geminiRefs.pendingMessageId = aiMessageIdToRegenerate;

        const placeholderAiMessage: ChatMessage = { 
            ...originalAiMessage,
            content: '', 
            timestamp: new Date(), 
            isStreaming: true, 
            role: ChatMessageRole.MODEL,
            cachedAudioBuffers: null, 
            cachedAudioSegmentCount: undefined, 
            groundingMetadata: undefined 
        };

        const newMessages = sessionToUpdate.messages.map(msg => 
            msg.id === aiMessageIdToRegenerate ? placeholderAiMessage : msg
        );

        if (sessionToUpdate.id === currentChatSession?.id) {
            let sessionAfterPlaceholder: ChatSession | null = null;
            await updateCurrentChatSession(session => {
                if (!session) return null;
                sessionAfterPlaceholder = { ...session, messages: newMessages };
                return sessionAfterPlaceholder;
            });
            if (sessionAfterPlaceholder) await dbService.addOrUpdateChatSession(sessionAfterPlaceholder);
        } else {
            sessionToUpdate.messages = newMessages;
            await dbService.addOrUpdateChatSession(sessionToUpdate);
        }

        const finalUserMessageInputForAPI: UserMessageInput = { text: userMessage.content, attachments: userMessage.attachments || [] };
        const baseSettingsForAPICall = { ...sessionToUpdate.settings };
        let settingsOverrideForAPICall: Partial<GeminiSettings & { _characterIdForAPICall?: string }> = {};
        if (sessionToUpdate.isCharacterModeActive && originalAiMessage.characterName) {
            const character = (sessionToUpdate.aiCharacters || []).find(c => c.name === originalAiMessage.characterName);
            if (character) {
                settingsOverrideForAPICall.systemInstruction = character.systemInstruction;
                settingsOverrideForAPICall.userPersonaInstruction = undefined;
                settingsOverrideForAPICall._characterIdForAPICall = character.id;
            }
        }
        
        // --- SEED LOGIC (Same as MessageSender) ---
        const reqSeed = settingsOverrideForAPICall.seed ?? baseSettingsForAPICall.seed;
        const finalSeed = reqSeed !== undefined ? reqSeed : Math.floor(Math.random() * 2147483647);
        settingsOverrideForAPICall.seed = finalSeed;
        // -----------------------------------------

        const activeChatIdForThisRegenCall = sessionToUpdate.id;

        // --- STREAMING CALLBACK ---
        const handleStreamUpdate = (fullRawText: string) => {
            if (geminiRefs.requestCancelledByUser && geminiRefs.pendingMessageId === aiMessageIdToRegenerate) return;
            
            // TARGETED ZUSTAND UPDATE (MEMORY ONLY)
            useStreamingStore.getState().updateStreamingText(fullRawText);
        };

        useStreamingStore.getState().setStreamingMessage(aiMessageIdToRegenerate, '');
        await getFullChatResponse({
            apiKey: activeApiKey?.value || '',
            sessionId: activeChatIdForThisRegenCall,
            userMessageInput: finalUserMessageInputForAPI,
            model: sessionToUpdate.model,
            baseSettings: baseSettingsForAPICall,
            currentChatMessages: historyForGeminiSDK,
            onStreamUpdate: handleStreamUpdate, // Enable Streaming
            onFullResponse: async (responseData: FullResponseData) => {
                if (geminiRefs.requestCancelledByUser && geminiRefs.pendingMessageId === aiMessageIdToRegenerate) return;
                geminiRefs.onFullResponseCalledForPendingMessage = true;
                if (geminiRefs.generationStartTime) await setMessageGenerationTimes(prev => ({...prev, [aiMessageIdToRegenerate]: (Date.now() - (geminiRefs.generationStartTime || 0)) / 1000}));
                
                let fullSession = useActiveChatStore.getState().currentChatSession;
                if (!fullSession || fullSession.id !== activeChatIdForThisRegenCall) {
                    fullSession = await dbService.getChatSession(activeChatIdForThisRegenCall);
                }

                if (!fullSession) return;

                // --- CUSTOM THOUGHT PARSING LOGIC ---
                let mergedThoughts = responseData.thoughts || "";
                let finalResponseText = responseData.text;

                if (fullSession.settings.enableCustomThoughtParsing && fullSession.settings.customThoughtTagName) {
                    const { cleanText, extractedThoughts } = extractThoughtsByTag(finalResponseText, fullSession.settings.customThoughtTagName);
                    finalResponseText = cleanText;
                    if (extractedThoughts) {
                        if (mergedThoughts) {
                            mergedThoughts += "\n\n---\n\n" + extractedThoughts;
                        } else {
                            mergedThoughts = extractedThoughts;
                        }
                    }
                }
                // ------------------------------------

                const newAiMessage: ChatMessage = { 
                    ...placeholderAiMessage, 
                    content: finalResponseText, 
                    thoughts: mergedThoughts,
                    groundingMetadata: responseData.groundingMetadata, 
                    isStreaming: false, 
                    timestamp: new Date(), 
                    seedUsed: responseData.seedUsed, // STORE SEED
                    enhancedDrafts: responseData.enhancedDrafts // STORE DRAFTS
                };
                
                const updatedMessages = fullSession.messages.map(msg => msg.id === aiMessageIdToRegenerate ? newAiMessage : msg);
                const updatedSession = { ...fullSession, messages: updatedMessages, lastUpdatedAt: new Date() };
                
                if (useActiveChatStore.getState().currentChatId === activeChatIdForThisRegenCall) {
                    useActiveChatStore.getState().updateCurrentChatSession(s => s ? ({ ...s, messages: updatedMessages, lastUpdatedAt: new Date() }) : null);
                } else {
                    useChatListStore.getState().updateChatSessionInList(updatedSession);
                }
                await dbService.addOrUpdateChatSession(updatedSession);

                const { triggerAutoPlayForNewMessage } = useAudioStore.getState();
                await triggerAutoPlayForNewMessage(newAiMessage);
            },
            onError: async (errorMsg, isAbortError) => {
                if (geminiRefs.requestCancelledByUser && geminiRefs.pendingMessageId === aiMessageIdToRegenerate) { setIsLoading(false); return; }
                geminiRefs.onFullResponseCalledForPendingMessage = false;
                const finalErrorMessage = isAbortError ? `Response aborted.` : `Response failed: ${errorMsg}`;

                let fullSession = useActiveChatStore.getState().currentChatSession;
                if (!fullSession || fullSession.id !== activeChatIdForThisRegenCall) {
                    fullSession = await dbService.getChatSession(activeChatIdForThisRegenCall);
                }
                if (!fullSession) return;
                
                const updatedMessages = fullSession.messages.map(msg => msg.id === aiMessageIdToRegenerate ? { ...msg, isStreaming: false, role: ChatMessageRole.ERROR, content: finalErrorMessage } : msg);
                const updatedSession = { ...fullSession, messages: updatedMessages, lastUpdatedAt: new Date() };

                if (useActiveChatStore.getState().currentChatId === activeChatIdForThisRegenCall) {
                    useActiveChatStore.getState().updateCurrentChatSession(s => s ? ({ ...s, messages: updatedMessages, lastUpdatedAt: new Date() }) : null);
                } else {
                    useChatListStore.getState().updateChatSessionInList(updatedSession);
                }
                await dbService.addOrUpdateChatSession(updatedSession);

                if (!geminiRefs.requestCancelledByUser && geminiRefs.pendingMessageId === aiMessageIdToRegenerate) { setIsLoading(false); }
                useStreamingStore.getState().clearStreaming();
            },
            onComplete: async () => {
                const userDidCancel = geminiRefs.requestCancelledByUser;
                const currentPendingMsgIdForComplete = geminiRefs.pendingMessageId;
                if (userDidCancel && currentPendingMsgIdForComplete === aiMessageIdToRegenerate) {}
                else if (currentPendingMsgIdForComplete === aiMessageIdToRegenerate) {
                    setIsLoading(false);
                    if (!geminiRefs.onFullResponseCalledForPendingMessage) {
                        let fullSession = useActiveChatStore.getState().currentChatSession;
                        if (!fullSession || fullSession.id !== activeChatIdForThisRegenCall) {
                            fullSession = await dbService.getChatSession(activeChatIdForThisRegenCall);
                        }

                        if (fullSession) {
                            const messageInState = fullSession.messages.find(m => m.id === aiMessageIdToRegenerate);
                            if (messageInState && messageInState.isStreaming && messageInState.role !== ChatMessageRole.ERROR) {
                                const updatedMessages = fullSession.messages.map(msg => msg.id === aiMessageIdToRegenerate ? { ...msg, isStreaming: false, role: ChatMessageRole.ERROR, content: "Response processing failed or stream ended unexpectedly.", timestamp: new Date() } : msg );
                                const updatedSession = { ...fullSession, messages: updatedMessages, lastUpdatedAt: new Date() };
                                
                                if (useActiveChatStore.getState().currentChatId === activeChatIdForThisRegenCall) {
                                    useActiveChatStore.getState().updateCurrentChatSession(s => s ? ({ ...s, messages: updatedMessages, lastUpdatedAt: new Date() }) : null);
                                } else {
                                    useChatListStore.getState().updateChatSessionInList(updatedSession);
                                }
                                await dbService.addOrUpdateChatSession(updatedSession);
                            } else {
                                const updatedSession = { ...fullSession, lastUpdatedAt: new Date() };
                                useChatListStore.getState().updateChatSessionInList(updatedSession);
                            }
                        }
                    }
                    geminiRefs.pendingMessageId = null;
                }
                if (geminiRefs.abortController && currentPendingMsgIdForComplete === aiMessageIdToRegenerate) geminiRefs.abortController = null;
                if (currentPendingMsgIdForComplete === aiMessageIdToRegenerate) geminiRefs.requestCancelledByUser = false;
                geminiRefs.onFullResponseCalledForPendingMessage = false;
                useStreamingStore.getState().clearStreaming();
            },
            logApiRequestCallback: logApiRequest,
            signal: geminiRefs.abortController.signal,
            settingsOverride: settingsOverrideForAPICall,
            allAiCharactersInSession: sessionToUpdate.aiCharacters,
            generatingMessageId: aiMessageIdToRegenerate,
            sessionToUpdate: sessionToUpdate,
            onCacheUpdate: async (newCacheInfo) => {
                if (sessionToUpdate!.id === useActiveChatStore.getState().currentChatId) {
                    await useActiveChatStore.getState().updateCurrentChatSession(s => s ? ({ ...s, cacheInfo: newCacheInfo }) : null);
                    const updatedSession = useActiveChatStore.getState().currentChatSession;
                    if (updatedSession) {
                        await dbService.addOrUpdateChatSession(updatedSession);
                    }
                } else {
                    sessionToUpdate!.cacheInfo = newCacheInfo;
                    await dbService.addOrUpdateChatSession(sessionToUpdate!);
                }
            }
        });
    },

    handleRegenerateResponseForUserMessage: async (userMessageId: string, targetChatId?: string) => {
        const { currentChatSession, updateCurrentChatSession } = useActiveChatStore.getState();
        const isLoading = useGeminiStatusStore.getState().isLoading;

        let sessionToUpdate = currentChatSession;
        if (targetChatId && targetChatId !== currentChatSession?.id) {
            const fetchedSession = await dbService.getChatSession(targetChatId);
            if (fetchedSession) {
                sessionToUpdate = fetchedSession;
            } else {
                console.error("Target chat session not found for regeneration:", targetChatId);
                return;
            }
        }

        if (!sessionToUpdate || isLoading) return;

        const userMessageIndex = sessionToUpdate.messages.findIndex(m => m.id === userMessageId);
        if (userMessageIndex === -1) return;

        if (userMessageIndex + 1 < sessionToUpdate.messages.length) {
            const aiMessageToRegenerate = sessionToUpdate.messages[userMessageIndex + 1];
            if (aiMessageToRegenerate.role === ChatMessageRole.MODEL || aiMessageToRegenerate.role === ChatMessageRole.ERROR) {
                await get().handleRegenerateAIMessage(aiMessageToRegenerate.id, targetChatId);
            }
            return;
        }

        const aiMessageId = `msg-${Date.now()}-model-${Math.random().toString(36).substring(2,7)}`;
        const placeholderAiMessage: ChatMessage = { 
            id: aiMessageId, 
            role: ChatMessageRole.MODEL, 
            content: '', 
            timestamp: new Date(), 
            isStreaming: true 
        };
        
        if (sessionToUpdate.id === currentChatSession?.id) {
            let sessionAfterUpdate: ChatSession | null = null;
            await updateCurrentChatSession(session => {
                if (!session) return null;
                sessionAfterUpdate = { ...session, messages: [...session.messages, placeholderAiMessage] };
                return sessionAfterUpdate;
            });
            if (sessionAfterUpdate) await dbService.addOrUpdateChatSession(sessionAfterUpdate);
        } else {
            sessionToUpdate.messages = [...sessionToUpdate.messages, placeholderAiMessage];
            await dbService.addOrUpdateChatSession(sessionToUpdate);
        }

        await get().handleRegenerateAIMessage(aiMessageId, targetChatId);
    },
}));
