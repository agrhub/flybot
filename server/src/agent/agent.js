const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');
const { VERTEX_PROJECT_ID, VERTEX_LOCATION, VERTEX_MODEL } = require('../config/env');
const { ChatSession } = require('../models');
const { MAX_CHAT_MESSAGES } = require('../models/ChatSession');
const { allFunctionDeclarations, allExecutors } = require('./tools');
const { getAgentInstruction } = require('./prompts');
const { checkRateLimit, beforeTool, afterTool } = require('./shared_libraries/callbacks');
const { translate, normalizeLanguage } = require('../utils/i18n');

// One model call, and a whole question with its tool calls
const MODEL_TIMEOUT_MS = 30000;
const REPLY_DEADLINE_MS = 75000;
const MAX_TOOL_TURNS = 5;
// Turns of history the model is given
const MAX_HISTORY = 16;
// Result cards shown under one answer
const MAX_CARDS = 4;
// Blocks the model appends to its answer; never shown while the answer streams in
const TAIL_MARKERS = ['[SUGGESTIONS]', '[NAVIGATE]'];

const vertexAI = new GoogleGenAI({
    vertexai: true,
    project: VERTEX_PROJECT_ID,
    location: VERTEX_LOCATION
});

// The model call, replaceable in tests: returns an async iterable of response chunks
let modelClient = {
    stream: (request) => vertexAI.models.generateContentStream(request)
};
function setModelClient(client) {
    modelClient = client;
}

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

/** The part of a streaming answer that can be shown: up to a tail block, even a half-written one. */
function visibleText(text) {
    let cut = text.length;
    for (const marker of TAIL_MARKERS) {
        const at = text.indexOf(marker);
        if (at >= 0) cut = Math.min(cut, at);
    }
    const open = text.lastIndexOf('[');
    if (open >= 0 && open < cut && TAIL_MARKERS.some(marker => marker.startsWith(text.slice(open)))) cut = open;
    return text.slice(0, cut);
}

// ---------- Stored conversations ----------

/** The messages of a conversation, as the chat panel shows them. */
async function getChatHistory(userId, sessionId) {
    const doc = await ChatSession.findOne({ userId, sessionId }).select('messages').lean();
    return doc?.messages || [];
}

async function clearChatHistory(userId, sessionId) {
    await ChatSession.deleteOne({ userId, sessionId });
}

/** Rate one of the assistant's answers ('up', 'down', or null to take the rating back). */
async function rateMessage(userId, sessionId, messageId, rating) {
    const filter = { userId, sessionId, messages: { $elemMatch: { id: messageId, role: 'assistant' } } };
    const update = rating
        ? { $set: { 'messages.$.feedback': { rating, at: new Date() } } }
        : { $unset: { 'messages.$.feedback': 1 } };
    const res = await ChatSession.updateOne(filter, update);
    return res.matchedCount > 0;
}

/**
 * Answer one question: multi-turn tool calling, the answer streamed through `onEvent`:
 *  - ('turn')                      a new model call starts (what streamed so far was not the answer)
 *  - ('delta', { text })           more of the answer
 *  - ('tool', { name, phase, status?, message? })   a tool starts or ends
 * Returns { reply, suggestions, navigate, actions, cards, toolExecutions, messageId }.
 */
