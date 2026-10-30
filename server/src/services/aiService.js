const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
const { Snapshot } = require('../models');
const { pestCountOf } = require('../models/Snapshot');
const dailyStats = require('./dailyStats');
const { FRUIT_FLY, OTHER_INSECT, isFruitFly } = require('../constants/species');
const env = require('../config/env');
const {
    VERTEX_PROJECT_ID,
    VERTEX_LOCATION,
    VERTEX_MODEL,
    ROBOFLOW_API_KEY,
    ROBOFLOW_WORKFLOW_URL
} = env;

// Models AI_PROVIDER may list, in any order ('both' and 'sentinel' only stand alone)
const PROVIDERS = ['roboflow', 'opencv-lambda', 'claude', 'vertex'];

/**
 * The models to try on a photo, in order: "roboflow,opencv-lambda,claude,vertex" tries the
 * next one when one fails. Unknown names are dropped; nothing left means vertex.
 */
function providerChain(value = env.AI_PROVIDER) {
    const names = String(value || '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
    if (names.length === 1 && (names[0] === 'both' || names[0] === 'sentinel')) return names;
    const chain = [...new Set(names.filter(name => PROVIDERS.includes(name)))];
    return chain.length ? chain : ['vertex'];
}

/** AI_PROVIDER=sentinel: no cloud model at capture, FlyBot Sentinel sets the counts. */
const isSentinelMode = () => providerChain()[0] === 'sentinel';

// A model that refused the account (no credit left, a wrong key) is skipped this long, so the
// next ones in the chain count the photos without waiting on it first
const PROVIDER_COOLDOWN_MS = 30 * 60 * 1000;
const coolingUntil = new Map();

/** HTTP answers that mean the account cannot use the model now: no credit, a bad or missing key. */
function isAccountRefusal(status, message = '') {
    return status === 401 || status === 402 || status === 403 || (status === 400 && /credit balance/i.test(message));
}

function coolDown(provider, reason) {
    coolingUntil.set(provider, Date.now() + PROVIDER_COOLDOWN_MS);
    console.warn(`⏸️ AI provider ${provider} skipped for ${PROVIDER_COOLDOWN_MS / 60000} min: ${reason}`);
}

/** Tests: forget every cooldown. */
function resetCooldowns() {
    coolingUntil.clear();
}

const vertexAI = new GoogleGenAI({
    vertexai: true,
    project: VERTEX_PROJECT_ID,
    location: VERTEX_LOCATION
});

/** Width and height read from a PNG or JPEG header, or null when they cannot be read. */
function readImageSize(buffer) {
    try {
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
            return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
        }
        if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
            let offset = 2;
            while (offset < buffer.length - 8) {
                const marker = buffer.readUInt16BE(offset);
                offset += 2;
                if ((marker >= 0xFFC0 && marker <= 0xFFC3) || (marker >= 0xFFC5 && marker <= 0xFFC7) || (marker >= 0xFFC9 && marker <= 0xFFCB) || (marker >= 0xFFCD && marker <= 0xFFCF)) {
                    return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
                } else {
                    const len = buffer.readUInt16BE(offset);
                    offset += len;
                }
            }
        }
    } catch (e) {}
    return null;
}

/** Image size for box conversion; 1000x1000 when the header cannot be read. */
function getImageDimensions(buffer) {
    return readImageSize(buffer) || { width: 1000, height: 1000 };
}

/**
 * Detect and count insects using Google Vertex AI (Gemini)
 */
