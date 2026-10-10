const { GoogleGenAI } = require('@google/genai');
const { VERTEX_PROJECT_ID, VERTEX_LOCATION, VERTEX_MODEL } = require('../config/env');
const { allFunctionDeclarations, allExecutors } = require('./tools');
const { getAgentInstruction } = require('./prompts');
const { checkRateLimit, beforeTool, afterTool } = require('./shared_libraries/callbacks');

const vertexAI = new GoogleGenAI({
    vertexai: true,
    project: VERTEX_PROJECT_ID,
    location: VERTEX_LOCATION
});

// Session conversation history store: Map<"userId:sessionId", Array<{ role, parts }>>
// Keyed by user so two accounts using the same sessionId never share history
const chatHistoryStore = new Map();

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
    userId = null
}) {
    if (!userId) {
        throw new Error('chatWithAgent requires an authenticated userId');
    }

    if (!checkRateLimit()) {
        return {
            reply: '⚠️ The system is currently handling too many requests. Please wait a moment and try again.',
            suggestions: ['Restart conversation'],
            actions: []
        };
    }

    const sessionHistory = getChatHistory(userId, sessionId);

    // Inject UI context header into current query
    const tabStr = uiContext.tab ? `Current View: "${uiContext.tab}"` : 'View: dashboard';
    const cameraStr = uiContext.deviceSerial ? `Selected Camera: "${uiContext.deviceSerial}"` : 'Camera: all';
    const contextPrefix = `[UI Context | ${tabStr}, ${cameraStr}]\n`;
    const userPrompt = contextPrefix + message;

    // Append user message
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

    try {
        let currentTurn = 0;
        let continueLoop = true;

        while (continueLoop && currentTurn < MAX_TOOL_TURNS) {
            currentTurn++;

            const response = await vertexAI.models.generateContent({
                model: modelName,
                contents: sessionHistory,
                config: {
                    systemInstruction,
                    tools: toolsConfig
                }
            });

            const candidate = response.candidates?.[0];
            const content = candidate?.content;

            if (!content) {
                finalReply = 'No response received from the AI model.';
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
                            result = await executor({ ...(args || {}), userId, addAction });
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
                finalReply = response.text || '';
                continueLoop = false;
            }
        }
    } catch (err) {
        console.error('❌ [Agent Core Error]:', err);
        finalReply = '⚠️ AI Assistant encountered an error. Please try again in a moment.';
    }

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

    // Parse [NAVIGATE] block
    let navigate = undefined;
    const navRegex = /\[NAVIGATE\]([\s\S]*?)\[\/NAVIGATE\]/i;
    const navMatch = finalReply.match(navRegex);
    if (navMatch) {
        try {
            const clean = navMatch[1].replace(/```json/g, '').replace(/```/g, '').trim();
            navigate = JSON.parse(clean);
        } catch (e) {}
        finalReply = finalReply.replace(navRegex, '').trim();
    }

    if (navigate) {
        actions.push({ type: 'NAVIGATE', payload: navigate });
    }

    // Keep history bounded to last 16 messages to prevent token blowout
    if (sessionHistory.length > 16) {
        sessionHistory.splice(0, sessionHistory.length - 16);
    }
    chatHistoryStore.set(historyKey(userId, sessionId), sessionHistory);

    // Default suggestions fallback if model omitted them
    if (suggestions.length === 0) {
        suggestions = [
            '📊 Summarize 24h pest density',
            '📸 Capture new camera snapshot',
            '📡 Check online cameras status',
            '🪰 Fruit fly management recommendations'
        ];
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
    chatWithAgent,
    getChatHistory,
    clearChatHistory
};
