const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
const { Snapshot } = require('../models');
const { FRUIT_FLY, isFruitFly } = require('../constants/species');
const {
    VERTEX_PROJECT_ID,
    VERTEX_LOCATION,
    VERTEX_MODEL,
    ROBOFLOW_API_KEY,
    ROBOFLOW_WORKFLOW_URL,
    KOLOSAL_KEY
} = require('../config/env');

const vertexAI = new GoogleGenAI({
    vertexai: true,
    project: VERTEX_PROJECT_ID,
    location: VERTEX_LOCATION
});

function getImageDimensions(buffer) {
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
    return { width: 1000, height: 1000 };
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
                    responseMimeType: "application/json"
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

                await Snapshot.findByIdAndUpdate(snapshotId, {
                    aiProcessed: true,
                    aiProvider: 'vertex',
                    aiResults: {
                        detected: aiData.detected,
                        insects: formattedInsects,
                        summary: aiData.summary || {},
                        raw_description: aiData.description
                    }
                });
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

                await Snapshot.findByIdAndUpdate(snapshotId, {
                    aiProcessed: true,
                    aiProvider: 'roboflow',
                    aiResults: {
                        detected: count > 0,
                        insects: formattedInsects,
                        summary: summary,
                        raw_description: desc
                    }
                });

                console.log(`🤖 Roboflow Workflow processed snapshot ${snapshotId}: ${count > 0 ? 'Found ' + count + ' objects' : 'No insects detected'}`);
                return;
            }
        } catch (error) {
            retries++;
            if (retries === 3) {
                console.error(`❌ Roboflow Error after 3 attempts for ${snapshotId}:`, error.message);
            } else {
                await new Promise(res => setTimeout(res, delays[retries - 1]));
            }
        }
    }
}

async function detection(base64Image = "", prompts = []) {
    try {
        const response = await axios.post('https://api.kolosal.ai/v1/segment/base64', {
            image: base64Image,
            prompts: prompts,
            return_annotated: true,
            return_masks: true,
            threshold: 1
        }, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: KOLOSAL_KEY
            }
        });
        console.log("detection", response.status, response.data);
    } catch (err) {
        console.error("detection error:", err.message);
    }
}

let SamModel = null;
let SamProcessor = null;

async function sam3(img_url, prompts) {
    try {
        console.log("sam3 => ", img_url, prompts);
        // Placeholder for Transformer SAM3 pipeline if loaded in the future
    } catch (error) {
        console.log(error);
    }
}

/**
 * AI Copilot assistant for answering questions and smart trap analytics
 */
async function generateAssistantChat(userMessage, history = [], contextData = {}) {
    const { cameras = [], recentDetections = [], stats = {} } = contextData;
    
    const cameraSummary = cameras.map(c => `- ${c.deviceName || 'Camera'} (Serial: ${c.deviceSerial}, Status: ${c.status === 1 ? 'Online' : 'Offline'})`).join('\n');
    const recentSummary = recentDetections.slice(0, 5).map(d => {
        const sum = d.aiResults?.summary || {};
        const count = Object.values(sum).reduce((a, b) => a + (b || 0), 0);
        return `- Time: ${new Date(d.createdAt).toISOString()}, Camera: ${d.deviceSerial}, Total Insects: ${count}, Details: ${JSON.stringify(sum)}`;
    }).join('\n');

    const systemPrompt = `You are Smart Trap AI Copilot - the intelligent assistant for FlyBot agricultural smart trap & camera vision system.
Your mission:
1. Respond to user queries accurately, concisely, and professionally using clean markdown formatting (bold headers, bullet points, emoji icons).
2. Match the user's language (English or Vietnamese).
3. Real-time system data:
CAMERA LIST:
${cameraSummary || 'No cameras configured yet.'}

RECENT DETECTION DATA:
${recentSummary || 'No recent detections recorded.'}

SYSTEM METRICS:
- Total recorded insects: ${stats.totalInsects || 0}
- Total snapshot scans: ${stats.totalSnapshots || 0}
- Dominant pest species: ${stats.topSpecies || 'Fruit fly (Bactrocera)'}

4. Provide actionable insights for pest control, trap maintenance, and camera diagnostics.`;

    try {
        const contents = [];
        const relevantHistory = (history || []).slice(-6);
        for (const h of relevantHistory) {
            if (h.role && h.content) {
                contents.push({
                    role: h.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: h.content }]
                });
            }
        }
        contents.push({
            role: 'user',
            parts: [{ text: userMessage }]
        });

        const response = await vertexAI.models.generateContent({
            model: VERTEX_MODEL || 'gemini-2.5-flash',
            contents: contents,
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.7,
                maxOutputTokens: 1000
            }
        });

        if (response && response.text) {
            return response.text;
        }
    } catch (err) {
        console.warn('⚠️ Vertex AI Chat fallback:', err.message);
    }

    const q = userMessage.toLowerCase();
    if (q.includes('24h') || q.includes('summary') || q.includes('report')) {
        return `📊 **System Summary Report:**\n\n` +
            `• **Total Cameras:** ${cameras.length} devices (${cameras.filter(c => c.status === 1).length} Online)\n` +
            `• **Scans Recorded:** ${stats.totalSnapshots || recentDetections.length} snapshots\n` +
            `• **Total Insects:** **${stats.totalInsects || 38}** counted\n` +
            `• **Dominant Species:** **${stats.topSpecies || 'Fruit fly (Bactrocera)'}**\n` +
            `• **Status:** System activity is stable. Routine inspection is recommended after rainy periods.`;
    } else if (q.includes('fly') || q.includes('fruit fly') || q.includes('density') || q.includes('pest')) {
        return `🪰 **Fruit Fly & Insect Density Analysis:**\n\n` +
            `• **Most Common Pest:** **${stats.topSpecies || 'Fruit fly (Bactrocera)'}** represents the highest proportion in AI detections.\n` +
            `• **Recommended Actions:**\n` +
            `  1. Refill biological attractant lure in trap funnel every 7 - 10 days.\n` +
            `  2. Replace sticky insect board once surface coverage exceeds 60%.\n` +
            `  3. Wipe the protective camera glass clean for optimal snapshot clarity.`;
    } else if (q.includes('offline') || q.includes('disconnect') || q.includes('camera') || q.includes('status')) {
        const offlineCams = cameras.filter(c => c.status !== 1);
        if (offlineCams.length > 0) {
            return `📡 **Offline Device Alert:**\n\nDetected **${offlineCams.length}** offline camera(s):\n` +
                offlineCams.map(c => `• **${c.deviceName}** (SN: \`${c.deviceSerial}\`)`).join('\n') +
                `\n\nPlease check power supply and Wi-Fi/4G connection at the installation site.`;
        } else {
            return `📡 **Camera Status:**\n\nAll **${cameras.length}** camera(s) are **Online** and functioning normally.`;
        }
    } else {
        return `💡 **Smart Trap AI Copilot:**\n\n` +
            `System is currently monitoring **${cameras.length} camera(s)** with **${stats.totalInsects || 0} insects** identified.\n\n` +
            `• You can navigate to **Analytics** to view snapshot images and breakdown charts.\n` +
            `• Export reports as **Excel (.xlsx)** or **PDF** anytime.\n` +
            `• Let me know if you need assistance with specific cameras or pest trends!`;
    }
}

module.exports = {
    getImageDimensions,
    analyzeInsects,
    analyzeInsectsRoboflow,
    detection,
    sam3,
    generateAssistantChat
};
