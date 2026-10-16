const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
const { Snapshot } = require('../models');
const { pestCountOf } = require('../models/Snapshot');
const dailyStats = require('./dailyStats');
const { FRUIT_FLY, isFruitFly } = require('../constants/species');
const env = require('../config/env');
const {
    VERTEX_PROJECT_ID,
    VERTEX_LOCATION,
    VERTEX_MODEL,
    ROBOFLOW_API_KEY,
    ROBOFLOW_WORKFLOW_URL
} = env;

/** AI_PROVIDER=sentinel: no cloud model at capture, FlyBot Sentinel sets the counts. */
const isSentinelMode = () => env.AI_PROVIDER === 'sentinel';

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

/**
 * Analyze a stored snapshot with the configured provider(s). `imageUrl`: a link Roboflow can
 * fetch the image from (the camera's fresh picture link); without it the image is sent inline.
 * Returns true when the snapshot now has an AI result.
 */
async function analyzeSnapshot(base64Image, snapshotId, imageUrl = null) {
    const provider = env.AI_PROVIDER;
    // Sentinel analyzes the photo itself (POST /api/sentinel/analysis)
    if (provider === 'sentinel') return false;
    if (provider === 'roboflow') {
        await analyzeInsectsRoboflow(base64Image, snapshotId, imageUrl);
    } else if (provider === 'both') {
        await analyzeInsects(base64Image, snapshotId);
        await analyzeInsectsRoboflow(base64Image, snapshotId, imageUrl);
    } else {
        await analyzeInsects(base64Image, snapshotId);
    }
    return !!(await Snapshot.exists({ _id: snapshotId, aiProcessed: true }));
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
    isSentinelMode,
    describePhoto,
    readImageSize,
    getImageDimensions,
    analyzeInsects,
    analyzeInsectsRoboflow,
    analyzeSnapshot
};
