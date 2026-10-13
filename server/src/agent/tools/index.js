const { cameraDeclarations, cameraExecutors } = require('./cameraTools');
const { analyticsDeclarations, analyticsExecutors } = require('./analyticsTools');
const { navigationDeclarations, navigationExecutors } = require('./navigationTools');
const { operationsDeclarations, operationsExecutors } = require('./operationsTools');
const { actionDeclarations, actionExecutors } = require('./actionTools');
const { insightDeclarations, insightExecutors } = require('./insightTools');

const allFunctionDeclarations = [
    ...cameraDeclarations,
    ...analyticsDeclarations,
    ...operationsDeclarations,
    ...insightDeclarations,
    ...actionDeclarations,
    ...navigationDeclarations
];

const allExecutors = {
    ...cameraExecutors,
    ...analyticsExecutors,
    ...operationsExecutors,
    ...insightExecutors,
    ...actionExecutors,
    ...navigationExecutors
};

module.exports = {
    allFunctionDeclarations,
    allExecutors
};