async function analyzeInsects(base64Image, snapshotId) {
    const imgBuffer = Buffer.from(base64Image, 'base64');
    const { width: imgWidth, height: imgHeight } = getImageDimensions(imgBuffer);

    const systemPrompt = `You are an agricultural expert specializing in insect and pest detection. Analyze the image and find objects: worms, beetles, fruit flies, moths, insects.

Return results in JSON format with structure:
{
    "detected": boolean,
    "insects": [
        {
            "name": string,
            "confidence": number,
            "box_2d": [ymin, xmin, ymax, xmax]
        }
    ],
    "summary": { "object_name": count },
    "description": string
}

MANDATORY COORDINATE RULES:
1. "box_2d" is an array of 4 integers [ymin, xmin, ymax, xmax] normalized between 0 and 1000:
   - ymin: top edge (0 - 1000)
   - xmin: left edge (0 - 1000)
   - ymax: bottom edge (0 - 1000)
   - xmax: right edge (0 - 1000)
2. Coordinate origin (0, 0) is at the top-left of the image.
3. Coordinates must tightly enclose each detected object.
4. "confidence" is a float from 0.0 to 1.0 (e.g. 0.95).`;

    let retries = 0;
    const delays = [1000, 2000, 4000, 8000, 16000];

    while (retries < 3) {
        try {
            const response = await vertexAI.models.generateContent({
                model: VERTEX_MODEL,
                contents: [
                    {
                        role: "user",
                        parts: [
                            { text: "Detect objects in the image and provide box_2d coordinates [ymin, xmin, ymax, xmax] (normalized 0-1000) for each object." },
                            {
                                inlineData: {
                                    mimeType: "image/jpeg",
                                    data: base64Image
                                }
                            }
                        ]
                    }
                ],
                config: {
                    systemInstruction: systemPrompt,
                    responseMimeType: "application/json",
                    httpOptions: { timeout: 60000 }
                }
            });

            const resultText = response.text;
            if (resultText) {
                const aiData = JSON.parse(resultText);

                const formattedInsects = (aiData.insects || []).map(item => {
                    let pixelBbox = [0, 0, 0, 0];
                    if (Array.isArray(item.box_2d) && item.box_2d.length === 4) {
                        const [ymin, xmin, ymax, xmax] = item.box_2d;
                        pixelBbox = [
                            Math.round((xmin / 1000) * imgWidth),
                            Math.round((ymin / 1000) * imgHeight),
                            Math.round((xmax / 1000) * imgWidth),
                            Math.round((ymax / 1000) * imgHeight)
                        ];
                    } else if (Array.isArray(item.bbox) && item.bbox.length === 4) {
                        const [b0, b1, b2, b3] = item.bbox;
                        if (b0 <= 1000 && b1 <= 1000 && b2 <= 1000 && b3 <= 1000 && (imgWidth !== 1000 || imgHeight !== 1000)) {
                            pixelBbox = [
                                Math.round((b1 / 1000) * imgWidth),
                                Math.round((b0 / 1000) * imgHeight),
                                Math.round((b3 / 1000) * imgWidth),
                                Math.round((b2 / 1000) * imgHeight)
                            ];
                        } else {
                            pixelBbox = item.bbox;
                        }
                    }

                    const conf = item.confidence > 1 ? Number((item.confidence / 100).toFixed(2)) : Number(item.confidence || 0.95);

                    return {
                        name: item.name,
                        confidence: conf,
                        bbox: pixelBbox
                    };
                });

                const vertexSnap = await Snapshot.findByIdAndUpdate(snapshotId, {
                    aiProcessed: true,
                    aiProvider: 'vertex',
                    pestCount: pestCountOf(aiData.summary || {}),
                    // Field by field, so a Sentinel analysis stored beside it (aiResults.sentinel) stays
                    'aiResults.detected': aiData.detected,
                    'aiResults.insects': formattedInsects,
                    'aiResults.summary': aiData.summary || {},
                    'aiResults.raw_description': aiData.description
                });
                await dailyStats.refreshForSnapshot(vertexSnap);
                console.log(`🤖 Vertex AI (${VERTEX_MODEL}) processed snapshot ${snapshotId}: ${aiData.detected ? 'Found ' + formattedInsects.length + ' objects' : 'No insects detected'} (image: ${imgWidth}x${imgHeight})`);
                return;
            }
        } catch (error) {
            retries++;
            if (isAccountRefusal(error.status, error.message)) {
                console.error(`❌ Vertex AI refused snapshot ${snapshotId} (${error.status}):`, error.message);
                coolDown('vertex', `HTTP ${error.status}`);
                return;
            }
            if (retries === 3) {
                console.error(`❌ Vertex AI Error after 3 attempts for ${snapshotId}:`, error.message);
            } else {
                await new Promise(res => setTimeout(res, delays[retries - 1]));
            }
        }
    }
}

