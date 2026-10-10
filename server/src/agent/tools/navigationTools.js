const navigateUiDeclaration = {
    name: 'navigate_ui',
    description: 'Navigate user interface to the requested view in FlyBot Studio (Dashboard, Cameras, Analytics, Settings).',
    parameters: {
        type: 'OBJECT',
        properties: {
            tab: {
                type: 'STRING',
                description: 'Main tab name to open: "dashboard", "cameras", "analytics", or "settings"'
            },
            subTab: {
                type: 'STRING',
                description: 'Sub-tab if applicable: in analytics "trends" or "history"; in cameras "single" or "grid"'
            },
            deviceSerial: {
                type: 'STRING',
                description: 'Camera Serial Number to view detail (optional)'
            }
        },
        required: ['tab']
    }
};

async function executeNavigateUi({ tab, subTab, deviceSerial, addAction }) {
    const payload = { tab, subTab, deviceSerial };
    addAction('NAVIGATE', payload);
    return {
        success: true,
        action: 'NAVIGATE',
        target: payload,
        message: `Navigating interface to view "${tab}"${subTab ? ` (${subTab})` : ''}.`
    };
}

module.exports = {
    navigationDeclarations: [
        navigateUiDeclaration
    ],
    navigationExecutors: {
        navigate_ui: executeNavigateUi
    }
};
