const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const jpeg = require('jpeg-js');
const { models, startDb, stopDb, clearDb } = require('./dbHelpers');
const env = require('../src/config/env');
const aiService = require('../src/services/aiService');
const visionLambda = require('../src/services/visionLambda');

before(startDb);
after(stopDb);
beforeEach(clearDb);

function testJpeg(width = 64, height = 48) {
    const data = Buffer.alloc(width * height * 4, 120);
    return jpeg.encode({ data, width, height }, 90).data;
}

const original = {
    post: axios.post,
    lambda: visionLambda.analyzeSnapshot,
    provider: env.AI_PROVIDER,
    anthropicKey: env.ANTHROPIC_API_KEY
};
let calls;
let answers; // { roboflow, claude }: (body) => response, or throws

beforeEach(() => {
    calls = [];
    aiService.resetCooldowns();
    env.ANTHROPIC_API_KEY = 'test-key';
    axios.post = async (url, body, config) => {
        const provider = url.includes('anthropic.com') ? 'claude' : 'roboflow';
        calls.push({ provider, url, body, headers: config.headers });
        return answers[provider](body);
    };
    visionLambda.analyzeSnapshot = async () => {
        calls.push({ provider: 'opencv-lambda' });
        return answers.lambda();
    };
});
afterEach(() => {
    axios.post = original.post;
    visionLambda.analyzeSnapshot = original.lambda;
    env.AI_PROVIDER = original.provider;
    env.ANTHROPIC_API_KEY = original.anthropicKey;
    aiService.resetCooldowns();
});

function httpError(status, message) {
    const err = new Error(`Request failed with status code ${status}`);
    err.response = { status, data: { error: { message } } };
    return err;
}

const claudeAnswer = (insects) => ({
    data: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ insects, description: 'A lure trap seen from above.' }) }]
    }
});

async function newSnapshot() {
    return models.Snapshot.create({ deviceSerial: 'CAM1', imageUrl: 'https://example.com/a.jpg', s3Key: 'snapshots/CAM1/a.jpg' });
}

async function analyze(snapshot) {
    const buffer = Buffer.from(testJpeg());
    return aiService.analyzeSnapshot(buffer.toString('base64'), snapshot._id, null, { buffer });
}

test('providerChain: the models AI_PROVIDER lists, in order', () => {
    assert.deepEqual(aiService.providerChain('roboflow, opencv-lambda,Claude,vertex'), ['roboflow', 'opencv-lambda', 'claude', 'vertex']);
    assert.deepEqual(aiService.providerChain('roboflow,roboflow,claude'), ['roboflow', 'claude']);
    assert.deepEqual(aiService.providerChain('both'), ['both']);
    assert.deepEqual(aiService.providerChain('sentinel'), ['sentinel']);
    // 'sentinel' and 'both' only stand alone; unknown names are dropped
    assert.deepEqual(aiService.providerChain('sentinel,claude'), ['claude']);
    assert.deepEqual(aiService.providerChain('nonsense'), ['vertex']);
    assert.deepEqual(aiService.providerChain(''), ['vertex']);
});

test('Roboflow out of credit and the Lambda failing: Claude counts the photo, and Roboflow is skipped for a while', async () => {
    env.AI_PROVIDER = 'roboflow,opencv-lambda,claude,vertex';
    answers = {
        roboflow: () => { throw httpError(402, 'credit_cap_exceeded'); },
        lambda: () => ({ ok: false, error: { code: 'unreachable', message: 'timeout' } }),
        claude: () => claudeAnswer([
            { name: 'fruit_fly', confidence: 0.9, box_2d: [100, 200, 150, 260] },
            { name: 'fruit_fly', confidence: 0.8, box_2d: [500, 500, 540, 560] },
            { name: 'other_insect', confidence: 0.7, box_2d: [700, 100, 760, 160] }
        ])
    };

    const first = await newSnapshot();
    assert.equal(await analyze(first), true);
    assert.deepEqual(calls.map(c => c.provider), ['roboflow', 'opencv-lambda', 'claude']);

    const stored = await models.Snapshot.findById(first._id).lean();
    assert.equal(stored.aiProcessed, true);
    assert.equal(stored.aiProvider, 'claude');
    // Other insects are listed but never counted as pests
    assert.equal(stored.pestCount, 2);
    assert.deepEqual(stored.aiResults.summary, { fruit_fly: 2, other_insect: 1 });
    // Boxes in pixels of the 64 x 48 photo: [xmin, ymin, xmax, ymax]
    assert.deepEqual(stored.aiResults.insects[0].bbox, [13, 5, 17, 7]);

    const request = calls.find(c => c.provider === 'claude');
    assert.equal(request.body.model, env.CLAUDE_VISION_MODEL);
    assert.equal(request.body.output_config.format.type, 'json_schema');
    assert.equal(request.body.messages[0].content[0].type, 'image');
    assert.equal(request.body.messages[0].content[0].source.media_type, 'image/jpeg');
    assert.equal(request.headers['x-api-key'], 'test-key');

    // The next photo does not wait on Roboflow: it starts with the Lambda
    calls = [];
    assert.equal(await analyze(await newSnapshot()), true);
    assert.deepEqual(calls.map(c => c.provider), ['opencv-lambda', 'claude']);
});

test('the first model that counts ends the chain', async () => {
    env.AI_PROVIDER = 'roboflow,claude';
    answers = {
        roboflow: () => ({ data: { outputs: [{ count: 1, predictions: { predictions: [{ x: 10, y: 10, width: 4, height: 4, confidence: 0.9, class: 'fruit_fly' }] } }] } }),
        claude: () => { throw new Error('must not be called'); }
    };
    const snap = await newSnapshot();
    assert.equal(await analyze(snap), true);
    assert.deepEqual(calls.map(c => c.provider), ['roboflow']);
    assert.equal((await models.Snapshot.findById(snap._id).lean()).aiProvider, 'roboflow');
});

test('Claude without credit is skipped next time; when every model is skipped, all are tried again', async () => {
    env.AI_PROVIDER = 'claude,roboflow';
    answers = {
        claude: () => { throw httpError(400, 'Your credit balance is too low to access the Anthropic API.'); },
        roboflow: () => { throw httpError(402, 'credit_cap_exceeded'); }
    };
    assert.equal(await analyze(await newSnapshot()), false);
    assert.deepEqual(calls.map(c => c.provider), ['claude', 'roboflow']);

    // Both are cooling down: the photo still gets a try with each instead of none
    calls = [];
    assert.equal(await analyze(await newSnapshot()), false);
    assert.deepEqual(calls.map(c => c.provider), ['claude', 'roboflow']);
});

test('a single model is always tried, also after it ran out of credit', async () => {
    env.AI_PROVIDER = 'roboflow';
    answers = { roboflow: () => { throw httpError(402, 'credit_cap_exceeded'); } };
    assert.equal(await analyze(await newSnapshot()), false);
    assert.equal(await analyze(await newSnapshot()), false);
    assert.deepEqual(calls.map(c => c.provider), ['roboflow', 'roboflow']);
});

test('Claude without ANTHROPIC_API_KEY is passed over', async () => {
    env.AI_PROVIDER = 'claude,roboflow';
    env.ANTHROPIC_API_KEY = '';
    answers = { roboflow: () => ({ data: { outputs: [{ count: 0, predictions: { predictions: [] } }] } }) };
    assert.equal(await analyze(await newSnapshot()), true);
    assert.deepEqual(calls.map(c => c.provider), ['roboflow']);
});
