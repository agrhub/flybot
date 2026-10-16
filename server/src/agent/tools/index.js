const { cameraDeclarations, cameraExecutors } = require('./cameraTools');
const { analyticsDeclarations, analyticsExecutors } = require('./analyticsTools');
const { navigationDeclarations, navigationExecutors } = require('./navigationTools');
const { operationsDeclarations, operationsExecutors } = require('./operationsTools');
const { actionDeclarations, actionExecutors } = require('./actionTools');
const { insightDeclarations, insightExecutors } = require('./insightTools');
const { sentinelDeclarations, sentinelExecutors } = require('./sentinelTools');

const allFunctionDeclarations = [
    ...cameraDeclarations,
    ...analyticsDeclarations,
    ...operationsDeclarations,
    ...insightDeclarations,
    ...actionDeclarations,
    ...sentinelDeclarations,
    ...navigationDeclarations
];

const allExecutors = {
    ...cameraExecutors,
    ...analyticsExecutors,
    ...operationsExecutors,
    ...insightExecutors,
    ...actionExecutors,
    ...sentinelExecutors,
    ...navigationExecutors
};

module.exports = {
    allFunctionDeclarations,
    allExecutors
};
