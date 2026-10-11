const { GoogleGenAI } = require('@google/genai');
const { VERTEX_PROJECT_ID, VERTEX_LOCATION, VERTEX_MODEL } = require('../config/env');
const { allFunctionDeclarations, allExecutors } = require('./tools');
const { getAgentInstruction } = require('./prompts');
const { checkRateLimit, beforeTool, afterTool } = require('./shared_libraries/callbacks');
const { translate, normalizeLanguage } = require('../utils/i18n');

// One model call, and a whole question with its tool calls
const MODEL_TIMEOUT_MS = 30000;
const REPLY_DEADLINE_MS = 75000;
const MAX_HISTORY = 16;

/**
 * Drop the oldest turns beyond `max`, cutting only before a user's question: a tool call and its
 * result must stay together, or the model refuses the conversation.
 */
function trimHistory(history, max = MAX_HISTORY) {
    if (history.length <= max) return history;
    const isQuestion = (entry) => entry?.role === 'user' && (entry.parts || []).some(part => typeof part.text === 'string');
    let start = history.length - max;
    while (start < history.length && !isQuestion(history[start])) start++;
    // No question in the window (one very long tool exchange): keep the last question onwards
    if (start >= history.length) {
        start = history.length - 1;
        while (start > 0 && !isQuestion(history[start])) start--;
    }
    history.splice(0, start);
    return history;
}

const vertexAI = new GoogleGenAI({
    vertexai: true,
    project: VERTEX_PROJECT_ID,
    location: VERTEX_LOCATION
});

// Session conversation history store: Map<"userId:sessionId", Array<{ role, parts }>>
// Keyed by user so two accounts using the same sessionId never share history
// Per user + chat session; idle sessions expire and the total is capped
const chatHistoryStore = require('../utils/ttlCache').createTtlCache({ ttlMs: 60 * 60 * 1000, maxEntries: 5000 });

function historyKey(userId, sessionId) {
    return `${userId}:${sessionId}`;
}

function getChatHistory(userId, sessionId) {
    return chatHistoryStore.get(historyKey(userId, sessionId)) || [];
}

function clearChatHistory(userId, sessionId) {
    chatHistoryStore.delete(historyKey(userId, sessionId));
}

/**
 * Main chat with agent function with multi-turn tool calling and structured tag parsing
 */
