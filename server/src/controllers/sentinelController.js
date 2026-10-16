const sentinelService = require('../services/sentinelService');
const { sendServerError } = require('../utils/http');

/**
 * FlyBot Sentinel internal API (HMAC-signed, routes/sentinelRoutes.js; API.md "Sentinel
 * internal API"). The work is in services/sentinelService.js.
 */
const handle = (run, context) => async (req, res) => {
    try {
        const { status, body } = await run(req);
        res.status(status).json(body);
    } catch (err) {
        sendServerError(res, err, { context: `Sentinel ${context}` });
    }
};

module.exports = {
    capture: handle((req) => sentinelService.capture(req.body, req), 'capture'),
    setCaptureInterval: handle((req) => sentinelService.setCaptureInterval(req.body, req), 'capture interval'),
    createProposal: handle((req) => sentinelService.createProposal(req.body, req), 'proposal'),
    getProposal: handle((req) => sentinelService.getProposal(req.params.id), 'proposal state'),
    requestReview: handle((req) => sentinelService.requestReview(req.body, req), 'review request'),
    storeAnalysis: handle((req) => sentinelService.storeAnalysis(req.body, req), 'analysis')
};
