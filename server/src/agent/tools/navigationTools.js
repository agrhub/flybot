// Pages the assistant can open, and the sub-tabs each one takes
const PAGES = {
    dashboard: [],
    cameras: [],
    reports: [],
    analytics: ['trends', 'insights', 'history'],
    farms: [],
    logbook: [],
    map: [],
    settings: ['profile', 'cameras', 'notifications', 'organizations', 'integrations', 'preferences', 'storage']
};

const navigateUiDeclaration = {
    name: 'navigate_ui',
    description: 'Open a page of the FlyBot app: dashboard (overview), cameras (live view, playback, one camera\'s history), reports, analytics (trends, insights = in-depth analysis, history = every analyzed photo), farms (farms and plots), logbook (treatments and their effect), map, settings.',
    parameters: {
        type: 'OBJECT',
        properties: {
            tab: {
                type: 'STRING',
                enum: Object.keys(PAGES),
                description: 'Page to open'
            },
            subTab: {
                type: 'STRING',
                description: 'analytics: "trends", "insights" or "history"; settings: "profile", "cameras", "notifications", "organizations", "integrations", "preferences" or "storage"'
            },
            deviceSerial: {
                type: 'STRING',
                description: 'Camera Serial Number to select on the cameras or analytics page (optional)'
            }
        },
        required: ['tab']
    }
};

async function executeNavigateUi({ tab, subTab, deviceSerial, addAction }) {
    if (!Object.hasOwn(PAGES, tab)) {
        return { error: `Unknown page "${tab}". Pages: ${Object.keys(PAGES).join(', ')}.` };
    }
    const payload = { tab };
    if (subTab && PAGES[tab].includes(subTab)) payload.subTab = subTab;
    if (deviceSerial && ['cameras', 'analytics'].includes(tab)) payload.deviceSerial = String(deviceSerial).slice(0, 64);
    addAction('NAVIGATE', payload);
    return {
        success: true,
        action: 'NAVIGATE',
        target: payload,
        message: `Opening "${tab}"${payload.subTab ? ` (${payload.subTab})` : ''}.`
    };
}

module.exports = {
    PAGES,
    navigationDeclarations: [
        navigateUiDeclaration
    ],
    navigationExecutors: {
        navigate_ui: executeNavigateUi
    }
};