async function chatWithAgent({
    sessionId = 'default-session',
    message,
    uiContext = {},
    userId = null,
    // req.user ({ id, role }); tools apply the same camera access rules as the API
    user = null
}) {
    if (!userId) {
        throw new Error('chatWithAgent requires an authenticated userId');
    }

    const language = normalizeLanguage(user?.language);
    const t = (key) => translate(language, `assistant.${key}`);

    if (!checkRateLimit()) {
        return { reply: t('busy'), suggestions: [], actions: [], toolExecutions: [] };
    }

    const sessionHistory = getChatHistory(userId, sessionId);

    // Inject UI context header into current query
    const tabStr = uiContext.tab ? `Current View: "${uiContext.tab}"` : 'View: dashboard';
    const cameraStr = uiContext.deviceSerial ? `Selected Camera: "${uiContext.deviceSerial}"` : 'Camera: all';
    const contextPrefix = `[UI Context | ${tabStr}, ${cameraStr}]\n`;
    const userPrompt = contextPrefix + message;

    // Append user message
    const historyLengthBefore = sessionHistory.length;
    sessionHistory.push({
        role: 'user',
        parts: [{ text: userPrompt }]
    });

    const modelName = VERTEX_MODEL || 'gemini-2.5-flash';
    const systemInstruction = getAgentInstruction(uiContext);

    const toolsConfig = [{
        functionDeclarations: allFunctionDeclarations
    }];

    let finalReply = '';
    const toolExecutions = [];
    // UI actions raised by tools during this request only (never shared between concurrent requests)
    const actions = [];
    const addAction = (type, payload) => actions.push({ type, payload });
    const MAX_TOOL_TURNS = 5;
    const startedAt = Date.now();

    try {
        let currentTurn = 0;
        let continueLoop = true;

        while (continueLoop && currentTurn < MAX_TOOL_TURNS) {
            currentTurn++;
            if (Date.now() - startedAt > REPLY_DEADLINE_MS) {
                finalReply = t('timeout');
                break;
            }

            const response = await vertexAI.models.generateContent({
                model: modelName,
                contents: sessionHistory,
                config: {
                    systemInstruction,
                    tools: toolsConfig,
                    httpOptions: { timeout: MODEL_TIMEOUT_MS }
                }
            });

            const candidate = response.candidates?.[0];
            const content = candidate?.content;

            if (!content) {
                finalReply = t('noResponse');
                break;
            }

            // Push model candidate to history
            sessionHistory.push(content);

            const functionCalls = response.functionCalls || [];

            if (functionCalls.length > 0) {
                const functionResponseParts = [];

                for (const call of functionCalls) {
                    const { name, args } = call;
                    beforeTool(name, args);

                    let result = null;
                    let error = null;

                    try {
                        const executor = allExecutors[name];
                        if (executor) {
                            result = await executor({ ...(args || {}), userId, user: user || { id: userId }, addAction });
                            afterTool(name, result);
                        } else {
                            result = { error: `Tool "${name}" does not exist.` };
                            afterTool(name, null, new Error('Unknown tool'));
                        }
                    } catch (e) {
                        error = e;
                        result = { error: e.message };
                        afterTool(name, null, e);
                    }

                    toolExecutions.push({
                        name,
                        args,
                        result,
                        status: error ? 'error' : 'success'
                    });

                    functionResponseParts.push({
                        functionResponse: {
                            name,
                            response: result
                        }
                    });
                }

                // Add tool responses back to history for the next turn
                sessionHistory.push({
                    role: 'user',
                    parts: functionResponseParts
                });
            } else {
                // No function call, retrieve text output
                finalReply = response.text || t('noResponse');
                continueLoop = false;
            }
        }
        // Out of tool turns without a written answer
        if (continueLoop && !finalReply) finalReply = t('noResponse');
    } catch (err) {
        console.error('❌ [Agent Core Error]:', err.message);
        finalReply = t('error');
    }
    // A question that did not end in a written answer (error, time limit, out of tool turns) leaves
    // nothing half-done in the history, such as a tool call without its result
    const lastTurn = sessionHistory.at(-1);
    const answered = lastTurn?.role === 'model'
        && (lastTurn.parts || []).some(part => typeof part.text === 'string')
        && !(lastTurn.parts || []).some(part => part.functionCall);
    if (!answered) sessionHistory.splice(historyLengthBefore);

    // Parse [SUGGESTIONS] block
    let suggestions = [];
    const suggRegex = /\[SUGGESTIONS\]([\s\S]*?)\[\/SUGGESTIONS\]/i;
    const suggMatch = finalReply.match(suggRegex);
    if (suggMatch) {
        try {
            const clean = suggMatch[1].replace(/```json/g, '').replace(/```/g, '').trim();
            suggestions = JSON.parse(clean);
        } catch (e) {}
        finalReply = finalReply.replace(suggRegex, '').trim();
    }

    // Pages open only through the navigate_ui tool, which checks them; a written tag is dropped
    finalReply = finalReply.replace(/\[NAVIGATE\][\s\S]*?\[\/NAVIGATE\]/gi, '').trim();
    if (!Array.isArray(suggestions)) suggestions = [];
    suggestions = suggestions.filter(s => typeof s === 'string' && s.trim()).map(s => s.slice(0, 120)).slice(0, 4);
    const navigate = [...actions].reverse().find(a => a.type === 'NAVIGATE')?.payload;

    // Bounded history, cut between questions
    chatHistoryStore.set(historyKey(userId, sessionId), trimHistory(sessionHistory));

    // Default suggestions fallback if model omitted them
    if (suggestions.length === 0) {
        suggestions = [t('suggest1'), t('suggest2'), t('suggest3'), t('suggest4')];
    }

    return {
        reply: finalReply,
        suggestions,
        navigate,
        actions,
        toolExecutions
    };
}

module.exports = {
    trimHistory,
    chatWithAgent,
    getChatHistory,
    clearChatHistory
};