async function chatWithAgent({
    sessionId = 'default-session',
    message,
    uiContext = {},
    userId = null,
    // req.user ({ id, role }); tools apply the same camera access rules as the API
    user = null,
    onEvent = () => {}
}) {
    if (!userId) {
        throw new Error('chatWithAgent requires an authenticated userId');
    }

    const language = normalizeLanguage(user?.language);
    const t = (key) => translate(language, `assistant.${key}`);
    const emit = (type, data) => {
        try {
            onEvent(type, data);
        } catch {
            // The listener (a closed connection) never stops the answer
        }
    };

    if (!checkRateLimit()) {
        return { reply: t('busy'), suggestions: [], actions: [], cards: [], toolExecutions: [] };
    }

    const stored = await ChatSession.findOne({ userId, sessionId }).select('contents').lean();
    const sessionHistory = Array.isArray(stored?.contents) ? [...stored.contents] : [];

    // Inject UI context header into current query
    const tabStr = uiContext.tab ? `Current View: "${uiContext.tab}"` : 'View: dashboard';
    const cameraStr = uiContext.deviceSerial ? `Selected Camera: "${uiContext.deviceSerial}"` : 'Camera: all';
    const userPrompt = `[UI Context | ${tabStr}, ${cameraStr}]\n${message}`;

    const historyLengthBefore = sessionHistory.length;
    sessionHistory.push({ role: 'user', parts: [{ text: userPrompt }] });

    const request = {
        model: VERTEX_MODEL || 'gemini-2.5-flash',
        config: {
            systemInstruction: getAgentInstruction(uiContext),
            tools: [{ functionDeclarations: allFunctionDeclarations }]
        }
    };

    let finalReply = '';
    const toolExecutions = [];
    // UI actions and result cards raised by tools during this request only
    const actions = [];
    const addAction = (type, payload) => actions.push({ type, payload });
    const cards = [];
    const addCard = (card) => {
        if (cards.length < MAX_CARDS) cards.push(card);
    };
    const startedAt = Date.now();

    try {
        let continueLoop = true;
        for (let turn = 1; continueLoop && turn <= MAX_TOOL_TURNS; turn++) {
            if (Date.now() - startedAt > REPLY_DEADLINE_MS) {
                finalReply = t('timeout');
                break;
            }
            if (turn > 1) emit('turn', { turn });

            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), MODEL_TIMEOUT_MS);
            const parts = [];
            const calls = [];
            let text = '';
            let shown = 0;
            try {
                const stream = await modelClient.stream({
                    ...request,
                    contents: sessionHistory,
                    config: { ...request.config, abortSignal: abort.signal }
                });
                for await (const chunk of stream) {
                    for (const part of chunk?.candidates?.[0]?.content?.parts || []) {
                        parts.push(part);
                        if (part.functionCall) calls.push(part.functionCall);
                        if (typeof part.text === 'string' && !part.thought) {
                            text += part.text;
                            const visible = visibleText(text);
                            if (visible.length > shown) {
                                emit('delta', { text: visible.slice(shown) });
                                shown = visible.length;
                            }
                        }
                    }
                }
            } finally {
                clearTimeout(timer);
            }

            if (!parts.length) {
                finalReply = t('noResponse');
                break;
            }
            sessionHistory.push({ role: 'model', parts });

            if (!calls.length) {
                finalReply = text || t('noResponse');
                continueLoop = false;
                break;
            }

            const functionResponseParts = [];
            for (const call of calls) {
                const { name, args } = call;
                beforeTool(name, args);
                emit('tool', { name, phase: 'start' });
                let result;
                try {
                    const executor = allExecutors[name];
                    if (executor) {
                        result = await executor({ ...(args || {}), userId, user: user || { id: userId }, addAction, addCard });
                        afterTool(name, result);
                    } else {
                        result = { error: `Tool "${name}" does not exist.` };
                        afterTool(name, null, new Error('Unknown tool'));
                    }
                } catch (e) {
                    result = { error: e.message };
                    afterTool(name, null, e);
                }
                const status = result?.error ? 'error' : 'success';
                const note = typeof result?.message === 'string' ? result.message : (typeof result?.error === 'string' ? result.error : undefined);
                toolExecutions.push({ name, status, message: note });
                emit('tool', { name, phase: 'end', status, message: note });
                functionResponseParts.push({ functionResponse: { name, response: result } });
            }
            sessionHistory.push({ role: 'user', parts: functionResponseParts });
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
    }
    // Tail blocks never reach the user; pages open only through the navigate_ui tool, which checks them
    finalReply = visibleText(finalReply.replace(suggRegex, '').replace(/\[NAVIGATE\][\s\S]*?\[\/NAVIGATE\]/gi, '')).trim();
    if (!Array.isArray(suggestions)) suggestions = [];
    suggestions = suggestions.filter(s => typeof s === 'string' && s.trim()).map(s => s.slice(0, 120)).slice(0, 4);
    if (suggestions.length === 0) {
        suggestions = [t('suggest1'), t('suggest2'), t('suggest3'), t('suggest4')];
    }
    const navigate = [...actions].reverse().find(a => a.type === 'NAVIGATE')?.payload;

    // Stored: the model's history (cut between questions) and the two messages for the panel
    const messageId = crypto.randomUUID();
    const now = new Date();
    await ChatSession.updateOne(
        { userId, sessionId },
        {
            $set: { contents: trimHistory(sessionHistory), updatedAt: now },
            $push: {
                messages: {
                    $each: [
                        { id: crypto.randomUUID(), role: 'user', content: String(message).slice(0, 2000), at: now },
                        { id: messageId, role: 'assistant', content: finalReply, cards, tools: toolExecutions, suggestions, at: now }
                    ],
                    $slice: -MAX_CHAT_MESSAGES
                }
            }
        },
        { upsert: true }
    ).catch(err => console.error('⚠️ Chat history not saved:', err.message));

    return {
        reply: finalReply,
        suggestions,
        navigate,
        actions,
        cards,
        toolExecutions,
        messageId
    };
}

module.exports = {
    trimHistory,
    visibleText,
    setModelClient,
    chatWithAgent,
    getChatHistory,
    clearChatHistory,
    rateMessage
};