/**
 * Detect and count insects using Roboflow Workflow
 */
async function analyzeInsectsRoboflow(base64Image, snapshotId, imageUrl = null) {
    let retries = 0;
    const delays = [1000, 2000, 4000];

    while (retries < 3) {
        try {
            const imageInput = imageUrl && imageUrl.startsWith('http')
                ? { type: "url", value: imageUrl }
                : { type: "base64", value: base64Image };

            const response = await axios.post(ROBOFLOW_WORKFLOW_URL, {
                inputs: {
                    image: imageInput
                }
            }, {
                timeout: 60000,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${ROBOFLOW_API_KEY}`
                }
            });

            const out = response.data?.outputs?.[0];
            if (out) {
                const predictions = out.predictions?.predictions || [];
                const count = typeof out.count === 'number' ? out.count : predictions.length;

                const formattedInsects = predictions.map(pred => {
                    const xmin = Math.round(pred.x - pred.width / 2);
                    const ymin = Math.round(pred.y - pred.height / 2);
                    const xmax = Math.round(pred.x + pred.width / 2);
                    const ymax = Math.round(pred.y + pred.height / 2);

                    // The workflow is trained on fruit flies; keep any other class name it reports
                    const name = (!pred.class || isFruitFly(pred.class)) ? FRUIT_FLY : pred.class;

                    return {
                        name: name,
                        confidence: Number((pred.confidence || 0.99).toFixed(2)),
                        bbox: [xmin, ymin, xmax, ymax]
                    };
                });

                const summary = { [FRUIT_FLY]: count };
                const desc = `Roboflow detected ${count} insect(s).`;

                const roboflowSnap = await Snapshot.findByIdAndUpdate(snapshotId, {
                    aiProcessed: true,
                    aiProvider: 'roboflow',
                    pestCount: pestCountOf(summary),
                    'aiResults.detected': count > 0,
                    'aiResults.insects': formattedInsects,
                    'aiResults.summary': summary,
                    'aiResults.raw_description': desc
                });

                await dailyStats.refreshForSnapshot(roboflowSnap);
                console.log(`🤖 Roboflow Workflow processed snapshot ${snapshotId}: ${count > 0 ? 'Found ' + count + ' objects' : 'No insects detected'}`);
                return;
            }
        } catch (error) {
            retries++;
            // A refused request (bad key, bad input) fails the same way again: only retry the rest
            const status = error.response?.status;
            if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
                console.error(`❌ Roboflow refused snapshot ${snapshotId} (${status}):`, error.message);
                if (isAccountRefusal(status)) coolDown('roboflow', `HTTP ${status}`);
                return;
            }
            if (retries === 3) {
                console.error(`❌ Roboflow Error after 3 attempts for ${snapshotId}:`, error.message);
            } else {
                await new Promise(res => setTimeout(res, delays[retries - 1]));
            }
        }
    }
}

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

// The answer Claude must give (structured output): boxes normalized 0-1000, like Vertex's
const CLAUDE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['insects', 'description'],
    properties: {
        insects: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'confidence', 'box_2d'],
                properties: {
                    name: { type: 'string', enum: [FRUIT_FLY, OTHER_INSECT] },
                    confidence: { type: 'number' },
                    box_2d: { type: 'array', items: { type: 'integer' } }
                }
            }
        },
        description: { type: 'string' }
    }
};

const CLAUDE_SYSTEM = `You count insects on photos from fruit-fly trap cameras (a lure trap seen from above, or a yellow sticky card).
List every insect you can see, one entry each:
- name "${FRUIT_FLY}" for a fruit fly (Bactrocera and similar tephritid flies: about 6-8 mm, often yellow or brown markings, banded or clear wings);
- name "${OTHER_INSECT}" for any other insect (bees, ants, moths, small black flies, beetles).
Do not list dirt, drops, lure, leaves, shadows or reflections. An empty list is a valid answer.
box_2d is [ymin, xmin, ymax, xmax], integers from 0 to 1000 relative to the image, origin at the top-left, tight around the insect.
confidence is from 0.0 to 1.0. description is one short sentence on what the photo shows.`;

/**
 * Detect and count insects with Claude (Anthropic Messages API, structured output).
 */
async function analyzeInsectsClaude(base64Image, snapshotId) {
    if (!env.ANTHROPIC_API_KEY) {
        coolDown('claude', 'ANTHROPIC_API_KEY is not set');
        return;
    }
    const imgBuffer = Buffer.from(base64Image, 'base64');
    const { width: imgWidth, height: imgHeight } = getImageDimensions(imgBuffer);
    const mediaType = imgBuffer[0] === 0x89 && imgBuffer[1] === 0x50 ? 'image/png' : 'image/jpeg';
    const delays = [1000, 2000, 4000];

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await axios.post(CLAUDE_API_URL, {
                model: env.CLAUDE_VISION_MODEL,
                max_tokens: 16000,
                system: CLAUDE_SYSTEM,
                output_config: { format: { type: 'json_schema', schema: CLAUDE_SCHEMA } },
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
                        { type: 'text', text: 'Find and box every insect on this trap photo.' }
                    ]
                }]
            }, {
                timeout: 120000,
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': env.ANTHROPIC_API_KEY,
                    'anthropic-version': '2026-10-21'
                }
            });

            const message = response.data || {};
            if (message.stop_reason !== 'end_turn') {
                console.error(`❌ Claude did not answer snapshot ${snapshotId} (stop_reason ${message.stop_reason})`);
                return;
            }
            const text = (message.content || []).find(block => block.type === 'text')?.text;
            const aiData = JSON.parse(text || '{}');
            const insects = (Array.isArray(aiData.insects) ? aiData.insects : [])
                .filter(item => Array.isArray(item.box_2d) && item.box_2d.length === 4)
                .map(item => {
                    const [ymin, xmin, ymax, xmax] = item.box_2d;
                    return {
                        name: item.name === OTHER_INSECT ? OTHER_INSECT : FRUIT_FLY,
                        confidence: Number(Math.min(Math.max(Number(item.confidence) || 0, 0), 1).toFixed(2)),
                        bbox: [
                            Math.round((xmin / 1000) * imgWidth),
                            Math.round((ymin / 1000) * imgHeight),
                            Math.round((xmax / 1000) * imgWidth),
                            Math.round((ymax / 1000) * imgHeight)
                        ]
                    };
                });
            const summary = {};
            for (const insect of insects) summary[insect.name] = (summary[insect.name] || 0) + 1;
            const count = pestCountOf(summary);

            const claudeSnap = await Snapshot.findByIdAndUpdate(snapshotId, {
                aiProcessed: true,
                aiProvider: 'claude',
                pestCount: count,
                'aiResults.detected': insects.length > 0,
                'aiResults.insects': insects,
                'aiResults.summary': summary,
                'aiResults.raw_description': aiData.description || `Claude counted ${count} fruit fly(s).`
            });
            await dailyStats.refreshForSnapshot(claudeSnap);
            console.log(`🤖 Claude (${env.CLAUDE_VISION_MODEL}) processed snapshot ${snapshotId}: ${count} fruit fly(s), ${insects.length} insect(s) (image: ${imgWidth}x${imgHeight})`);
            return;
        } catch (error) {
            const status = error.response?.status;
            const detail = error.response?.data?.error?.message || error.message;
            if (isAccountRefusal(status, detail)) {
                console.error(`❌ Claude refused snapshot ${snapshotId} (${status}):`, detail);
                coolDown('claude', `HTTP ${status}`);
                return;
            }
            // Other refusals (a bad request) fail the same way again; 408, 429, 5xx and network errors are retried
            if ((status >= 400 && status < 500 && status !== 408 && status !== 429) || attempt === 3) {
                console.error(`❌ Claude Error for ${snapshotId} (attempt ${attempt}${status ? `, ${status}` : ''}):`, detail);
                return;
            }
            await new Promise(res => setTimeout(res, delays[attempt - 1]));
        }
    }
}

const isAnalyzed = async (snapshotId) => !!(await Snapshot.exists({ _id: snapshotId, aiProcessed: true }));

/** One model of the chain on one photo; true when the photo now has its result. */
async function runProvider(provider, { base64Image, snapshotId, imageUrl, buffer }) {
    if (provider === 'opencv-lambda') {
        // The vision Lambda reads the photo from storage (by reference); the buffer only gives its size
        const result = await require('./visionLambda').analyzeSnapshot(snapshotId, { buffer: buffer || (base64Image ? Buffer.from(base64Image, 'base64') : null) });
        if (!result.ok && result.error?.code === 'not_configured') coolDown('opencv-lambda', result.error.message);
        return result.ok;
    }
    if (provider === 'roboflow') await analyzeInsectsRoboflow(base64Image, snapshotId, imageUrl);
    else if (provider === 'claude') await analyzeInsectsClaude(base64Image, snapshotId);
    else await analyzeInsects(base64Image, snapshotId);
    return isAnalyzed(snapshotId);
}

/**
 * Analyze a stored snapshot with the configured provider(s): each model of the chain in turn
 * until one counts the photo, skipping a model that refused the account a short while ago
 * (all of them are tried when every one is skipped). `imageUrl`: a link Roboflow can fetch the
 * image from (the camera's fresh picture link); without it the image is sent inline.
 * Returns true when the snapshot now has an AI result.
 */
async function analyzeSnapshot(base64Image, snapshotId, imageUrl = null, { buffer = null } = {}) {
    const chain = providerChain();
    // Sentinel analyzes the photo itself (POST /api/sentinel/analysis)
    if (chain[0] === 'sentinel') return false;
    if (chain[0] === 'both') {
        await analyzeInsects(base64Image, snapshotId);
        await analyzeInsectsRoboflow(base64Image, snapshotId, imageUrl);
        return isAnalyzed(snapshotId);
    }
    const now = Date.now();
    const ready = chain.filter(provider => !(coolingUntil.get(provider) > now));
    const order = ready.length ? ready : chain;
    for (const [index, provider] of order.entries()) {
        if (index > 0) console.warn(`↪️ Snapshot ${snapshotId}: ${order[index - 1]} failed, trying ${provider}`);
        if (await runProvider(provider, { base64Image, snapshotId, imageUrl, buffer })) return true;
    }
    return false;
}

/**
 * Look at one trap photo and answer a question about it (the assistant's inspect_photo tool).
 * `context` is what the detection already found, so the answer can agree or point out a miss.
 * Returns the answer text.
 */
async function describePhoto(imageBuffer, question, { context = '', language = 'en' } = {}) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30000);
    try {
        const response = await vertexAI.models.generateContent({
            model: VERTEX_MODEL || 'gemini-2.5-flash',
            contents: [{
                role: 'user',
                parts: [
                    { inlineData: { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') } },
                    { text: `${context ? `What the automatic detection found: ${context}\n` : ''}Question: ${question}` }
                ]
            }],
            config: {
                systemInstruction: `You look at a photo from an insect trap camera (a yellow sticky card or a lure trap) for a farm manager. Describe only what you can see: insects and their likely kind, how crowded the card is, dirt, glare, blur, a lens or card problem. Say plainly when something cannot be told from the photo. Answer in ${language === 'vi' ? 'Vietnamese' : 'English'}, in at most 6 short sentences.`,
                abortSignal: abort.signal
            }
        });
        return (response.text || '').trim();
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    providerChain,
    isSentinelMode,
    resetCooldowns,
    describePhoto,
    readImageSize,
    getImageDimensions,
    analyzeInsects,
    analyzeInsectsRoboflow,
    analyzeInsectsClaude,
    analyzeSnapshot
};
